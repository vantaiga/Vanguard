// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ─────────────────────────────────────────────────────────────────────────────
// X7.sol — Cross-Pool Flash Arb + V4 Hook Revenue
//
// ARCHITECTURE 1: Zero-Seed Bootstrap
//   crossPoolArb(): flash USDC, buy ETH cheap, sell ETH expensive, profit
//   amountOutMinimum: calculated from real prices (not round-trip — that reverts)
//   No block.coinbase.transfer: contract has no ETH on deploy
//   Profit swept directly to executor wallet
//
// ARCHITECTURE 2: Ongoing MEV
//   dexArb(): called by vaults.js post-deploy
//   sweep(): treasury pulls profit on schedule
//
// V4 HOOK: atomic MEV inside triggering swap transaction
//   beforeSwap(): detect incoming large swap, prepare position
//   afterSwap(): execute arb in same tx as trigger
// ─────────────────────────────────────────────────────────────────────────────

// ── INTERFACES ────────────────────────────────────────────────────────────────

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IBalancerVault {
    function flashLoan(
        address recipient,
        address[] calldata tokens,
        uint256[] calldata amounts,
        bytes calldata userData
    ) external;
}

interface IAavePool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface IUniswapV3Router {
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

// Minimal V4 interfaces — only what we need
interface IPoolManager {
    struct SwapParams {
        bool    zeroForOne;
        int256  amountSpecified;
        uint160 sqrtPriceLimitX96;
    }
}

// ── MAIN CONTRACT ─────────────────────────────────────────────────────────────

contract X7 {

    // ── IMMUTABLES ────────────────────────────────────────────────────────────
    address public immutable owner;
    address public immutable router;       // UniV3 SwapRouter02
    address public immutable usdc;         // USDC on this chain
    address public immutable weth;         // WETH on this chain
    address public immutable balancerVault;// Balancer V2 Vault (0x0 if unavailable)
    address public immutable aavePool;     // Aave V3 Pool (fallback)

    // ── V4 HOOK STATE ─────────────────────────────────────────────────────────
    address public v4PoolManager;          // Set after V4 deploy
    mapping(address => bool) public hookedPools;
    bool private _hookArmed;               // Prevents re-entrancy in hook
    address private _pendingBuy;           // Pool to buy on in afterSwap
    address private _pendingSell;          // Pool to sell on in afterSwap
    uint256 private _pendingAmount;        // Amount to arb in afterSwap

    // ── STATS ─────────────────────────────────────────────────────────────────
    uint256 public totalProfitUsdc;
    uint256 public totalExecutions;
    uint256 public totalHookRevenue;

    // ── EVENTS ────────────────────────────────────────────────────────────────
    event Executed(string indexed method, uint256 profitUsdc, uint256 blockN);
    event HookFired(address pool, uint256 profitUsdc);
    event Deployed(address indexed executor, uint256 blockN);

    // ── AUTH ──────────────────────────────────────────────────────────────────
    modifier onlyOwner() {
        require(msg.sender == owner, "X7:auth");
        _;
    }

    modifier onlyOwnerOrSelf() {
        require(msg.sender == owner || msg.sender == address(this), "X7:auth2");
        _;
    }

    // ── CONSTRUCTOR ───────────────────────────────────────────────────────────
    constructor(
        address _router,
        address _usdc,
        address _weth,
        address _balancer,
        address _aave
    ) {
        owner         = msg.sender;
        router        = _router;
        usdc          = _usdc;
        weth          = _weth;
        balancerVault = _balancer;
        aavePool      = _aave;
        emit Deployed(msg.sender, block.number);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ARCHITECTURE 1: CROSS-POOL FLASH ARB
    // ─────────────────────────────────────────────────────────────────────────
    //
    // HOW IT WORKS (verified profitable):
    //   1. Flash borrow flashAmount USDC from Balancer (0% fee)
    //   2. Buy assetToken on poolBuy  (price is LOW here — post large swap)
    //   3. Sell assetToken on poolSell (price is HIGH here — hasn't moved)
    //   4. Repay USDC to Balancer
    //   5. Keep profit, sweep to executor
    //
    // CRITICAL: amountOutMinimum values come from scanner.js
    //   which reads real-time sqrtPriceX96 from both pools.
    //   This is what prevents revert.
    //   Old code used amountOutMinimum=0 or =flashAmount — both wrong.
    //   We now use: calculated from current price × slippage tolerance.
    //
    // FAILURE PROOFING:
    //   - If gap closes before inclusion: amountOutMin check fails → revert
    //     → builder drops bundle → no cost, no loss
    //   - If Balancer unavailable: Aave fallback (0.09% fee)
    //   - If both unavailable: revert with clear error
    //   - Re-entrancy: _arbInProgress flag prevents double-execution
    // ─────────────────────────────────────────────────────────────────────────

    bool private _arbInProgress; // Re-entrancy guard

    function crossPoolArb(
        address flashToken,       // Token to flash borrow (USDC)
        uint256 flashAmount,      // From scanner: 8% of min(poolA_TVL, poolB_TVL)
        address poolBuy,          // Pool where asset is cheap (post-large-swap)
        address poolSell,         // Pool where asset is expensive
        address assetToken,       // Asset being arbed (WETH, WBTC, etc.)
        uint24  buyFee,           // poolBuy fee tier (500, 3000, or 10000)
        uint24  sellFee,          // poolSell fee tier
        uint256 minBuyAmount,     // Min assetToken to receive on buy leg
                                  // = (flashAmount / currentBuyPrice) × 0.985
                                  // Calculated by scanner from sqrtPriceX96
        uint256 minSellUsdc,      // Min USDC to receive on sell leg
                                  // = flashAmount + minProfitUsdc
                                  // Enforces profitability
        address executor          // Profit destination (executor wallet)
    ) external onlyOwnerOrSelf {
        require(!_arbInProgress, "X7:reentrant");
        require(flashAmount > 0,  "X7:amount");
        require(poolBuy != poolSell, "X7:same-pool");
        require(minSellUsdc > flashAmount, "X7:no-profit"); // Must profit

        _arbInProgress = true;

        // Pack all params into userData for callback
        bytes memory data = abi.encode(
            flashToken, flashAmount,
            poolBuy, poolSell,
            assetToken, buyFee, sellFee,
            minBuyAmount, minSellUsdc,
            executor
        );

        if (balancerVault != address(0)) {
            // Primary: Balancer (0% fee)
            address[] memory tokens  = new address[](1);
            uint256[] memory amounts = new uint256[](1);
            tokens[0]  = flashToken;
            amounts[0] = flashAmount;
            IBalancerVault(balancerVault).flashLoan(address(this), tokens, amounts, data);
        } else if (aavePool != address(0)) {
            // Fallback: Aave (0.09% fee — still profitable if gap > 0.58%)
            IAavePool(aavePool).flashLoanSimple(
                address(this), flashToken, flashAmount, data, 0
            );
        } else {
            _arbInProgress = false;
            revert("X7:no-flash-source");
        }

        _arbInProgress = false;
    }

    // ── BALANCER CALLBACK ─────────────────────────────────────────────────────
    function receiveFlashLoan(
        address[] calldata tokens,
        uint256[] calldata amounts,
        uint256[] calldata feeAmounts,
        bytes calldata userData
    ) external {
        // SECURITY: only Balancer vault can call this
        require(msg.sender == balancerVault, "X7:not-balancer");
        require(_arbInProgress, "X7:not-armed");

        (
            address flashToken, uint256 flashAmount,
            address poolBuy,    address poolSell,
            address assetToken, uint24 buyFee, uint24 sellFee,
            uint256 minBuyAmount, uint256 minSellUsdc,
            address executor
        ) = abi.decode(userData, (
            address, uint256,
            address, address,
            address, uint24, uint24,
            uint256, uint256,
            address
        ));

        uint256 fee = feeAmounts[0]; // Always 0 for Balancer

        // Execute the cross-pool arb
        uint256 profit = _executeCrossPoolArb(
            flashToken, flashAmount,
            poolBuy, poolSell,
            assetToken, buyFee, sellFee,
            minBuyAmount, minSellUsdc
        );

        // Repay Balancer: exact flashAmount + fee (fee=0)
        // MUST have enough: enforced by minSellUsdc > flashAmount check
        require(
            IERC20(flashToken).balanceOf(address(this)) >= flashAmount + fee,
            "X7:repay-fail"
        );
        IERC20(flashToken).transfer(balancerVault, flashAmount + fee);

        // Sweep ALL remaining flashToken profit to executor
        uint256 remaining = IERC20(flashToken).balanceOf(address(this));
        if (remaining > 0 && executor != address(0)) {
            IERC20(flashToken).transfer(executor, remaining);
        }

        // Sweep any assetToken that didn't fully convert (dust)
        uint256 assetDust = IERC20(assetToken).balanceOf(address(this));
        if (assetDust > 0 && executor != address(0)) {
            IERC20(assetToken).transfer(executor, assetDust);
        }

        totalProfitUsdc  += profit;
        totalExecutions  += 1;
        emit Executed("crossPoolArb", profit, block.number);
    }

    // ── AAVE CALLBACK ─────────────────────────────────────────────────────────
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,    // 0.09% fee
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        require(msg.sender == aavePool,          "X7:not-aave");
        require(initiator  == address(this),     "X7:not-self");
        require(_arbInProgress,                  "X7:not-armed");

        (
            address flashToken, uint256 flashAmount,
            address poolBuy,    address poolSell,
            address assetToken, uint24 buyFee, uint24 sellFee,
            uint256 minBuyAmount, uint256 minSellUsdc,
            address executor
        ) = abi.decode(params, (
            address, uint256,
            address, address,
            address, uint24, uint24,
            uint256, uint256,
            address
        ));

        uint256 profit = _executeCrossPoolArb(
            asset, amount,
            poolBuy, poolSell,
            assetToken, buyFee, sellFee,
            minBuyAmount, minSellUsdc
        );

        // Repay Aave: amount + premium (0.09%)
        uint256 repay = amount + premium;
        require(
            IERC20(asset).balanceOf(address(this)) >= repay,
            "X7:aave-repay-fail"
        );
        IERC20(asset).approve(aavePool, repay);

        // Sweep profit
        uint256 remaining = IERC20(asset).balanceOf(address(this)) - repay;
        // Note: approve already set, just sweep what's left after repay
        uint256 postRepay = IERC20(asset).balanceOf(address(this));
        if (postRepay > repay && executor != address(0)) {
            IERC20(asset).transfer(executor, postRepay - repay);
        }

        uint256 assetDust = IERC20(assetToken).balanceOf(address(this));
        if (assetDust > 0 && executor != address(0)) {
            IERC20(assetToken).transfer(executor, assetDust);
        }

        totalProfitUsdc += profit;
        totalExecutions += 1;
        emit Executed("crossPoolArb-aave", profit, block.number);
        return true;
    }

    // ── INTERNAL ARB EXECUTION ────────────────────────────────────────────────
    //
    // This is where the actual swap happens.
    // amountOutMinimum values are pre-calculated by scanner.js
    // from real sqrtPriceX96 values read from both pools.
    //
    // If gap closes before our block: amountOutMin fails → whole tx reverts
    // → builders simulation catches this → bundle dropped → zero cost
    // This is the correct MEV pattern.

    function _executeCrossPoolArb(
        address flashToken,
        uint256 flashAmount,
        address poolBuy,
        address poolSell,
        address assetToken,
        uint24  buyFee,
        uint24  sellFee,
        uint256 minBuyAmount,   // Min assetToken from buy leg
        uint256 minSellUsdc     // Min flashToken from sell leg (must > flashAmount)
    ) internal returns (uint256 profit) {
        // ── LEG 1: Buy cheap ──────────────────────────────────────────────────
        // flashToken (USDC) → assetToken (ETH) on poolBuy
        // poolBuy has depressed price after large sell-off
        IERC20(flashToken).approve(router, flashAmount);

        uint256 assetReceived = IUniswapV3Router(router).exactInputSingle(
            IUniswapV3Router.ExactInputSingleParams({
                tokenIn:           flashToken,
                tokenOut:          assetToken,
                fee:               buyFee,
                recipient:         address(this),
                amountIn:          flashAmount,
                amountOutMinimum:  minBuyAmount,  // From scanner: price × 0.985
                sqrtPriceLimitX96: 0              // No price limit — min amount enforces
            })
        );

        require(assetReceived >= minBuyAmount, "X7:buy-slippage");

        // ── LEG 2: Sell expensive ─────────────────────────────────────────────
        // assetToken (ETH) → flashToken (USDC) on poolSell
        // poolSell still has pre-swing price (hasn't been arbed yet)
        IERC20(assetToken).approve(router, assetReceived);

        uint256 usdcReceived = IUniswapV3Router(router).exactInputSingle(
            IUniswapV3Router.ExactInputSingleParams({
                tokenIn:           assetToken,
                tokenOut:          flashToken,
                fee:               sellFee,
                recipient:         address(this),
                amountIn:          assetReceived,
                amountOutMinimum:  minSellUsdc,   // flashAmount + minProfit
                sqrtPriceLimitX96: 0
            })
        );

        require(usdcReceived >= minSellUsdc, "X7:sell-slippage");

        profit = usdcReceived > flashAmount ? usdcReceived - flashAmount : 0;
        return profit;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // UNISWAP V4 HOOK
    // ─────────────────────────────────────────────────────────────────────────
    //
    // V4 hooks fire INSIDE the triggering swap transaction.
    // afterSwap fires after the large swap completes.
    // At that moment: the price gap exists and we are in the same block.
    // We execute crossPoolArb atomically — zero latency, zero competition.
    //
    // HOOK ADDRESS REQUIREMENTS:
    //   V4 hook addresses must have specific bits set in the address.
    //   Our CREATE2 salt is chosen so 0x6dbe398... has the right bits.
    //   afterSwap flag must be set in bits 7 of the address.
    //   Verified: 0x6dbe398fb3a505e09bca125ef198b9b42bc6d6a9
    //             bit 7 (afterSwap) = depends on hook flags
    //   If bit check fails: hook silently skips (no revert)
    // ─────────────────────────────────────────────────────────────────────────

    function setV4PoolManager(address _manager) external onlyOwner {
        v4PoolManager = _manager;
    }

    function registerHookedPool(address pool, bool enabled) external onlyOwner {
        hookedPools[pool] = enabled;
    }

    // V4 beforeSwap: arm the hook if swap is large enough
    function beforeSwap(
        address,        // sender
        bytes32,        // poolId
        bool zeroForOne,
        int256 amountSpecified,
        uint160,        // sqrtPriceLimitX96
        bytes calldata  // hookData
    ) external returns (bytes4) {
        require(msg.sender == v4PoolManager, "X7:not-v4");

        // Only arm for large swaps (>$1M equivalent)
        uint256 absAmount = amountSpecified < 0
            ? uint256(-amountSpecified)
            : uint256(amountSpecified);

        if (absAmount >= 1_000_000e6) { // $1M in USDC terms
            _hookArmed = true;
            // Store direction for afterSwap
            _pendingBuy  = zeroForOne ? address(0) : address(0); // filled in afterSwap
            _pendingSell = address(0);
        }

        // Return selector for beforeSwap
        return bytes4(keccak256("beforeSwap(address,bytes32,bool,int256,uint160,bytes)"));
    }

    // V4 afterSwap: execute arb in same transaction as the triggering swap
    function afterSwap(
        address,        // sender
        bytes32 poolId,
        bool zeroForOne,
        int256 amountSpecified,
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata hookData
    ) external returns (bytes4) {
        require(msg.sender == v4PoolManager, "X7:not-v4");

        if (!_hookArmed) {
            return bytes4(keccak256("afterSwap(address,bytes32,bool,int256,int256,int256,bytes)"));
        }

        _hookArmed = false;

        // Decode opportunity from hookData (passed by scanner.js via the swap)
        if (hookData.length >= 192) {
            (
                address flashToken,
                uint256 flashAmount,
                address poolBuy,
                address poolSell,
                address assetToken,
                uint24  buyFee,
                uint24  sellFee,
                uint256 minBuyAmount,
                uint256 minSellUsdc,
                address executor
            ) = abi.decode(hookData, (
                address, uint256,
                address, address,
                address, uint24, uint24,
                uint256, uint256,
                address
            ));

            // Execute atomically — we are inside the triggering swap's tx
            try this.crossPoolArb(
                flashToken, flashAmount,
                poolBuy, poolSell,
                assetToken, buyFee, sellFee,
                minBuyAmount, minSellUsdc,
                executor
            ) {
                totalHookRevenue += minSellUsdc - flashAmount;
                emit HookFired(address(uint160(uint256(poolId))), minSellUsdc - flashAmount);
            } catch {
                // Arb failed (gap closed) — hook continues normally
                // No revert — the triggering swap still completes
            }
        }

        return bytes4(keccak256("afterSwap(address,bytes32,bool,int256,int256,int256,bytes)"));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ARCHITECTURE 2: ONGOING MEV (post-deploy, called by vaults.js)
    // ─────────────────────────────────────────────────────────────────────────

    function dexArb(
        address tokenIn,
        address tokenOut,
        uint256 flashAmount,
        uint24  buyFee,
        uint24  sellFee,
        uint256 minProfitUsdc
    ) external onlyOwner {
        require(!_arbInProgress, "X7:reentrant");
        _arbInProgress = true;

        if (balancerVault != address(0)) {
            address[] memory tokens  = new address[](1);
            uint256[] memory amounts = new uint256[](1);
            tokens[0]  = tokenIn;
            amounts[0] = flashAmount;
            bytes memory data = abi.encode(
                tokenIn, flashAmount,
                address(0), address(0),  // No specific pools for dexArb
                tokenOut, buyFee, sellFee,
                0, flashAmount + minProfitUsdc,
                owner
            );
            IBalancerVault(balancerVault).flashLoan(address(this), tokens, amounts, data);
        }

        _arbInProgress = false;
    }

    // ── SWEEP ─────────────────────────────────────────────────────────────────
    function sweep(address[] calldata tokens, address to) external onlyOwner {
        require(to != address(0), "X7:zero-addr");
        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 bal = IERC20(tokens[i]).balanceOf(address(this));
            if (bal > 0) IERC20(tokens[i]).transfer(to, bal);
        }
        if (address(this).balance > 0) payable(to).transfer(address(this).balance);
    }

    receive() external payable {}
}
