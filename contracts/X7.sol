// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

interface IBalancerVault {
    function flashLoan(address, address[] calldata, uint256[] calldata, bytes calldata) external;
}

interface IAavePool {
    function flashLoanSimple(address, address, uint256, bytes calldata, uint16) external;
}

interface IRouter {
    struct ExactInputSingleParams {
        address tokenIn; address tokenOut; uint24 fee;
        address recipient; uint256 amountIn;
        uint256 amountOutMinimum; uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata) external returns (uint256);
}

contract X7 {
    address public immutable owner;
    address public immutable router;
    address public immutable usdc;
    address public immutable balancerVault;
    address public immutable aavePool;
    uint256 public totalProfit;
    uint256 public totalExecutions;

    event Executed(string indexed sv, uint256 profit);

    modifier onlyOwner() { require(msg.sender == owner, "X7:auth"); _; }

    constructor(address _router, address _usdc, address _balancer, address _aave) {
        owner        = msg.sender;
        router       = _router;
        usdc         = _usdc;
        balancerVault = _balancer;
        aavePool     = _aave;
    }

    // ── ZERO-SEED BOOTSTRAP ──────────────────────────────────────────────────
    // Called as tx[1] in CREATE2 bootstrap bundle.
    // Flash loan provides capital. Profit pays builder. Executor wallet = $0.
    function bootstrapExecute(
        address tokenIn, address tokenOut,
        uint256 flashAmount, uint24 buyFee, uint24 sellFee,
        uint256 builderTipBps
    ) external {
        bytes memory data = abi.encode(tokenOut, buyFee, sellFee, builderTipBps);
        if (balancerVault != address(0)) {
            address[] memory tokens = new address[](1);
            uint256[] memory amounts = new uint256[](1);
            tokens[0] = tokenIn;
            // Use pure BigInt math: 100000 * 10^18 not float conversion
            amounts[0] = flashAmount;
            IBalancerVault(balancerVault).flashLoan(address(this), tokens, amounts, data);
        } else {
            IAavePool(aavePool).flashLoanSimple(address(this), tokenIn, flashAmount, data, 0);
        }
    }

    // ── BALANCER CALLBACK ────────────────────────────────────────────────────
    function receiveFlashLoan(
        address[] calldata tokens, uint256[] calldata amounts,
        uint256[] calldata fees, bytes calldata userData
    ) external {
        require(msg.sender == balancerVault, "X7:vault");
        (address tokenOut, uint24 buyFee, uint24 sellFee, uint256 tipBps) =
            abi.decode(userData, (address, uint24, uint24, uint256));

        uint256 before = IERC20(usdc).balanceOf(address(this));
        _arb(tokens[0], tokenOut, amounts[0], buyFee, sellFee);
        uint256 profit = IERC20(usdc).balanceOf(address(this)) - before;

        IERC20(tokens[0]).transfer(balancerVault, amounts[0] + fees[0]);
        _payBuilder(profit, tipBps);

        totalProfit     += profit;
        totalExecutions += 1;
        emit Executed("bootstrap", profit);
    }

    // ── AAVE CALLBACK ────────────────────────────────────────────────────────
    function executeOperation(
        address asset, uint256 amount, uint256 premium,
        address, bytes calldata params
    ) external returns (bool) {
        require(msg.sender == aavePool, "X7:aave");
        (address tokenOut, uint24 buyFee, uint24 sellFee, uint256 tipBps) =
            abi.decode(params, (address, uint24, uint24, uint256));

        uint256 before = IERC20(usdc).balanceOf(address(this));
        _arb(asset, tokenOut, amount, buyFee, sellFee);
        uint256 profit = IERC20(usdc).balanceOf(address(this)) - before;

        IERC20(asset).approve(aavePool, amount + premium);
        _payBuilder(profit, tipBps);

        totalProfit     += profit;
        totalExecutions += 1;
        return true;
    }

    // ── CORE ARB ─────────────────────────────────────────────────────────────
    function _arb(
        address tokenIn, address tokenOut,
        uint256 amountIn, uint24 buyFee, uint24 sellFee
    ) internal returns (uint256 profit) {
        uint256 before = IERC20(tokenOut).balanceOf(address(this));

        IERC20(tokenIn).approve(router, amountIn);
        uint256 received = IRouter(router).exactInputSingle(
            IRouter.ExactInputSingleParams({
                tokenIn: tokenIn, tokenOut: tokenOut, fee: buyFee,
                recipient: address(this), amountIn: amountIn,
                amountOutMinimum: 0, sqrtPriceLimitX96: 0
            })
        );

        IERC20(tokenOut).approve(router, received);
        uint256 back = IRouter(router).exactInputSingle(
            IRouter.ExactInputSingleParams({
                tokenIn: tokenOut, tokenOut: tokenIn, fee: sellFee,
                recipient: address(this), amountIn: received,
                amountOutMinimum: amountIn, sqrtPriceLimitX96: 0
            })
        );

        profit = back > amountIn ? back - amountIn : 0;
    }

    // ── PAY BUILDER FROM PROFIT (Ethereum mainnet) ───────────────────────────
    function _payBuilder(uint256 profit, uint256 tipBps) internal {
        if (profit == 0 || tipBps == 0) return;
        if (block.chainid != 1 && block.chainid != 42161) return;
        // Builder tip transferred via coinbase — gas-free inclusion
        uint256 tip = (profit * tipBps) / 10000;
        if (tip > 0 && address(this).balance >= tip) {
            payable(block.coinbase).transfer(tip);
        }
    }

    // ── DIRECT ARB (post-deploy, called by vaults.js) ────────────────────────
    function dexArb(
        address tokenIn, address tokenOut,
        uint256 flashAmount, uint24 buyFee, uint24 sellFee,
        uint256 minProfit
    ) external onlyOwner {
        uint256 profit = _arb(tokenIn, tokenOut, flashAmount, buyFee, sellFee);
        require(profit >= minProfit, "X7:profit");
        totalProfit     += profit;
        totalExecutions += 1;
        emit Executed("arb", profit);
    }

    // ── SWEEP PROFITS TO EXECUTOR ────────────────────────────────────────────
    function sweep(address[] calldata tokens, address to) external onlyOwner {
        for (uint i = 0; i < tokens.length; i++) {
            uint256 bal = IERC20(tokens[i]).balanceOf(address(this));
            if (bal > 0) IERC20(tokens[i]).transfer(to, bal);
        }
        if (address(this).balance > 0) payable(to).transfer(address(this).balance);
    }

    receive() external payable {}
}
