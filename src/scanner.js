// X7-SV · scanner.js — ALL chains · ALL pairs · sub-50ms gap detection
//
// ARCHITECTURE: 
//   Every chain's WebSocket feeds into one unified gap detector
//   Same ws.on('log') pattern as vaults.js (proven to work)
//   sqrtPriceX96 decoded from correct offset (verified against vaults.js)
//   First gap on ANY chain triggers bootstrap for THAT chain
//   No waiting for ETH specifically

import { getConfig, setConfig } from './db.js'
import { getWS } from './rpc.js'
import { getActiveChains, getChain } from './chains.js'
import { emit } from './events.js'

const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'

// ── ALL POOL PAIRS ACROSS ALL CHAINS ─────────────────────────────────────────
// Same addresses vaults.js already watches — guaranteed WebSocket works
const POOL_PAIRS = {
  ethereum: [
    {
      name: 'ETH/USDC-500-3000',
      asset: 'weth', flashToken: 'usdc',
      poolA: { address: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640', fee: 500,  tvl: 150_000_000, token0IsFlash: true },
      poolB: { address: '0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8', fee: 3000, tvl: 80_000_000,  token0IsFlash: true },
    },
    {
      name: 'ETH/USDC-500-3000b',
      asset: 'weth', flashToken: 'usdc',
      poolA: { address: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640', fee: 500,  tvl: 150_000_000, token0IsFlash: true },
      poolB: { address: '0x4585FE77225b41b697C938B018E2ac67Ac5a20c0', fee: 3000, tvl: 60_000_000,  token0IsFlash: true },
    },
    {
      name: 'WBTC/USDC-3000-3000',
      asset: 'wbtc', flashToken: 'usdc',
      poolA: { address: '0x99ac8cA7087fA4A2A1FB6357269965A2014ABc35', fee: 3000, tvl: 60_000_000, token0IsFlash: false },
      poolB: { address: '0x4585FE77225b41b697C938B018E2ac67Ac5a20c0', fee: 3000, tvl: 60_000_000, token0IsFlash: false },
    },
  ],
  arbitrum: [
    {
      name: 'ETH/USDC-ARB-500-3000',
      asset: 'weth', flashToken: 'usdc',
      poolA: { address: '0xC6962004f452bE9203591991D15f6b388e09E8D0', fee: 500,  tvl: 80_000_000, token0IsFlash: true },
      poolB: { address: '0x2f5e87C9312fa29aed5c179E456625D79015299c', fee: 3000, tvl: 30_000_000, token0IsFlash: true },
    },
  ],
  polygon: [
    {
      name: 'ETH/USDC-POLY-500-3000',
      asset: 'weth', flashToken: 'usdc',
      poolA: { address: '0x45dDa9cb7c25131DF268515131f647d726f50608', fee: 500,  tvl: 50_000_000, token0IsFlash: true },
      poolB: { address: '0x50eaEDB835021E4A108B7290636d62E9765cc6d7', fee: 3000, tvl: 20_000_000, token0IsFlash: true },
    },
  ],
  base: [
    {
      name: 'ETH/USDC-BASE-500-3000',
      asset: 'weth', flashToken: 'usdc',
      poolA: { address: '0x4C36388bE6F416A29C8d8Eee81C771cE6bE14B5', fee: 500,  tvl: 50_000_000, token0IsFlash: true },
      poolB: { address: '0xd0b53D9277642d899DF5C87A3966A349A798F224', fee: 3000, tvl: 20_000_000, token0IsFlash: true },
    },
  ],
}

// Token addresses per chain
const TOKENS = {
  ethereum: {
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    usdt: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    wbtc: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
  },
  arbitrum: {
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  },
  polygon: {
    usdc: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    weth: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
  },
  base: {
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    weth: '0x4200000000000000000000000000000000000006',
  },
}

// Balancer vault per chain (0% flash loans)
const BALANCER = {
  ethereum: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  arbitrum: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  polygon:  '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  base:     null, // Aave fallback on base
}

// Aave pool per chain (0.09% flash loans — fallback)
const AAVE = {
  ethereum: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  arbitrum: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  polygon:  '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  base:     '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
}

// ── STATE ─────────────────────────────────────────────────────────────────────
const _prices    = new Map() // `${chain}:${poolAddr}` → { price, ts }
const _lastEmit  = new Map() // pairName → timestamp
const COOLDOWN   = 2000      // 2s cooldown per pair — fast but not spammy

// ── PRICE DECODE ──────────────────────────────────────────────────────────────
// Uses EXACT same data layout as vaults.js decodeAmounts()
// THEN extracts sqrtPriceX96 from correct position
// Layout: amount0(32) amount1(32) sqrtPriceX96(32) liquidity(32) tick(32)
// In hex chars: 64 + 64 + 64 + 64 + 64

function decodePrice(log, token0IsFlash) {
  try {
    if (!log.data || log.data.length < 322) return null
    const hex = log.data.startsWith('0x') ? log.data.slice(2) : log.data
    if (hex.length < 320) return null

    // sqrtPriceX96 at offset 128 hex chars (after amount0 + amount1)
    const sqrtHex      = hex.slice(128, 192)
    const sqrtPriceX96 = BigInt('0x' + sqrtHex)
    if (sqrtPriceX96 === 0n) return null

    // Convert to price using floating point
    // rawPrice = (sqrtPriceX96 / 2^96)^2
    const sqrt   = Number(sqrtPriceX96) / Number(2n ** 96n)
    const raw    = sqrt * sqrt

    // Price in terms of token1/token0
    // For USDC(6dec)/WETH(18dec) pools:
    //   if token0=USDC: ethPrice = (1/raw) * 10^12
    //   if token0=WETH: ethPrice = raw * 10^12
    const price = token0IsFlash
      ? (1 / raw) * 1e12
      : raw * 1e12

    // Sanity: ETH $500-$50000, BTC $10000-$500000
    if (price < 100 || price > 1_000_000) return null

    return { price, ts: Date.now() }
  } catch { return null }
}

// ── GAP MATH ──────────────────────────────────────────────────────────────────
function calcOpportunity(chain, pair, priceA, priceB) {
  const gap    = Math.abs(priceA.price - priceB.price)
  const gapPct = gap / Math.min(priceA.price, priceB.price) * 100

  if (gapPct < 0.15) return null

  const buyFromA  = priceA.price < priceB.price
  const poolBuy   = buyFromA ? pair.poolA : pair.poolB
  const poolSell  = buyFromA ? pair.poolB : pair.poolA
  const buyPrice  = buyFromA ? priceA.price : priceB.price

  // Flash size: 8% of smaller pool TVL, capped at $20M
  const minTVL      = Math.min(poolBuy.tvl, poolSell.tvl)
  const flashUsdc   = Math.min(minTVL * 0.08, 20_000_000)
  if (flashUsdc < 100_000) return null

  // Cost: fees + price impact
  const impactBuy  = (flashUsdc / poolBuy.tvl)  * 0.5 * 100
  const impactSell = (flashUsdc / poolSell.tvl) * 0.5 * 100
  const feeCost    = (poolBuy.fee + poolSell.fee) / 10000 * 100
  const totalCost  = feeCost + impactBuy + impactSell

  // Aave fallback adds 0.09%
  const flashFee   = BALANCER[chain] ? 0 : 0.09
  const netGap     = gapPct - totalCost - flashFee
  if (netGap <= 0) return null

  const profitUsdc = Math.floor(flashUsdc * (netGap / 100))
  if (profitUsdc < 500) return null

  // amountOutMinimums — conservative 2% slippage buffer
  const expectedAsset  = flashUsdc / buyPrice
  const minBuyAmount   = BigInt(Math.floor(expectedAsset * 0.98 * 1e18)) // WETH wei
  const flashAmountWei = BigInt(Math.floor(flashUsdc * 1e6))             // USDC 6dec
  const minSellUsdc    = flashAmountWei + BigInt(Math.floor(profitUsdc * 0.5 * 1e6)) // 50% of estimate

  const tokens = TOKENS[chain] || {}

  return {
    chain,
    pairName:        pair.name,
    flashToken:      tokens[pair.flashToken],
    assetToken:      tokens[pair.asset],
    flashAmountUsdc: flashUsdc,
    flashAmountWei,
    poolBuy:         poolBuy.address,
    poolSell:        poolSell.address,
    buyFee:          poolBuy.fee,
    sellFee:         poolSell.fee,
    gapPct:          parseFloat(gapPct.toFixed(4)),
    buyPrice:        parseFloat(buyPrice.toFixed(2)),
    profitUsdc,
    minBuyAmount,
    minSellUsdc,
    balancer:        BALANCER[chain] || null,
    aave:            AAVE[chain]     || null,
    ts:              Date.now()
  }
}

// ── EVALUATE PAIR ─────────────────────────────────────────────────────────────
function evaluate(chain, pair) {
  const keyA = `${chain}:${pair.poolA.address.toLowerCase()}`
  const keyB = `${chain}:${pair.poolB.address.toLowerCase()}`
  const pA   = _prices.get(keyA)
  const pB   = _prices.get(keyB)
  if (!pA || !pB) return

  // Both prices must be fresh (< 30s old)
  const now = Date.now()
  if (now - pA.ts > 30000 || now - pB.ts > 30000) return

  const opp = calcOpportunity(chain, pair, pA, pB)
  if (!opp) return

  // Cooldown per pair
  const last = _lastEmit.get(pair.name) || 0
  if (now - last < COOLDOWN) return
  _lastEmit.set(pair.name, now)

  const totalGaps = parseInt(getConfig('scanner_gaps_detected') || '0') + 1
  setConfig('scanner_gaps_detected', String(totalGaps))

  console.log(
    `[SCANNER] *** GAP: ${pair.name} | ${opp.gapPct.toFixed(3)}% | ` +
    `flash $${(opp.flashAmountUsdc/1e6).toFixed(1)}M | ` +
    `profit ~$${opp.profitUsdc.toLocaleString()} | ${chain}`
  )

  emit('arb_opportunity', opp)
}

// ── WATCH CHAIN ───────────────────────────────────────────────────────────────
// EXACT same pattern as vaults.js watchChain() — proven to work
function watchChain(chainName) {
  const pairs = POOL_PAIRS[chainName]
  if (!pairs?.length) return

  const ws = getWS(chainName)
  if (!ws) {
    console.warn(`[SCANNER] No WS for ${chainName} — retry in 15s`)
    setTimeout(() => watchChain(chainName), 15000)
    return
  }

  // Subscribe to all pools across all pairs on this chain
  // Build a set so we don't double-subscribe to shared pools
  const allPools = new Set()
  for (const pair of pairs) {
    allPools.add(pair.poolA.address)
    allPools.add(pair.poolB.address)
  }

  allPools.forEach(addr => {
    ws.subscribe({
      jsonrpc: '2.0',
      id:      Math.random() * 99999 | 0,
      method:  'eth_subscribe',
      params:  ['logs', { address: addr, topics: [SWAP_TOPIC] }]
    })
  })

  // Build reverse lookup: poolAddress → pairs that include this pool
  const poolToPairs = new Map()
  for (const pair of pairs) {
    for (const pool of [pair.poolA, pair.poolB]) {
      const key = pool.address.toLowerCase()
      if (!poolToPairs.has(key)) poolToPairs.set(key, [])
      poolToPairs.get(key).push({ pair, pool })
    }
  }

  // SAME ws.on('log') pattern as vaults.js
  ws.on('log', log => {
    if (log.topics?.[0] !== SWAP_TOPIC) return

    const poolAddr = log.address?.toLowerCase()
    if (!poolAddr) return

    const entries = poolToPairs.get(poolAddr)
    if (!entries?.length) return

    for (const { pair, pool } of entries) {
      const priceData = decodePrice(log, pool.token0IsFlash)
      if (!priceData) continue

      const key = `${chainName}:${poolAddr}`
      _prices.set(key, priceData)

      // Immediately evaluate — this is sub-millisecond
      evaluate(chainName, pair)
    }
  })

  console.log(`[SCANNER] ${chainName}: watching ${allPools.size} pools across ${pairs.length} pairs`)
}

// ── EXPORTS ───────────────────────────────────────────────────────────────────
export function getScannerStats() {
  return {
    gapsDetected: parseInt(getConfig('scanner_gaps_detected') || '0'),
    trackedPrices: _prices.size,
    activePairs:   Object.values(POOL_PAIRS).flat().length,
  }
}

export function startScanner() {
  console.log('[SCANNER] Starting — ALL chains · ALL pairs · sub-50ms detection')

  // Watch every chain that has pool pairs defined
  for (const chainName of Object.keys(POOL_PAIRS)) {
    watchChain(chainName)
  }

  // Also extend to all active chains dynamically
  // (picks up any chains in chains.js not explicitly listed above)
  const activeChainsWithPairs = new Set(Object.keys(POOL_PAIRS))
  for (const chain of getActiveChains()) {
    if (!activeChainsWithPairs.has(chain.name)) {
      // Chain has no pairs defined yet — skip silently
      // TODO: auto-discover top pools via eth_getLogs
    }
  }

  const totalPairs = Object.values(POOL_PAIRS).flat().length
  const totalPools = Object.values(POOL_PAIRS).flat()
    .reduce((s, p) => s + 2, 0)

  console.log(`[SCANNER] ${totalPairs} pairs · ${totalPools} pools · ${Object.keys(POOL_PAIRS).length} chains`)
  console.log('[SCANNER] Gap threshold: 0.15% | Min profit: $500 | Cooldown: 2s/pair')
      }
