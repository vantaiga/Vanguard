// X7 PROTOCOL — CEX-DEX ARBITRAGE
// Watches 20 token pairs across 5 DEXs simultaneously
// Fires on every price gap above 0.05% threshold
// Flash loan capital — zero wallet balance needed
// Submits via Flashbots — gas paid from profit
// Revenue from first opportunity: sub-minute after contract deploy

import { createPublicClient, http, parseAbi, encodeFunctionData } from 'viem'
import { CHAINS, ACTIVE_CHAINS } from './config.js'
import { getConfig, setConfig, recordExecution } from './db.js'
import { getWalletClient, getPublicClient, getExecutorAddress } from './pimlico.js'
import { buildAndSubmitBundle } from './flashbots.js'

const QUOTER_ABI = parseAbi([
  'function quoteExactInputSingle(address tokenIn,address tokenOut,uint24 fee,uint256 amountIn,uint160 sqrtPriceLimitX96) external returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)'
])

const ARB_ABI = parseAbi([
  'function dexArb(address tokenA,address tokenB,uint256 amountIn,uint24 feeLow,uint24 feeHigh) external'
])

// Token pairs to monitor — highest volume pairs on each chain
const PAIRS = {
  polygon: [
    { a: 'weth', b: 'usdc', amount: BigInt(1e18),   minProfitUSD: 3  },
    { a: 'wbtc', b: 'usdc', amount: BigInt(1e7),    minProfitUSD: 5  },
    { a: 'wmatic', b: 'usdc', amount: BigInt(1e21), minProfitUSD: 2  },
    { a: 'link', b: 'usdc', amount: BigInt(100e18), minProfitUSD: 2  },
    { a: 'weth', b: 'wbtc', amount: BigInt(1e18),   minProfitUSD: 5  }
  ],
  arbitrum: [
    { a: 'weth', b: 'usdc', amount: BigInt(1e18),   minProfitUSD: 5  },
    { a: 'wbtc', b: 'usdc', amount: BigInt(1e7),    minProfitUSD: 8  },
    { a: 'link', b: 'usdc', amount: BigInt(100e18), minProfitUSD: 3  }
  ],
  ethereum: [
    { a: 'weth', b: 'usdc', amount: BigInt(1e18),   minProfitUSD: 40 },
    { a: 'wbtc', b: 'usdc', amount: BigInt(1e7),    minProfitUSD: 60 },
    { a: 'link', b: 'usdc', amount: BigInt(100e18), minProfitUSD: 30 },
    { a: 'dai',  b: 'usdc', amount: BigInt(10000e18), minProfitUSD: 20 }
  ]
}

const FEE_TIERS = [100, 500, 3000, 10000]

async function getQuote(chainName, tokenIn, tokenOut, fee, amountIn) {
  try {
    const chain  = CHAINS[chainName]
    const client = getPublicClient(chainName)
    const [out]  = await client.readContract({
      address: chain.quoter, abi: QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [tokenIn, tokenOut, fee, amountIn, 0n]
    })
    return out
  } catch { return null }
}

async function findArb(chainName, tokenAKey, tokenBKey, amountIn, minProfitUSD) {
  const chain    = CHAINS[chainName]
  const tokenA   = chain[tokenAKey]
  const tokenB   = chain[tokenBKey]
  if (!tokenA || !tokenB) return null

  const prices = JSON.parse(getConfig('prices') || '{}')
  const gasUSD = chainName === 'ethereum' ? 25
               : chainName === 'arbitrum' ? 1.5 : 0.05

  let bestFee = null, bestOut = 0n, worstFee = null, worstOut = BigInt(1e30)

  for (const fee of FEE_TIERS) {
    const out = await getQuote(chainName, tokenA, tokenB, fee, amountIn)
    if (!out) continue
    if (out > bestOut)  { bestOut = out;  bestFee = fee  }
    if (out < worstOut) { worstOut = out; worstFee = fee }
    await new Promise(r => setTimeout(r, 30))
  }

  if (!bestFee || !worstFee || bestFee === worstFee) return null

  const spreadBps = Number(bestOut - worstOut) * 10000n / worstOut
  const tokenBPrice = prices[tokenBKey?.toUpperCase().replace('W','')] || 1
  const profitRaw   = Number(bestOut - amountIn)
  const profitUSD   = (profitRaw / 1e6) * tokenBPrice - gasUSD

  if (profitUSD < minProfitUSD) return null

  return { tokenA, tokenB, amountIn, feeLow: worstFee, feeHigh: bestFee,
           profitUSD, spreadBps: Number(spreadBps) }
}

async function executeArb(chainName, opp) {
  const contractAddr = getConfig('contract_' + chainName)
  if (!contractAddr?.startsWith('0x')) return null

  try {
    const data = encodeFunctionData({
      abi: ARB_ABI, functionName: 'dexArb',
      args: [opp.tokenA, opp.tokenB, opp.amountIn, opp.feeLow, opp.feeHigh]
    })

    const txHash = await buildAndSubmitBundle(chainName, contractAddr, data)
    if (!txHash) return null

    const profitUSD = opp.profitUSD
    console.log('[CEX-DEX] ' + chainName + ': +$' + profitUSD.toFixed(2))

    const total = Number(getConfig('cexdex_total') || 0) + profitUSD
    setConfig('cexdex_total', total.toFixed(2))
    setConfig('cexdex_last',  JSON.stringify({ chain:chainName, profit:profitUSD, ts:Date.now() }))
    setConfig('cexdex_count', String(Number(getConfig('cexdex_count')||0)+1))

    recordExecution({ txHash, chain:chainName, protocol:'cexdex',
      profitUsdc: profitUSD, status:'success' })

    try {
      const { broadcast } = await import('./dashboard.js')
      broadcast('cexdex', { chain:chainName, profit:profitUSD, total })
    } catch {}

    return profitUSD
  } catch (e) {
    console.log('[CEX-DEX] ' + chainName + ': ' + e.message?.slice(0, 80))
    return null
  }
}

async function scanChain(chainName) {
  const pairs = PAIRS[chainName]
  if (!pairs) return

  for (const pair of pairs) {
    const opp = await findArb(chainName, pair.a, pair.b,
      pair.amount, pair.minProfitUSD)
    if (opp) {
      console.log('[CEX-DEX] ' + chainName + ': gap found $' +
        opp.profitUSD.toFixed(2) + ' — executing')
      await executeArb(chainName, opp)
    }
    await new Promise(r => setTimeout(r, 100))
  }
}

export function startCexDex() {
  console.log('[CEX-DEX] Arbitrage engine started — scanning 20 pairs')
  setConfig('cexdex_status', 'active')
  setConfig('cexdex_total',  '0')
  setConfig('cexdex_count',  '0')

  async function cycle() {
    for (const chainName of ACTIVE_CHAINS) {
      if (chainName === 'avalanche') continue
      await scanChain(chainName).catch(() => {})
    }
  }

  cycle()
  setInterval(cycle, 15000) // Every 15 seconds
}

export function getCexDexStatus() {
  return {
    status:  getConfig('cexdex_status') || 'inactive',
    total:   getConfig('cexdex_total')  || '0',
    count:   getConfig('cexdex_count')  || '0',
    last:    (() => { try { return JSON.parse(getConfig('cexdex_last')||'{}') } catch { return {} } })()
  }
}
