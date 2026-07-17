// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IBalancerVault {
    function flashLoan(
        address recipient,
        address[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
}

interface IUniswapV3Pool {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

interface IAavePool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
    function liquidationCall(
        address collateralAsset,
        address debtAsset,
        address user,
        uint256 debtToCover,
        bool receiveAToken
    ) external;
}

interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24  fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params)
        external returns (uint256 amountOut);
}

contract Vanguard {
    address public immutable owner;
    address public immutable BALANCER = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    address public immutable SWAP_ROUTER;

    uint160 private constant SQRT_PRICE_LIMIT_X96_ZFO = 4295128740;
    uint160 private constant SQRT_PRICE_LIMIT_X96_OFZ = 1461446703485210103287273052203988822378723970341;

    event ArbExecuted(address indexed token, uint256 profit);
    event Liquidated(address indexed user, uint256 bonus);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor(address _swapRouter) {
        owner       = msg.sender;
        SWAP_ROUTER = _swapRouter;
    }

    // ── DEX ARB via Balancer flash loan (0% fee) ──────────────────────────
    function dexArb(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint24  feeBuy,
        uint24  feeSell,
        uint256 minProfit
    ) external onlyOwner {
        address[] memory tokens  = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        tokens[0]  = tokenIn;
        amounts[0] = amountIn;

        bytes memory userData = abi.encode(
            tokenIn, tokenOut, amountIn, feeBuy, feeSell, minProfit
        );
        IBalancerVault(BALANCER).flashLoan(address(this), tokens, amounts, userData);
    }

    // ── Balancer flash loan callback ──────────────────────────────────────
    function receiveFlashLoan(
        address[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external {
        require(msg.sender == BALANCER, "Only Balancer");

        (address tokenIn, address tokenOut, uint256 amountIn,
         uint24 feeBuy, uint24 feeSell, uint256 minProfit) =
            abi.decode(userData, (address, address, uint256, uint24, uint24, uint256));

        uint256 balBefore = IERC20(tokenOut).balanceOf(address(this));

        // Buy on DEX A
        IERC20(tokenIn).approve(SWAP_ROUTER, amountIn);
        ISwapRouter(SWAP_ROUTER).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn:           tokenIn,
                tokenOut:          tokenOut,
                fee:               feeBuy,
                recipient:         address(this),
                amountIn:          amountIn,
                amountOutMinimum:  0,
                sqrtPriceLimitX96: 0
            })
        );

        uint256 received = IERC20(tokenOut).balanceOf(address(this)) - balBefore;

        // Sell on DEX B
        IERC20(tokenOut).approve(SWAP_ROUTER, received);
        uint256 returned = ISwapRouter(SWAP_ROUTER).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn:           tokenOut,
                tokenOut:          tokenIn,
                fee:               feeSell,
                recipient:         address(this),
                amountIn:          received,
                amountOutMinimum:  amountIn + feeAmounts[0] + minProfit,
                sqrtPriceLimitX96: 0
            })
        );

        uint256 profit = returned - amountIn - feeAmounts[0];
        require(profit >= minProfit, "Insufficient profit");

        // Repay Balancer
        IERC20(tokenIn).transfer(BALANCER, amounts[0] + feeAmounts[0]);

        emit ArbExecuted(tokenIn, profit);
    }

    // ── Cross-pool arbitrage ──────────────────────────────────────────────
    function crossPoolArb(
        address flashToken,
        uint256 flashAmount,
        address tokenIn,
        address tokenOut,
        address poolA,
        uint24  feeA,
        uint24  feeB,
        uint256 minOut,
        uint256 minProfit,
        address recipient
    ) external onlyOwner {
        address[] memory tokens  = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        tokens[0]  = flashToken;
        amounts[0] = flashAmount;

        bytes memory userData = abi.encode(
            tokenIn, tokenOut, poolA, feeA, feeB, minOut, minProfit, recipient
        );
        IBalancerVault(BALANCER).flashLoan(address(this), tokens, amounts, userData);
    }

    // ── Liquidation execution ─────────────────────────────────────────────
    function flashLiquidate(
        address aavePool,
        address user,
        address collateralAsset,
        address debtAsset,
        uint256 debtToCover,
        bool    receiveAToken
    ) external onlyOwner {
        address[] memory tokens  = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        tokens[0]  = debtAsset;
        amounts[0] = debtToCover;

        bytes memory userData = abi.encode(
            aavePool, user, collateralAsset, debtAsset, debtToCover, receiveAToken
        );
        IBalancerVault(BALANCER).flashLoan(address(this), tokens, amounts, userData);
    }

    // ── Sweep tokens to owner ─────────────────────────────────────────────
    function sweep(address[] calldata tokens, address to) external onlyOwner {
        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 bal = IERC20(tokens[i]).balanceOf(address(this));
            if (bal > 0) IERC20(tokens[i]).transfer(to, bal);
        }
    }

    // ── Receive ETH ───────────────────────────────────────────────────────
    receive() external payable {}

    function withdrawETH(address payable to, uint256 amount) external onlyOwner {
        (bool ok,) = to.call{value: amount}("");
        require(ok, "ETH transfer failed");
    }
}
