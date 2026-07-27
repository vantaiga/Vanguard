// Vanguard · vanguard.js — THE SOUL
// Zero overlay. Zero heap. Zero memory problem.
// Swap detected → NEXUS → APEX → execution. Instant.
// Static imports: NOTHING

import { EventEmitter }                                       from 'events'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname }                                            from 'path'

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — SHARED ARRAY BUFFER (zero-cost hot-path reads)
// ═══════════════════════════════════════════════════════════════════════════
const _SAB = new SharedArrayBuffer(2048)
const _F64 = new Float64Array(_SAB)

export const SAB_OFFSETS = {
  PROPELLER:       0,
  CRASH_SCORE:     1,
  MIN_PROFIT:      2,   // +chainIdx (20 slots: [2..21])
  FLASH_AVAIL:    22,   // +chainIdx (20 slots: [22..41])
  COMPETITION:    42,   // +chainIdx (20 slots: [42..61])
  GAS_PRICE:      62,   // +chainIdx (20 slots: [62..81])
  CHAIN_ACTIVE:   82,   // +chainIdx (20 slots: [82..101])
  DAILY_TARGET:  102,
  DAILY_ACHIEVED:103,
  THROUGHPUT:    104,
  CRASH_MODE:    105,
  LP_TOTAL:      106,
  EXEC_COUNT:    107,
  HOUR_REVENUE:  108,
}

export const NONCE_SAB = new SharedArrayBuffer(80)
export const NONCE_I32 = new Int32Array(NONCE_SAB)

export function getSABF64() { return _F64 }
export function getSAB()    { return _SAB }

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — EVENT BUS
// ═══════════════════════════════════════════════════════════════════════════
const _bus = new EventEmitter()
_bus.setMaxListeners(2000)

export const emit          = (ev, d)  => { try { _bus.emit(ev, d) }  catch {} }
export const on            = (ev, fn) => { _bus.on(ev, fn); return () => _bus.off(ev, fn) }
export const off           = (ev, fn) => _bus.off(ev, fn)
export const once          = (ev, fn) => _bus.once(ev, fn)

export const EVENTS = {
  MEGA_SWAP:            'mega_swap',
  CHAIN_FUNDED:         'chain_funded',
  DEPLOY_SUCCESS:       'deploy_success',
  DEPLOY_FAILED:        'deploy_failed',
  NEXUS_DECISION:       'nexus_decision',
  APEX_SUCCESS:         'apex_success',
  APEX_FAILED:          'apex_failed',
  RS5_REVENUE:          'rs5_revenue',
  RS3_UPDATE:           'rs3_update',
  LIQUIDATION_DETECTED: 'liquidation_detected',
  ORACLE_PENDING:       'oracle_pending',
  DEPEG_DETECTED:       'depeg_detected',
  FUNDING_OPPORTUNITY:  'funding_opportunity',
  XCHAIN_DISLOCATION:   'xchain_dislocation',
  ARB_OPPORTUNITY:      'arb_opportunity',
  SYSTEM_HALT:          'system_halt',
  SYSTEM_RESUME:        'system_resume',
  EMERGENCY_HALT:       'emergency_halt',
  PROPELLER_CHANGED:    'propeller_changed',
  PROPELLER_CEILING:    'propeller_ceiling_reached',
  CRASH_MODE_ON:        'crash_mode_activated',
  CRASH_MODE_OFF:       'crash_mode_off',
  CEX_PRICE:            'cex_price',
  SV_UPDATE:            'sv_update',
  WITHDRAWAL_CREATED:   'withdrawal_created',
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — IN-MEMORY CONFIG STORE + PERSISTENCE
// Two layers: local JSON + db.js volume
// ═══════════════════════════════════════════════════════════════════════════
const _cfg   = new Map()
const _execs = []          // ring buffer — max 1,000 entries
let   _cfgDirty  = false
let   _execDirty = false
let   _dbRef     = null

const DATA_DIR = '/data'
const CFG_PATH = `${DATA_DIR}/vanguard_cfg.json`

function localSaveCfg() {
  if (!_cfgDirty) return
  _cfgDirty = false
  try {
    mkdirSync(DATA_DIR, { recursive:true })
    writeFileSync(CFG_PATH, JSON.stringify(Object.fromEntries(_cfg)), 'utf8')
  } catch {}
}

function localLoadCfg() {
  try {
    if (!existsSync(CFG_PATH)) return
    const obj = JSON.parse(readFileSync(CFG_PATH, 'utf8'))
    for (const [k, v] of Object.entries(obj)) _cfg.set(k, String(v))
  } catch {}
}

export function getConfig(key)      { return _cfg.get(key) ?? null }
export function setConfig(key, val) { _cfg.set(key, String(val)); _cfgDirty = true }
export function delConfig(key)      { _cfg.delete(key); _cfgDirty = true }
export function _getConfigMap()     { return _cfg }
export function _getExecs()         { return _execs }
export function setDBRef(db)        { _dbRef = db }

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4 — EXECUTION TRACKING
// ═══════════════════════════════════════════════════════════════════════════
export function recordExecution({ txHash, chain, protocol, profitUsdc, gasUsed, status }) {
  const entry = {
    txHash:      txHash      ?? '',
    chain:       chain       ?? '',
    protocol:    protocol    ?? '',
    profit_usdc: profitUsdc  ?? 0,
    gas_used:    gasUsed     ?? 0,
    status:      status      ?? 'pending',
    ts:          Math.floor(Date.now() / 1000),
  }
  _execs.push(entry)
  if (_execs.length > 1000) _execs.shift()
  _execDirty = true

  const prev  = parseFloat(getConfig('all_time_profit') ?? '0')
  const count = parseInt(getConfig('total_executions')   ?? '0')
  setConfig('all_time_profit',  (prev + (profitUsdc ?? 0)).toFixed(2))
  setConfig('total_executions', String(count + 1))
  _F64[SAB_OFFSETS.EXEC_COUNT] = count + 1

  if (status === 'success') {
    const wins = parseInt(getConfig('total_wins') ?? '0')
    setConfig('total_wins', String(wins + 1))
    const tot = count + 1, win = wins + 1
    if (tot > 0) setConfig('win_rate', ((win/tot)*100).toFixed(1) + '%')
  }
}

export function getExecutions(limit = 50, chain = null) {
  let result = [..._execs].reverse()
  if (chain) result = result.filter(e => e.chain === chain)
  return result.slice(0, Math.min(limit, 1000))
}

export function getStats() {
  return {
    profit:     parseFloat(getConfig('all_time_profit')  ?? '0'),
    executions: parseInt(getConfig('total_executions')   ?? '0'),
    wins:       parseInt(getConfig('total_wins')         ?? '0'),
    winRate:    getConfig('win_rate')                    ?? '0%',
    lp:         parseFloat(getConfig('lp_total')         ?? '0'),
    today:      parseFloat(getConfig('daily_achieved')   ?? '0'),
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5 — SDAL
// ═══════════════════════════════════════════════════════════════════════════
const SDAL_PATH = `${DATA_DIR}/sdal.json`

export const RTABLE = {
  1:17480000000,   2:34960000000,   3:69920000000,   4:104880000000,
  5:139840000000,  6:192280000000,  7:262200000000,  8:349600000000,
  9:471960000000,  10:611800000000, 11:734160000000, 12:856520000000,
  13:961400000000, 14:1066000000000,15:1153000000000,16:1224000000000,
  17:1293000000000,18:1363000000000,19:1415000000000,20:1468000000000,
  21:1521000000000,22:1573000000000,23:1608000000000,24:1643000000000,
  25:1669000000000,26:1692000000000,27:1709000000000,28:1724000000000,
  29:1735000000000,30:1748000000000,
}

const SDAL_DEFAULT = {
  version: '1.0.0',
  protocol_addresses: {
    balancer_v2:       '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    multicall3:        '0xcA11bde05977b3631167028862bE2a173976CA11',
    aave_pool_eth:     '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    aave_pool_arb:     '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    aave_pool_base:    '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
    aave_pool_pol:     '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    chainlink_eth_usd: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
    chainlink_btc_usd: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88b',
    create2_factory:   '0x4e59b44847b379578588920cA78FbF26c0B4956C',
    burn_address:      '0x000000000000000000000000000000000000dEaD',
  },
  propeller_profiles: {
    1:  {flashCap:'10000000',   jitPositions:10,   liquidationHF:1.05, fundingPositions:10,   dailyRevUSD:'17480000000'  },
    2:  {flashCap:'25000000',   jitPositions:20,   liquidationHF:1.08, fundingPositions:20,   dailyRevUSD:'34960000000'  },
    3:  {flashCap:'50000000',   jitPositions:30,   liquidationHF:1.10, fundingPositions:30,   dailyRevUSD:'69920000000'  },
    4:  {flashCap:'75000000',   jitPositions:40,   liquidationHF:1.12, fundingPositions:40,   dailyRevUSD:'104880000000' },
    5:  {flashCap:'100000000',  jitPositions:50,   liquidationHF:1.15, fundingPositions:50,   dailyRevUSD:'139840000000' },
    6:  {flashCap:'150000000',  jitPositions:75,   liquidationHF:1.17, fundingPositions:75,   dailyRevUSD:'192280000000' },
    7:  {flashCap:'250000000',  jitPositions:100,  liquidationHF:1.18, fundingPositions:100,  dailyRevUSD:'262200000000' },
    8:  {flashCap:'500000000',  jitPositions:150,  liquidationHF:1.20, fundingPositions:150,  dailyRevUSD:'349600000000' },
    9:  {flashCap:'1000000000', jitPositions:200,  liquidationHF:1.22, fundingPositions:200,  dailyRevUSD:'471960000000' },
    10: {flashCap:'2000000000', jitPositions:300,  liquidationHF:1.25, fundingPositions:300,  dailyRevUSD:'611800000000' },
    11: {flashCap:'3000000000', jitPositions:400,  liquidationHF:1.27, fundingPositions:400,  dailyRevUSD:'734160000000' },
    12: {flashCap:'5000000000', jitPositions:500,  liquidationHF:1.28, fundingPositions:500,  dailyRevUSD:'856520000000' },
    13: {flashCap:'7000000000', jitPositions:600,  liquidationHF:1.29, fundingPositions:600,  dailyRevUSD:'961400000000' },
    14: {flashCap:'9000000000', jitPositions:750,  liquidationHF:1.30, fundingPositions:750,  dailyRevUSD:'1066000000000'},
    15: {flashCap:'11000000000',jitPositions:900,  liquidationHF:1.31, fundingPositions:900,  dailyRevUSD:'1153000000000'},
    16: {flashCap:'13000000000',jitPositions:1000, liquidationHF:1.32, fundingPositions:1000, dailyRevUSD:'1224000000000'},
    17: {flashCap:'15000000000',jitPositions:1200, liquidationHF:1.33, fundingPositions:1200, dailyRevUSD:'1293000000000'},
    18: {flashCap:'17000000000',jitPositions:1400, liquidationHF:1.34, fundingPositions:1400, dailyRevUSD:'1363000000000'},
    19: {flashCap:'19000000000',jitPositions:1600, liquidationHF:1.35, fundingPositions:1600, dailyRevUSD:'1415000000000'},
    20: {flashCap:'21000000000',jitPositions:1800, liquidationHF:1.36, fundingPositions:1800, dailyRevUSD:'1468000000000'},
    21: {flashCap:'23000000000',jitPositions:2000, liquidationHF:1.37, fundingPositions:2000, dailyRevUSD:'1521000000000'},
    22: {flashCap:'25000000000',jitPositions:2200, liquidationHF:1.38, fundingPositions:2200, dailyRevUSD:'1573000000000'},
    23: {flashCap:'26500000000',jitPositions:2500, liquidationHF:1.39, fundingPositions:2500, dailyRevUSD:'1608000000000'},
    24: {flashCap:'27500000000',jitPositions:2800, liquidationHF:1.40, fundingPositions:2800, dailyRevUSD:'1643000000000'},
    25: {flashCap:'28500000000',jitPositions:3000, liquidationHF:1.41, fundingPositions:3000, dailyRevUSD:'1669000000000'},
    26: {flashCap:'29000000000',jitPositions:3500, liquidationHF:1.42, fundingPositions:3500, dailyRevUSD:'1692000000000'},
    27: {flashCap:'29500000000',jitPositions:4000, liquidationHF:1.43, fundingPositions:4000, dailyRevUSD:'1709000000000'},
    28: {flashCap:'30000000000',jitPositions:4500, liquidationHF:1.44, fundingPositions:4500, dailyRevUSD:'1724000000000'},
    29: {flashCap:'30500000000',jitPositions:5000, liquidationHF:1.45, fundingPositions:5000, dailyRevUSD:'1735000000000'},
    30: {flashCap:'31500000000',jitPositions:5000, liquidationHF:1.50, fundingPositions:5000, dailyRevUSD:'1748000000000'},
  },
  throughput: {
    total_daily:   '3496000000000000',
    blended_rate:  '0.0005',
    max_daily_rev: '1748000000000',
    flash_per_exec:'48600000000',
  },
  v7_config:  { active:false, buybackPct:0.01, tokenAddress:null },
  rs6_config: { active:false },
}

let _sdal = JSON.parse(JSON.stringify(SDAL_DEFAULT))

function loadSDAL() {
  try {
    if (existsSync(SDAL_PATH)) {
      const disk = JSON.parse(readFileSync(SDAL_PATH, 'utf8'))
      _sdal = {
        ...SDAL_DEFAULT, ...disk,
        protocol_addresses: { ...SDAL_DEFAULT.protocol_addresses, ...(disk.protocol_addresses??{}) },
        propeller_profiles: { ...SDAL_DEFAULT.propeller_profiles, ...(disk.propeller_profiles??{}) },
      }
    } else {
      mkdirSync(DATA_DIR, { recursive:true })
      writeFileSync(SDAL_PATH, JSON.stringify(_sdal, null, 2), 'utf8')
    }
  } catch { _sdal = JSON.parse(JSON.stringify(SDAL_DEFAULT)) }
}

export function sdalGet(key)      { return _sdal[key] ?? null }
export function sdalGetAddr(name) { return _sdal.protocol_addresses?.[name] ?? null }
export function sdalUpdate(patch) {
  _sdal = { ..._sdal, ...patch }
  try { writeFileSync(SDAL_PATH, JSON.stringify(_sdal, null, 2), 'utf8') } catch {}
  syncSAB()
}

export function getPropProfile(p) {
  const level = Math.max(1, Math.min(30, Math.round(Number(p) ?? 5)))
  return _sdal.propeller_profiles?.[level] ?? SDAL_DEFAULT.propeller_profiles[5]
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 6 — SAB SYNC
// ═══════════════════════════════════════════════════════════════════════════
export function syncSAB() {
  try {
    const p = parseInt(getConfig('prop_intensity') ?? '5')
    const prof = getPropProfile(p)
    _F64[SAB_OFFSETS.PROPELLER]    = p
    _F64[SAB_OFFSETS.DAILY_TARGET] = parseFloat(prof?.dailyRevUSD ?? '139840000000')
    _F64[SAB_OFFSETS.THROUGHPUT]   = parseFloat(_sdal.throughput?.total_daily ?? '3496000000000000')
    _F64[SAB_OFFSETS.CRASH_MODE]   = getConfig('crash_mode') === '1' ? 1 : 0
    for (let i = 0; i < 20; i++) {
      if (!_F64[SAB_OFFSETS.CHAIN_ACTIVE + i]) _F64[SAB_OFFSETS.CHAIN_ACTIVE + i] = 1
      if (!_F64[SAB_OFFSETS.MIN_PROFIT   + i]) _F64[SAB_OFFSETS.MIN_PROFIT   + i] = 5
      if (!_F64[SAB_OFFSETS.GAS_PRICE    + i]) _F64[SAB_OFFSETS.GAS_PRICE    + i] = 1
    }
    const da = parseFloat(getConfig('daily_achieved') ?? '0')
    if (da > 0) _F64[SAB_OFFSETS.DAILY_ACHIEVED] = da
    _F64[SAB_OFFSETS.LP_TOTAL]    = parseFloat(getConfig('lp_total') ?? '0')
    _F64[SAB_OFFSETS.EXEC_COUNT]  = parseInt(getConfig('total_executions') ?? '0')
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 7 — CHAIN INDEX MAP
// ═══════════════════════════════════════════════════════════════════════════
export const CHAIN_ORDER = [
  'ethereum','arbitrum','base','polygon','optimism','avalanche',
  'bnb','blast','linea','scroll','zksync','gnosis','mantle',
  'sonic','berachain','sei','unichain','worldchain','metis','mode',
]

export const CHAIN_IDX = new Map()
CHAIN_ORDER.forEach((name, i) => CHAIN_IDX.set(name, i))

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 8 — FORMAT HELPERS
// ═══════════════════════════════════════════════════════════════════════════
export function fmtRev(n) {
  if (!n || n === 0) return '$0.00'
  if (n >= 1e15) return '$' + (n/1e15).toFixed(3) + 'Q'
  if (n >= 1e12) return '$' + (n/1e12).toFixed(3) + 'T'
  if (n >= 1e9)  return '$' + (n/1e9).toFixed(2)  + 'B'
  if (n >= 1e6)  return '$' + (n/1e6).toFixed(2)  + 'M'
  if (n >= 1e3)  return '$' + (n/1e3).toFixed(1)  + 'K'
  return '$' + n.toFixed(2)
}

export function fmtPct(num, den) {
  if (!den || den === 0) return '0%'
  return ((num/den)*100).toFixed(1) + '%'
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 9 — DB.JS VOLUME WIRING
// ═══════════════════════════════════════════════════════════════════════════
export function mergeVolumeCfg(savedMap) {
  if (!(savedMap instanceof Map)) return 0
  let n = 0
  for (const [k, v] of savedMap) {
    if (!_cfg.has(k)) { _cfg.set(k, String(v)); n++ }
  }
  return n
}

export function mergeVolumeExecs(savedExecs) {
  if (!Array.isArray(savedExecs) || !savedExecs.length) return 0
  const existing = new Set(_execs.map(e => (e.txHash??'')+'_'+(e.ts??0)))
  let n = 0
  for (const e of savedExecs) {
    const key = (e.txHash??'')+'_'+(e.ts??0)
    if (!existing.has(key)) { _execs.push(e); n++ }
  }
  if (_execs.length > 1000) _execs.splice(0, _execs.length - 1000)
  return n
}

function persistToVolume() {
  if (!_dbRef) return
  try {
    _dbRef.saveConfig(_cfg)
    _dbRef.saveExecs(_execs)
    _dbRef.saveRevenue({
      allTime:    parseFloat(_cfg.get('all_time_profit') ?? '0'),
      lp:         parseFloat(_cfg.get('lp_total')        ?? '0'),
      today:      parseFloat(_cfg.get('daily_achieved')  ?? '0'),
      executions: parseInt(_cfg.get('total_executions')  ?? '0'),
      wins:       parseInt(_cfg.get('total_wins')        ?? '0'),
    })
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 10 — INIT
// ═══════════════════════════════════════════════════════════════════════════
export function initVanguard() {
  localLoadCfg()
  loadSDAL()
  syncSAB()

  setInterval(localSaveCfg,     10_000)
  setInterval(persistToVolume,  30_000)
  setInterval(syncSAB,          60_000)

  console.log(`[VANGUARD] Soul initialized — v${_sdal.version}`)
  console.log(`[VANGUARD] ${Object.keys(_sdal.protocol_addresses).length} addresses · P1-P30 loaded`)
  console.log('[VANGUARD] SAB ready · Config loaded · Events ready · NO OVERLAY')
}

process.on('SIGTERM', () => { localSaveCfg(); persistToVolume() })
process.on('exit',    () => { localSaveCfg() })
