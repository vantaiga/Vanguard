// Vanguard · rs3.js — SUPER FILE
// Absorbs: rs3-yield.js
// Flash LP yield harvest on Curve + Balancer
// Also receives RS5 revenue broadcasts (RS5 → RS3 tab in dashboard)
// Pro-rated APY capture: flash $50M → hold 1 block → collect yield → exit

import { getConfig, setConfig } from './db.js'
import { emit, on }             from './events.js'
import { nexusRoute }           from './nexus.js'
import { getContractAddr }      from './builders.js'
import { rpcCall }              from './chains1.js'
import { getSABF64, SAB_OFFSETS } from './sdal.js'

const HOT = getSABF64()

// ═══════════════════════════════════════════════════════════════════════════
// PROTOCOL YIELD TARGETS
// Flash enter → collect pro-rated emission → flash exit
// All within one block — zero impermanent loss
// ═══════════════════════════════════════════════════════════════════════════

const YIELD_PROTOCOLS = {
  curve_3pool: {
    chain:    'ethereum',
    pool:     '0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7',
    gauge:    '0xbFcF63294aD7105dEa65aA58F8AE5BE2D9d0952A',
    apy:      12,   // % annual — updated dynamically
    tvl:      500e6,
    token:    'DAI',
  },
  curve_steth: {
    chain:    'ethereum',
    pool:     '0xDC24316b9AE028F1497c275EB9192a3Ea0f67022',
    gauge:    '0x182B723a58739a9c974cFDB385ceaDb237453c28',
    apy:      8,
    tvl:      200e6,
    token:    'stETH',
  },
  balancer_wsteth: {
    chain:    'ethereum',
    pool:     '0x32296969Ef14EB0c6d29669C550D4a0449130230',
    apy:      6,
    tvl:      300e6,
    token:    'wstETH',
  },
  aero_usdc_eth: {
    chain:    'base',
    pool:     '0x7f670f78B17dEC44d5Ef68a48D1a5B09C35B234E',
    apy:      15,   // Aerodrome has high emissions
    tvl:      80e6,
    token:    'USDC',
  },
  pcs_bnb_usdc: {
    chain:    'bnb',
    pool:     '0x36696169C63e42cd08ce11f5deeBbCeBae652050',
    apy:      20,   // PCS high emissions on BNB
    tvl:      180e6,
    token:    'USDC',
  },
}

// ═══════════════════════════════════════════════════════════════════════════
// REVENUE TRACKING
// RS5 broadcasts revenue here — RS3 tab shows combined RS3+RS5
// ═══════════════════════════════════════════════════════════════════════════

const _rs3 = {
  byProtocol: Object.fromEntries(Object.keys(YIELD_PROTOCOLS).map(k => [k, 0])),
  fromRS5:    0,
  total:      0,
}

// RS5 broadcasts its revenue to RS3 tab
on('rs3_update', ({ source, amount }) => {
  if (source === 'rs5') {
    _rs3.fromRS5 += amount || 0
    _rs3.total   += amount || 0
    setConfig('rs3_from_rs5', _rs3.fromRS5.toFixed(2))
    setConfig('rs3_total',    _rs3.total.toFixed(2))
  }
})

function recordYield(protocol, usd) {
  _rs3.byProtocol[protocol] = (_rs3.byProtocol[protocol] || 0) + usd
  _rs3.total += usd
  setConfig('rs3_' + protocol, _rs3.byProtocol[protocol].toFixed(2))
  setConfig('rs3_total', _rs3.total.toFixed(2))
  emit('rs3_revenue', { protocol, amount: usd })
}

// ═══════════════════════════════════════════════════════════════════════════
// FLASH LP HARVEST ENGINE
// Per-block yield formula:
//   dailyYield = TVL × APY / 365
//   blockYield = dailyYield / 7200 (ETH blocks)
//   profitEst  = blockYield × flashFraction
// ═══════════════════════════════════════════════════════════════════════════

async function harvestProtocol(key, proto) {
  if (getConfig('system_paused') === '1') return
  if (!getContractAddr(proto.chain)) return

  const propLevel = HOT[SAB_OFFSETS.PROPELLER] || 5
  const flashCap  = parseFloat(
    JSON.parse(getConfig('sdal_propeller_profiles') || '{}')[Math.round(propLevel)]?.flashCap
    || '20000000'
  )

  const flashAmt   = Math.min(proto.tvl * 0.01, flashCap * 0.1, 5e6)  // max 1% of pool, 10% of cap, $5M
  const dailyYield = flashAmt * (proto.apy / 100) / 365
  const blockYield = dailyYield / 7200
  const profitEst  = Math.floor(blockYield * 0.85)  // 85% capture after fees

  if (profitEst < 10) return

  nexusRoute({
    chain:         proto.chain,
    type:          'protocol_auction',
    profitEst,
    flashRequired: flashAmt,
    protocol:      key,
    chainId:       proto.chain === 'ethereum' ? 1 : proto.chain === 'base' ? 8453 : proto.chain === 'bnb' ? 56 : 1,
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// APY REFRESH — reads on-chain rates periodically
// ═══════════════════════════════════════════════════════════════════════════

async function refreshAPYs() {
  try {
    const r = await fetch('https://yields.llama.fi/pools', { signal: AbortSignal.timeout(8000) })
    if (!r.ok) return
    const { data } = await r.json()
    if (!Array.isArray(data)) return
    // Map known pools to their DeFiLlama entries
    const updates = {
      curve_3pool:   data.find(p => p.project === 'curve-dex' && p.symbol === '3Crv'),
      curve_steth:   data.find(p => p.project === 'curve-dex' && p.symbol?.includes('stETH')),
      balancer_wsteth:data.find(p => p.project === 'balancer-v2' && p.symbol?.includes('wstETH')),
    }
    for (const [key, entry] of Object.entries(updates)) {
      if (entry?.apy && YIELD_PROTOCOLS[key]) {
        YIELD_PROTOCOLS[key].apy = Math.max(0.1, Math.min(100, entry.apy))
      }
    }
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════════

export function getRS3Stats() {
  return {
    total:      _rs3.total,
    fromRS5:    _rs3.fromRS5,
    byProtocol: { ..._rs3.byProtocol },
    protocols:  Object.entries(YIELD_PROTOCOLS).map(([k, p]) => ({
      key: k, chain: p.chain, apy: p.apy, tvl: p.tvl
    })),
    note: 'RS3 tab shows: flash LP yield + RS5 SLP broadcasts combined',
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════════════

export function startRS3Yield() {
  // Restore totals
  _rs3.fromRS5 = parseFloat(getConfig('rs3_from_rs5') || '0')
  _rs3.total   = parseFloat(getConfig('rs3_total')    || '0')
  for (const key of Object.keys(YIELD_PROTOCOLS)) {
    _rs3.byProtocol[key] = parseFloat(getConfig('rs3_' + key) || '0')
  }

  // Harvest every ETH block (~12s)
  setInterval(async () => {
    for (const [key, proto] of Object.entries(YIELD_PROTOCOLS)) {
      await harvestProtocol(key, proto).catch(() => {})
    }
  }, 12000)

  // Refresh APYs every hour
  setInterval(() => refreshAPYs().catch(() => {}), 3600000)
  refreshAPYs().catch(() => {})

  // Persist stats every 30s
  setInterval(() => setConfig('rs3_stats', JSON.stringify(getRS3Stats())), 30000)

  console.log('[RS3] Flash LP yield harvest: Curve + Balancer + Aerodrome + PancakeSwap')
  console.log('[RS3] RS5 revenue broadcasts → RS3 tab (combined display)')
  console.log(`[RS3] ${Object.keys(YIELD_PROTOCOLS).length} yield protocols monitored`)
}
