// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ── Interfaces from verified docs ────────────────────────────────────────────

// Balancer V2: https://docs-v2.balancer.fi/reference/contracts/flash-loans.html
interface IBalancerVault {
    function flashLoan(
        address recipient,
        address[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
}

// Uniswap V3: https://docs.uniswap.org/contracts/v3/guides/flash-integrations/flash-callback
interface IUniswapV3Pool {
    function flash(address recipient, uint256 amount0, uint256 amount1, bytes calldata data) external;
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
}

// Aave V3: https://aave.com/docs/aave-v3/guides/flash-loans
interface IAavePool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24  fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256);
}

// ── Vanguard Core Contract ────────────────────────────────────────────────────
contract Vanguard {
    // Balancer V2 Vault — universal address across all supported chains
    address public constant BALANCER_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;

    address public immutable owner;
    address public immutable router;    // UniV3 SwapRouter
    address public immutable usdc;
    address public immutable weth;
    address public immutable aavePool;  // 0x0 if chain not supported

    // Flash source enum
    uint8 constant SRC_BALANCER = 0;
    uint8 constant SRC_UNIV3    = 1;
    uint8 constant SRC_AAVE     = 2;

    event ArbitrageExecuted(address indexed token, uint256 flashAmount, uint256 profit, uint8 source);
    event Swept(address indexed token, uint256 amount);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor(
        address _router,
        address _usdc,
        address _weth,
        address _flashSource,  // Balancer vault or Aave pool (ignored if == BALANCER_VAULT)
        address _aavePool
    ) {
        owner    = msg.sender;
        router   = _router;
        usdc     = _usdc;
        weth     = _weth;
        aavePool = _aavePool;
    }

    // ── RS1: Cross-Pool Arbitrage via Balancer Flash ──────────────────────────
    // Detected price gap between poolBuy and poolSell.
    // Flash USDC from Balancer → buy WETH cheap → sell WETH expensive → repay → keep profit.
    function crossPoolArb(
        address flashToken,
        uint256 flashAmount,
        address poolBuy,
        address poolSell,
        address assetToken,
        uint24  feeBuy,
        uint24  feeSell,
        uint256 minBuyAmount,
        uint256 minSellUsdc,
        address profitTo
    ) external onlyOwner {
        bytes memory data = abi.encode(
            flashToken, flashAmount, poolBuy, poolSell,
            assetToken, feeBuy, feeSell, minBuyAmount, minSellUsdc, profitTo
        );

        // Use Balancer (0% fee) as primary source
        address[] memory tokens  = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        tokens[0]  = flashToken;
        amounts[0] = flashAmount;

        IBalancerVault(BALANCER_VAULT).flashLoan(address(this), tokens, amounts, abi.encode(uint8(SRC_BALANCER), data));
    }

    // ── RS1: Cross-Pool Arbitrage via Aave Flash (fallback for chains without Balancer) ──
    function crossPoolArbAave(
        address flashToken,
        uint256 flashAmount,
        address poolBuy,
        address poolSell,
        address assetToken,
        uint24  feeBuy,
        uint24  feeSell,
        uint256 minBuyAmount,
        uint256 minSellUsdc,
        address profitTo
    ) external onlyOwner {
        require(aavePool != address(0), "no aave");
        bytes memory innerData = abi.encode(
            flashToken, flashAmount, poolBuy, poolSell,
            assetToken, feeBuy, feeSell, minBuyAmount, minSellUsdc, profitTo
        );
        IAavePool(aavePool).flashLoanSimple(
            address(this), flashToken, flashAmount,
            abi.encode(uint8(SRC_AAVE), innerData), 0
        );
    }

    // ── Balancer callback (IFlashLoanRecipient) ───────────────────────────────
    function receiveFlashLoan(
        address[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external {
        require(msg.sender == BALANCER_VAULT, "not balancer");
        (uint8 src, bytes memory data) = abi.decode(userData, (uint8, bytes));
        _executeArb(data, tokens[0], amounts[0], feeAmounts[0]);
        // Repay Balancer (fee is 0, but must return exact amount)
        IERC20(tokens[0]).transfer(BALANCER_VAULT, amounts[0] + feeAmounts[0]);
    }

    // ── Aave callback (IFlashLoanSimpleReceiver) ──────────────────────────────
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        require(msg.sender == aavePool, "not aave");
        require(initiator == address(this), "not self");
        (, bytes memory data) = abi.decode(params, (uint8, bytes));
        _executeArb(data, asset, amount, premium);
        // Aave repayment: approve pool to pull amount + premium
        IERC20(asset).approve(aavePool, amount + premium);
        return true;
    }

    // ── UniV3 callback (IUniswapV3FlashCallback) ─────────────────────────────
    function uniswapV3FlashCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata data
    ) external {
        // Caller validation: msg.sender must be a known UniV3 pool
        // In production: verify via UniV3 factory
        (, bytes memory innerData) = abi.decode(data, (uint8, bytes));
        // fee0 or fee1 depending on which token was flashed
        _executeArb(innerData, address(0), 0, fee0 + fee1);
    }

    // ── Core arb execution ────────────────────────────────────────────────────
    function _executeArb(
        bytes memory data,
        address flashToken,
        uint256 flashAmount,
        uint256 fee
    ) internal {
        (
            address _flashToken,
            uint256 _flashAmount,
            address poolBuy,
            address poolSell,
            address assetToken,
            uint24  feeBuy,
            uint24  feeSell,
            uint256 minBuyAmount,
            uint256 minSellUsdc,
            address profitTo
        ) = abi.decode(data, (address,uint256,address,address,address,uint24,uint24,uint256,uint256,address));

        uint256 startBal = IERC20(_flashToken).balanceOf(address(this));

        // Step 1: Approve router to spend flash token
        IERC20(_flashToken).approve(router, _flashAmount);

        // Step 2: Buy asset token on impacted pool (cheap price)
        uint256 assetReceived = ISwapRouter(router).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn:           _flashToken,
                tokenOut:          assetToken,
                fee:               feeBuy,
                recipient:         address(this),
                deadline:          block.timestamp + 60,
                amountIn:          _flashAmount,
                amountOutMinimum:  minBuyAmount,
                sqrtPriceLimitX96: 0
            })
        );

        // Step 3: Sell asset token on un-impacted pool (higher price)
        IERC20(assetToken).approve(router, assetReceived);
        uint256 received = ISwapRouter(router).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn:           assetToken,
                tokenOut:          _flashToken,
                fee:               feeSell,
                recipient:         address(this),
                deadline:          block.timestamp + 60,
                amountIn:          assetReceived,
                amountOutMinimum:  minSellUsdc,
                sqrtPriceLimitX96: 0
            })
        );

        // Step 4: Verify profit
        uint256 repayAmount = _flashAmount + fee;
        require(received >= repayAmount, "not profitable");

        uint256 profit = received - repayAmount;
        if (profit > 0 && profitTo != address(0)) {
            IERC20(_flashToken).transfer(profitTo, profit);
        }

        emit ArbitrageExecuted(_flashToken, _flashAmount, profit, SRC_BALANCER);
    }

    // ── RS2: DEX Arb (direct, no flash — for post-capital execution) ──────────
    function dexArb(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint24  feeBuy,
        uint24  feeSell,
        uint256 minProfit
    ) external onlyOwner {
        IERC20(tokenIn).approve(router, amountIn);
        uint256 out = ISwapRouter(router).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: tokenIn, tokenOut: tokenOut, fee: feeBuy,
                recipient: address(this), deadline: block.timestamp + 60,
                amountIn: amountIn, amountOutMinimum: 0, sqrtPriceLimitX96: 0
            })
        );
        require(out > amountIn + minProfit, "insufficient profit");
    }

    // ── Sweep profits to executor ─────────────────────────────────────────────
    function sweep(address[] calldata tokens, address to) external onlyOwner {
        for (uint i = 0; i < tokens.length; i++) {
            uint256 bal = IERC20(tokens[i]).balanceOf(address(this));
            if (bal > 0) {
                IERC20(tokens[i]).transfer(to, bal);
                emit Swept(tokens[i], bal);
            }
        }
    }

    receive() external payable {}
}
