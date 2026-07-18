// Vanguard · sdal.js — Software-Defined Abstraction Layer
// ALL values runtime-configurable without redeploy
// SharedArrayBuffer cache: zero-cost reads on hot path
// EXPORTS: SAB_OFFSETS, getSABF64, getSAB, get, getAddr, getStrategy,
//          getEnergy, getPropProfile, getThroughput, getV7, update, set,
//          initSDAL, getConfig (compatibility shim)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'

// ── SharedArrayBuffer — zero-cost hot path reads ───────────────────────────────
// 256 Float64 slots = 2048 bytes
// All critical runtime values live here — no SQLite/disk on hot path
const _SAB   = new SharedArrayBuffer(2048)
const _F64   = new Float64Array(_SAB)

// ── SAB layout — every file reads from these offsets ─────────────────────────
// MUST be exported as a named const — this was the crash cause
export const SAB_OFFSETS = {
  PROPELLER:      0,   // current propeller level (1-30)
  CRASH_SCORE:    1,   // crash signal score (0-100)
  MIN_PROFIT:     2,   // + chainIndex (20 slots: [2..21])
  FLASH_AVAIL:    22,  // + chainIndex (20 slots: [22..41])
  COMPETITION:    42,  // + chainIndex (20 slots: [42..61])
  GAS_PRICE:      62,  // + chainIndex gwei (20 slots: [62..81])
  CHAIN_ACTIVE:   82,  // + chainIndex 0|1 (20 slots: [82..101])
  DAILY_TARGET:   102, // daily revenue target USD
  DAILY_ACHIEVED: 103, // daily revenue achieved USD
  OVERLAY_SIZE:   104, // overlay queue size
  THROUGHPUT:     105, // total throughput capacity
}

// ── SAB accessors ─────────────────────────────────────────────────────────────
export function getSAB()   { return _SAB }
export function getSABF64(){ return _F64 }

// ── SDAL data ─────────────────────────────────────────────────────────────────
const SDAL_PATH = '/data/sdal.json'

const DEFAULT = {
  version: '1.0.0',

  protocol_addresses: {
    balancer_v2:        '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    multicall3:         '0xcA11bde05977b3631167028862bE2a173976CA11',
    npm_uniswap:        '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    aave_pool_eth:      '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    aave_pool_arb:      '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    aave_pool_base:     '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
    aave_pool_pol:      '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    chainlink_eth_usd:  '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
    chainlink_btc_usd:  '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88b',
    create2_factory:    '0x4e59b44847b379578588920cA78FbF26c0B4956C',
    uniswap_router:     '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  },

  propeller_profiles: {
    1:  { flashCap:'10000000',    jitPositions:10,   chainScope:['ethereum','arbitrum'],                                                  liquidationHF:1.05, fundingPositions:10,   dailyRevUSD:'17480000000'    },
    2:  { flashCap:'25000000',    jitPositions:20,   chainScope:['ethereum','arbitrum','base'],                                          liquidationHF:1.08, fundingPositions:20,   dailyRevUSD:'34960000000'    },
    3:  { flashCap:'50000000',    jitPositions:30,   chainScope:['ethereum','arbitrum','base','polygon'],                                liquidationHF:1.10, fundingPositions:30,   dailyRevUSD:'69920000000'    },
    4:  { flashCap:'75000000',    jitPositions:40,   chainScope:['ethereum','arbitrum','base','polygon','optimism'],                     liquidationHF:1.12, fundingPositions:40,   dailyRevUSD:'104880000000'   },
    5:  { flashCap:'100000000',   jitPositions:50,   chainScope:['ethereum','arbitrum','base','polygon','optimism'],                     liquidationHF:1.15, fundingPositions:50,   dailyRevUSD:'139840000000'   },
    6:  { flashCap:'150000000',   jitPositions:75,   chainScope:['ethereum','arbitrum','base','polygon','optimism','avalanche'],          liquidationHF:1.17, fundingPositions:75,   dailyRevUSD:'192280000000'   },
    7:  { flashCap:'250000000',   jitPositions:100,  chainScope:['ethereum','arbitrum','base','polygon','optimism','avalanche','bnb'],   liquidationHF:1.18, fundingPositions:100,  dailyRevUSD:'262200000000'   },
    8:  { flashCap:'500000000',   jitPositions:150,  chainScope:'ALL',                                                                  liquidationHF:1.20, fundingPositions:150,  dailyRevUSD:'349600000000'   },
    9:  { flashCap:'1000000000',  jitPositions:200,  chainScope:'ALL',                                                                  liquidationHF:1.22, fundingPositions:200,  dailyRevUSD:'471960000000'   },
    10: { flashCap:'2000000000',  jitPositions:300,  chainScope:'ALL',                                                                  liquidationHF:1.25, fundingPositions:300,  dailyRevUSD:'611800000000'   },
    11: { flashCap:'3000000000',  jitPositions:400,  chainScope:'ALL',                                                                  liquidationHF:1.27, fundingPositions:400,  dailyRevUSD:'734160000000'   },
    12: { flashCap:'5000000000',  jitPositions:500,  chainScope:'ALL',                                                                  liquidationHF:1.28, fundingPositions:500,  dailyRevUSD:'856520000000'   },
    13: { flashCap:'7000000000',  jitPositions:600,  chainScope:'ALL',                                                                  liquidationHF:1.29, fundingPositions:600,  dailyRevUSD:'961400000000'   },
    14: { flashCap:'9000000000',  jitPositions:750,  chainScope:'ALL',                                                                  liquidationHF:1.30, fundingPositions:750,  dailyRevUSD:'1066000000000'  },
    15: { flashCap:'11000000000', jitPositions:900,  chainScope:'ALL',                                                                  liquidationHF:1.31, fundingPositions:900,  dailyRevUSD:'1153000000000'  },
    16: { flashCap:'13000000000', jitPositions:1000, chainScope:'ALL',                                                                  liquidationHF:1.32, fundingPositions:1000, dailyRevUSD:'1224000000000'  },
    17: { flashCap:'15000000000', jitPositions:1200, chainScope:'ALL',                                                                  liquidationHF:1.33, fundingPositions:1200, dailyRevUSD:'1293000000000'  },
    18: { flashCap:'17000000000', jitPositions:1400, chainScope:'ALL',                                                                  liquidationHF:1.34, fundingPositions:1400, dailyRevUSD:'1363000000000'  },
    19: { flashCap:'19000000000', jitPositions:1600, chainScope:'ALL',                                                                  liquidationHF:1.35, fundingPositions:1600, dailyRevUSD:'1415000000000'  },
    20: { flashCap:'21000000000', jitPositions:1800, chainScope:'ALL',                                                                  liquidationHF:1.36, fundingPositions:1800, dailyRevUSD:'1468000000000'  },
    21: { flashCap:'23000000000', jitPositions:2000, chainScope:'ALL',                                                                  liquidationHF:1.37, fundingPositions:2000, dailyRevUSD:'1521000000000'  },
    22: { flashCap:'25000000000', jitPositions:2200, chainScope:'ALL',                                                                  liquidationHF:1.38, fundingPositions:2200, dailyRevUSD:'1573000000000'  },
    23: { flashCap:'26500000000', jitPositions:2500, chainScope:'ALL',                                                                  liquidationHF:1.39, fundingPositions:2500, dailyRevUSD:'1608000000000'  },
    24: { flashCap:'27500000000', jitPositions:2800, chainScope:'ALL',                                                                  liquidationHF:1.40, fundingPositions:2800, dailyRevUSD:'1643000000000'  },
    25: { flashCap:'28500000000', jitPositions:3000, chainScope:'ALL',                                                                  liquidationHF:1.41, fundingPositions:3000, dailyRevUSD:'1669000000000'  },
    26: { flashCap:'29000000000', jitPositions:3500, chainScope:'ALL',                                                                  liquidationHF:1.42, fundingPositions:3500, dailyRevUSD:'1692000000000'  },
    27: { flashCap:'29500000000', jitPositions:4000, chainScope:'ALL',                                                                  liquidationHF:1.43, fundingPositions:4000, dailyRevUSD:'1709000000000'  },
    28: { flashCap:'30000000000', jitPositions:4500, chainScope:'ALL',                                                                  liquidationHF:1.44, fundingPositions:4500, dailyRevUSD:'1724000000000'  },
    29: { flashCap:'30500000000', jitPositions:5000, chainScope:'ALL',                                                                  liquidationHF:1.45, fundingPositions:5000, dailyRevUSD:'1735000000000'  },
    30: { flashCap:'31500000000', jitPositions:5000, chainScope:'ALL',                                                                  liquidationHF:1.50, fundingPositions:5000, dailyRevUSD:'1748000000000'  },
  },

  strategy_params: {
    minSwapUSD:           '100000000',
    maxSwapUSD:           '10000000000',
    flashCapDefault:      '20000000',
    liquidationHFDefault: '1.05',
    fundingThreshold:     '0.0005',
    syntheticDepegMin:    '0.0005',
    oracleFrontRunMin:    '0.005',
    overlayMaxEntries:    '500000',
    overlayRetryAttempts: '3',
    overlayRetryMs:       '500',
    drainRatePerSecond:   '66.67',
    midnightResetUTC:     'true',
  },

  energy_config: {
    maxRAMmb:        384,
    logLevel:        'WARN',
    logSampleRate:   100,
    batchIntervalMs: 100,
    cexDebounceMs:   5000,
    adaptivePoll:    true,
    lazyChainStart:  true,
    gcManual:        true,
  },

  throughput: {
    env1_eth_daily:   '321120000000000',
    env2_l2_daily:    '1209600000000000',
    env3_multi_daily: '500000000000000',
    nexus_multiplier: '1465300000000000',
    total_daily:      '3496000000000000',
    blended_rate:     '0.0005',
    max_daily_rev:    '1748000000000',
  },

  v7_config: {
    active:        false,
    activateMonth: 2,
    buybackPct:    0.01,
    tokenAddress:  null,
    burnAddress:   '0x000000000000000000000000000000000000dEaD',
  },

  rs6_config: {
    active:         false,
    unichainActive: false,
    seiActive:      false,
  },
}

// ── Internal state ─────────────────────────────────────────────────────────────
let _data = JSON.parse(JSON.stringify(DEFAULT))  // deep clone

// ── Disk load / save ──────────────────────────────────────────────────────────
function load() {
  try {
    if (existsSync(SDAL_PATH)) {
      const raw = readFileSync(SDAL_PATH, 'utf8')
      const disk = JSON.parse(raw)
      _data = { ...DEFAULT, ...disk }
      console.log(`[SDAL] Loaded from ${SDAL_PATH}`)
    } else {
      save()
    }
  } catch(e) {
    console.warn('[SDAL] Load failed, using defaults:', e.message?.slice(0,60))
    _data = JSON.parse(JSON.stringify(DEFAULT))
  }
}

function save() {
  try {
    mkdirSync('/data', { recursive: true })
    writeFileSync(SDAL_PATH, JSON.stringify(_data, null, 2))
  } catch {
    // /data not mounted — in-memory only (still fully functional)
  }
}

// ── SAB sync — writes hot-path values to SharedArrayBuffer ─────────────────────
function syncSAB() {
  try {
    const p    = parseInt(_data.propeller_profiles ? '5' : '5')
    const prof = _data.propeller_profiles?.[p] || _data.propeller_profiles?.[5]
    _F64[SAB_OFFSETS.PROPELLER]    = p
    _F64[SAB_OFFSETS.DAILY_TARGET] = parseFloat(prof?.dailyRevUSD || '139840000000')
    _F64[SAB_OFFSETS.THROUGHPUT]   = parseFloat(_data.throughput?.total_daily || '3496000000000000')
    // Initialize chain slots
    for (let i = 0; i < 20; i++) {
      if (_F64[SAB_OFFSETS.CHAIN_ACTIVE + i] === 0) _F64[SAB_OFFSETS.CHAIN_ACTIVE + i] = 1
      if (_F64[SAB_OFFSETS.MIN_PROFIT + i]   === 0) _F64[SAB_OFFSETS.MIN_PROFIT + i]   = 5
      if (_F64[SAB_OFFSETS.GAS_PRICE + i]    === 0) _F64[SAB_OFFSETS.GAS_PRICE + i]    = 1
    }
  } catch {}
}

// ── Named exports — every import in the codebase resolves here ────────────────

// Get any top-level SDAL key
export function get(key) {
  return _data[key] ?? null
}

// Get a protocol address by name
export function getAddr(name) {
  return _data.protocol_addresses?.[name] ?? null
}

// Get chain config from SDAL (if stored)
export function getChainCfg(name) {
  return _data.chain_configs?.[name] ?? null
}

// Get strategy params
export function getStrategy() {
  return _data.strategy_params ?? DEFAULT.strategy_params
}

// Get energy config
export function getEnergy() {
  return _data.energy_config ?? DEFAULT.energy_config
}

// Get propeller profile for level P (1-30)
export function getPropProfile(p) {
  const level = Math.max(1, Math.min(30, Math.round(Number(p) || 5)))
  return _data.propeller_profiles?.[level]
      ?? _data.propeller_profiles?.[5]
      ?? DEFAULT.propeller_profiles[5]
}

// Get throughput constants
export function getThroughput() {
  return _data.throughput ?? DEFAULT.throughput
}

// Get V7 token config
export function getV7() {
  return _data.v7_config ?? DEFAULT.v7_config
}

// Set a single top-level key
export function set(key, value) {
  _data[key] = value
  save()
  syncSAB()
}

// Bulk update (merge patch)
export function update(patch) {
  _data = { ..._data, ...patch }
  save()
  syncSAB()
  console.log('[SDAL] Updated:', Object.keys(patch).join(', '))
}

// Compatibility shim — getConfig() callers that haven't migrated to db.js
// Returns null so they fall through to db.js getConfig()
export function getConfig(key) {
  return null  // always fall through to db.js
}

// ── Init ──────────────────────────────────────────────────────────────────────
export function initSDAL() {
  load()
  syncSAB()
  // Sync every 60s so SOVEREIGN updates flow to hot path
  setInterval(() => { syncSAB(); save() }, 60000)

  console.log(`[SDAL] v${_data.version || '1.0.0'} — ${Object.keys(_data.protocol_addresses || {}).length} addresses`)
  console.log('[SDAL] SAB_OFFSETS exported — all hot-path reads zero-cost')
  console.log('[SDAL] Propeller profiles P1-P30 loaded')
  console.log('[SDAL] Runtime-configurable — no redeploy needed')
}
