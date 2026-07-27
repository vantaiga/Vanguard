// Vanguard · db.js — DATABASE + MEMORY GOVERNOR
// Pure Node.js fs + JSON. Zero native deps. Zero node-gyp. Zero Python.
// Railway free tier compatible — no compilation, no binary addons.
//
// MEMORY THRESHOLDS (from deep dive — lowered aggressively):
//   HEAP_GC_MB   = 140  (was 200) — GC fires much earlier
//   HEAP_WARN_MB = 180  (was 260) — warn earlier
//   HEAP_CRIT_MB = 240  (was 290) — skip writes earlier
//   Governor interval = 15s (was 30s) — twice as frequent
//   saveOverlay skip threshold = HEAP_WARN_MB (was HEAP_CRIT_MB)
//
// OVERLAY FIX:
//   Per-chain shard writes (18 × ~0.1MB vs 1 × 35MB)
//   GC fired BEFORE each write, not after
//   OVERLAY_RAM_CAP = 25,000 (intelligence.js uses RAM_CAP=15K — db.js cap is safety net)

import {
  readFileSync, writeFileSync, existsSync,
  mkdirSync, statSync, appendFileSync,
} from 'fs'
import { join }        from 'path'
import { performance } from 'perf_hooks'

const MB = 1024 * 1024

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — VOLUME DETECTION
// ═══════════════════════════════════════════════════════════════════════════
let _root     = '/data'
let _mounted  = false
let _writable = false

function detectVolume() {
  const candidates = ['/data', '/mnt/data', '/tmp/vanguard_data']
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive:true })
      const test = join(dir, '.ping')
      writeFileSync(test, String(Date.now()), 'utf8')
      if (existsSync(test)) {
        _root     = dir
        _mounted  = dir === '/data' || dir === '/mnt/data'
        _writable = true
        return true
      }
    } catch {}
  }
  _root = '/tmp/vanguard_data'
  try { mkdirSync(_root, { recursive:true }) } catch {}
  _writable = false
  return false
}

const f = (name) => join(_root, name)

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — MEMORY GOVERNOR
// Thresholds lowered from deep dive analysis.
// Governor runs every 15s (was 30s).
// GC fires at 140MB — 80MB before hard cap.
// ═══════════════════════════════════════════════════════════════════════════
const HEAP_GC_MB   = 140   // was 200 — fire GC 80MB earlier
const HEAP_WARN_MB = 180   // was 260
const HEAP_CRIT_MB = 240   // was 290

let _peakHeapMB = 0
let _gcCount    = 0
let _gcLastAt   = 0
let _warnCount  = 0
let _govActive  = false

function currentHeapMB() {
  const mb = Math.round(process.memoryUsage().heapUsed / MB)
  if (mb > _peakHeapMB) _peakHeapMB = mb
  return mb
}

function forceGC(label) {
  if (typeof global.gc !== 'function') return
  const now = Date.now()
  if (now - _gcLastAt < 5000) return   // min 5s between calls (was 8s)
  try {
    global.gc()
    _gcCount++
    _gcLastAt = now
    audit(`GC reason=${label} heap=${currentHeapMB()}MB count=${_gcCount}`)
  } catch {}
}

function startMemoryGovernor() {
  if (_govActive) return
  _govActive = true

  // Every 15s (was 30s) — twice as frequent = catches spikes sooner
  setInterval(() => {
    const mb = currentHeapMB()
    if (mb > HEAP_CRIT_MB) {
      forceGC('critical_' + mb)
      _warnCount++
    } else if (mb > HEAP_WARN_MB) {
      forceGC('warn_' + mb)
      _warnCount++
    } else if (mb > HEAP_GC_MB) {
      forceGC('elevated_' + mb)
    }
  }, 15_000)   // was 30_000

  // Memory log every 5 minutes (audit only — no console spam)
  setInterval(() => {
    const u = process.memoryUsage()
    audit(
      `HEAP used=${Math.round(u.heapUsed/MB)}MB ` +
      `rss=${Math.round(u.rss/MB)}MB ` +
      `peak=${_peakHeapMB}MB ` +
      `gc=${_gcCount} warns=${_warnCount}`
    )
  }, 300_000)
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — OVERLAY PERSISTENCE (OOM FIX)
// GC fires BEFORE each write (not after).
// Skips write if above HEAP_WARN_MB (more conservative than before).
// Per-chain shards: 18 × ~0.1MB vs old 1 × 35MB.
// ═══════════════════════════════════════════════════════════════════════════
export const OVERLAY_RAM_CAP  = 25_000   // safety net — intelligence.js uses 15K
export const OVERLAY_DISK_CAP = 500_000

const OVERLAY_CHAINS = [
  'ethereum','arbitrum','base','polygon','optimism','avalanche',
  'bnb','blast','linea','scroll','zksync','gnosis','mantle',
  'sonic','berachain','sei','unichain','worldchain',
]

function packEntry(e) {
  const hasData = e.readyToExec && e.calldata && e.calldata.length > 2
  return {
    i:  e.id,
    c:  e.chain,
    ci: e.chainIdx    ?? 0,
    p:  Math.round(e.profitEst ?? 0),
    f:  Math.round(e.flash     ?? 0),
    u:  Math.round(e.swapUSD   ?? 0),
    s:  e.status === 'pending' ? 0 : e.status === 'paused' ? 1 : 2,
    t:  e.ts          ?? 0,
    ex: e.expiresAt   ?? 0,
    r:  e.readyToExec ? 1 : 0,
    a:  (e.poolAddr   ?? '').slice(0, 42),
    ...(hasData ? { d: e.calldata } : {}),
  }
}

function unpackEntry(p) {
  if (!p?.i || !p?.c) return null
  return {
    id:          p.i,
    chain:       p.c,
    chainIdx:    p.ci  ?? 0,
    profitEst:   p.p   ?? 0,
    flash:       p.f   ?? 0,
    swapUSD:     p.u   ?? 0,
    status:      p.s === 0 ? 'pending' : p.s === 1 ? 'paused' : 'expired',
    ts:          p.t   ?? 0,
    expiresAt:   p.ex  ?? 0,
    readyToExec: p.r   === 1,
    poolAddr:    p.a   ?? '',
    calldata:    p.d   ?? '',
    retries:     0,
    chainId:     1,
  }
}

export function saveOverlay(heap) {
  if (!_writable || !Array.isArray(heap)) return

  const mb = currentHeapMB()

  // Skip write above HEAP_WARN_MB (more conservative — was HEAP_CRIT_MB)
  if (mb > HEAP_WARN_MB) {
    forceGC('overlay_skip_' + mb)
    return
  }

  // Force GC BEFORE write (not after) — free temporary strings first
  if (mb > HEAP_GC_MB) forceGC('pre_overlay_write_' + mb)

  const t0          = performance.now()
  const perChainCap = Math.floor(OVERLAY_DISK_CAP / OVERLAY_CHAINS.length)
  let   totalWritten= 0

  for (const chainName of OVERLAY_CHAINS) {
    const packed = []
    for (let i = 0; i < heap.length; i++) {
      const e = heap[i]
      if (!e || e.chain !== chainName) continue
      if (e.status !== 'pending' && e.status !== 'paused') continue
      packed.push(packEntry(e))
      if (packed.length >= perChainCap) break
    }
    packed.sort((a,b) => (b.p??0) - (a.p??0))
    try {
      const json = JSON.stringify(packed)      // ~0.1MB string
      writeFileSync(f('ovl_' + chainName + '.json'), json, 'utf8')
      totalWritten += packed.length
    } catch {}
    // json is now out of scope — V8 can collect it between iterations
  }

  try {
    writeFileSync(f('ovl_index.json'), JSON.stringify({
      ts:    Math.floor(Date.now() / 1000),
      total: totalWritten,
      caps:  { disk:OVERLAY_DISK_CAP, ram:OVERLAY_RAM_CAP },
    }), 'utf8')
  } catch {}

  // GC after write — clean up the 18 shard strings
  forceGC('post_overlay_write')

  const dt = Math.round(performance.now() - t0)
  if (dt > 300) audit(`OVERLAY_WRITE slow=${dt}ms entries=${totalWritten}`)
}

export function loadOverlay() {
  const all = []
  try {
    for (const name of OVERLAY_CHAINS) {
      const path = f('ovl_' + name + '.json')
      if (!existsSync(path)) continue
      try {
        const packed = JSON.parse(readFileSync(path, 'utf8'))
        if (!Array.isArray(packed)) continue
        for (const p of packed) {
          const e = unpackEntry(p)
          if (e && (e.status === 'pending' || e.status === 'paused')) all.push(e)
        }
      } catch {}
    }
    return all
      .sort((a,b) => (b.profitEst??0) - (a.profitEst??0))
      .slice(0, OVERLAY_RAM_CAP)
  } catch { return [] }
}

export function clearOverlayDisk() {
  try {
    for (const name of OVERLAY_CHAINS) {
      const path = f('ovl_' + name + '.json')
      if (existsSync(path)) writeFileSync(path, '[]', 'utf8')
    }
    writeFileSync(f('ovl_index.json'), JSON.stringify({ts:0,total:0}), 'utf8')
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4 — CONFIG PERSISTENCE (2,000 key cap)
// ═══════════════════════════════════════════════════════════════════════════
const CONFIG_KEY_CAP = 2_000

const PRIORITY_KEYS = new Set([
  'prop_intensity','prop_daily_target','daily_achieved','crash_mode',
  'system_paused','all_time_profit','lp_total','total_executions',
  'total_wins','win_rate','mega_swap_count','prices','apex_avg_ms',
  'executor_address','compiled_bytecode','rs5_total','rs1_jit_total',
  'rs2_total','rs3_total','rs3_from_rs5','amp_total','overlay_queue_size',
  'ovl_total_stored','ovl_total_executed','ovl_next_id','crash_score',
  'rule_ai_enabled','yield_protocol','yield_apy','fx_rates',
  'sovereign_accuracy','sovereign_calls','hour_revenue',
  'rule_ai_calls','rule_ai_last','sovereign_last',
])

export function saveConfig(cfgMap) {
  if (!_writable || !(cfgMap instanceof Map)) return
  try {
    const obj = {}
    for (const k of PRIORITY_KEYS) {
      if (cfgMap.has(k)) obj[k] = cfgMap.get(k)
    }
    const slots = CONFIG_KEY_CAP - Object.keys(obj).length
    let   filled = 0
    for (const [k, v] of cfgMap) {
      if (filled >= slots) break
      if (!PRIORITY_KEYS.has(k)) { obj[k] = v; filled++ }
    }
    writeFileSync(f('cfg.json'), JSON.stringify(obj), 'utf8')
  } catch {}
}

export function loadConfig() {
  try {
    const path = f('cfg.json')
    if (!existsSync(path)) return new Map()
    const obj  = JSON.parse(readFileSync(path, 'utf8'))
    return new Map(Object.entries(obj).map(([k,v]) => [k, String(v)]))
  } catch { return new Map() }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5 — EXECUTION HISTORY (1,000 cap, compact codec)
// ═══════════════════════════════════════════════════════════════════════════
function packExec(e) {
  return {
    h:  (e.txHash   ?? '').slice(0, 20),
    c:  e.chain      ?? '',
    pr: (e.protocol ?? '').slice(0, 16),
    p:  Math.round(e.profit_usdc ?? 0),
    s:  e.status === 'success' ? 1 : 0,
    t:  e.ts         ?? 0,
  }
}

function unpackExec(e) {
  return {
    txHash:      e.h  ?? '',
    chain:       e.c  ?? '',
    protocol:    e.pr ?? '',
    profit_usdc: e.p  ?? 0,
    status:      e.s  === 1 ? 'success' : 'failed',
    ts:          e.t  ?? 0,
  }
}

export function saveExecs(execs) {
  if (!_writable || !Array.isArray(execs)) return
  try {
    writeFileSync(
      f('execs.json'),
      JSON.stringify(execs.slice(-1000).map(packExec)),
      'utf8'
    )
  } catch {}
}

export function loadExecs() {
  try {
    const path = f('execs.json')
    if (!existsSync(path)) return []
    const arr  = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(arr) ? arr.map(unpackExec) : []
  } catch { return [] }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 6 — REVENUE
// ═══════════════════════════════════════════════════════════════════════════
export function saveRevenue({ allTime, lp, today, executions, wins } = {}) {
  if (!_writable) return
  try {
    writeFileSync(f('revenue.json'), JSON.stringify({
      a: Math.round((allTime   ?? 0) * 100) / 100,
      l: Math.round((lp        ?? 0) * 100) / 100,
      d: Math.round((today     ?? 0) * 100) / 100,
      e: Math.floor(executions ?? 0),
      w: Math.floor(wins       ?? 0),
      t: Math.floor(Date.now() / 1000),
    }), 'utf8')
  } catch {}
}

export function loadRevenue() {
  try {
    const path = f('revenue.json')
    if (!existsSync(path)) return {}
    const d    = JSON.parse(readFileSync(path, 'utf8'))
    return { allTime:d.a??0, lp:d.l??0, today:d.d??0, executions:d.e??0, wins:d.w??0, savedAt:d.t??0 }
  } catch { return {} }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 7 — CONTRACTS
// ═══════════════════════════════════════════════════════════════════════════
export function saveContracts(addrs) {
  if (!_writable || !addrs) return
  try {
    const clean = {}
    for (const [k,v] of Object.entries(addrs)) {
      if (v && typeof v === 'string' && v.startsWith('0x')) clean[k] = v
    }
    writeFileSync(f('contracts.json'), JSON.stringify({...clean,_ts:Math.floor(Date.now()/1000)}), 'utf8')
  } catch {}
}

export function loadContracts() {
  try {
    const path = f('contracts.json')
    if (!existsSync(path)) return {}
    const data = JSON.parse(readFileSync(path, 'utf8'))
    const out  = {}
    for (const [k,v] of Object.entries(data)) {
      if (k !== '_ts' && typeof v === 'string' && v.startsWith('0x')) out[k] = v
    }
    return out
  } catch { return {} }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 8 — SWAP COUNT
// ═══════════════════════════════════════════════════════════════════════════
export function saveSwapCount(n) {
  if (!_writable) return
  try { writeFileSync(f('swaps.txt'), String(Math.floor(n ?? 0)), 'utf8') } catch {}
}

export function loadSwapCount() {
  try {
    const path = f('swaps.txt')
    if (!existsSync(path)) return 0
    return parseInt(readFileSync(path, 'utf8').trim(), 10) || 0
  } catch { return 0 }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 9 — SDAL
// ═══════════════════════════════════════════════════════════════════════════
export function saveSDAL(sdalObj) {
  if (!_writable || !sdalObj) return
  try { writeFileSync(f('sdal.json'), JSON.stringify(sdalObj, null, 2), 'utf8') } catch {}
}

export function loadSDAL() {
  try {
    const path = f('sdal.json')
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch { return null }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 10 — GAS PRICES
// ═══════════════════════════════════════════════════════════════════════════
export function saveGasPrices(prices) {
  if (!_writable || !prices) return
  try {
    writeFileSync(f('gas.json'), JSON.stringify({...prices,_ts:Math.floor(Date.now()/1000)}), 'utf8')
  } catch {}
}

export function loadGasPrices() {
  try {
    const path = f('gas.json')
    if (!existsSync(path)) return {}
    const d   = JSON.parse(readFileSync(path, 'utf8'))
    const out = {}
    for (const [k,v] of Object.entries(d)) {
      if (k !== '_ts' && typeof v === 'number' && v > 0) out[k] = v
    }
    return out
  } catch { return {} }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 11 — PROCESS START TIME (dashboard.js true uptime)
// ═══════════════════════════════════════════════════════════════════════════
export function saveProcessStart(ts) {
  if (!_writable) return
  try { writeFileSync(f('process_start.txt'), String(ts ?? Date.now()), 'utf8') } catch {}
}

export function loadProcessStart() {
  try {
    const path = f('process_start.txt')
    if (!existsSync(path)) return null
    const v = parseInt(readFileSync(path, 'utf8').trim(), 10)
    return (v > 0 && v < Date.now()) ? v : null
  } catch { return null }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 12 — AUDIT LOG (2MB cap, rotate on overflow)
// ═══════════════════════════════════════════════════════════════════════════
const AUDIT_MAX  = 2 * MB
let   _auditSize = 0

export function audit(msg) {
  if (!_writable) return
  try {
    const line = `${new Date().toISOString()} ${msg}\n`
    if (_auditSize > AUDIT_MAX) {
      writeFileSync(f('audit.log'), line, 'utf8')
      _auditSize = line.length
    } else {
      appendFileSync(f('audit.log'), line)
      _auditSize += line.length
    }
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 13 — HEALTH CHECK
// ═══════════════════════════════════════════════════════════════════════════
export function dbHealth() {
  const FILES = [
    'cfg.json','execs.json','revenue.json','contracts.json',
    'gas.json','swaps.txt','sdal.json','ovl_index.json',
    'process_start.txt','audit.log',
    ...OVERLAY_CHAINS.map(n => 'ovl_' + n + '.json'),
  ]
  let totalBytes = 0
  const status   = {}
  for (const name of FILES) {
    try {
      const fp = f(name)
      if (existsSync(fp)) {
        const s = statSync(fp)
        status[name] = { size:s.size, ageS:Math.floor((Date.now()-s.mtimeMs)/1000) }
        totalBytes  += s.size
      }
    } catch {}
  }
  let overlayTotal = 0
  try {
    const idx = JSON.parse(readFileSync(f('ovl_index.json'), 'utf8'))
    overlayTotal = idx.total ?? 0
  } catch {}
  const mem = process.memoryUsage()
  return {
    mounted:       _mounted,
    writable:      _writable,
    root:          _root,
    totalBytes,
    totalMB:       (totalBytes/MB).toFixed(2),
    overlayOnDisk: overlayTotal,
    overlayCaps:   { disk:OVERLAY_DISK_CAP, ram:OVERLAY_RAM_CAP },
    memory: {
      heapUsedMB:  Math.round(mem.heapUsed  / MB),
      heapTotalMB: Math.round(mem.heapTotal / MB),
      rssMB:       Math.round(mem.rss       / MB),
      peakMB:      _peakHeapMB,
      gcCount:     _gcCount,
      warnCount:   _warnCount,
      gcThresholds:{ gc:HEAP_GC_MB, warn:HEAP_WARN_MB, crit:HEAP_CRIT_MB },
      status:      _peakHeapMB > HEAP_CRIT_MB ? 'CRITICAL'
                 : _peakHeapMB > HEAP_WARN_MB ? 'ELEVATED' : 'OK',
    },
    configKeyCap:  CONFIG_KEY_CAP,
    note: _writable
      ? `Persistent ✓ ${(totalBytes/MB).toFixed(1)}MB`
      : 'NOT PERSISTENT — add /data volume in Railway',
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 14 — INIT
// ═══════════════════════════════════════════════════════════════════════════
export function initDB() {
  detectVolume()

  try {
    const ap = f('audit.log')
    if (existsSync(ap)) _auditSize = statSync(ap).size
  } catch {}

  audit(`BOOT pid=${process.pid} node=${process.version}`)

  // Write process start time on first boot only — never overwrite
  if (!existsSync(f('process_start.txt'))) {
    saveProcessStart(Date.now())
  }

  let overlayTotal = 0
  try {
    const idx = JSON.parse(readFileSync(f('ovl_index.json'), 'utf8'))
    overlayTotal = idx.total ?? 0
  } catch {}

  const health    = dbHealth()
  const contracts = loadContracts()
  const revenue   = loadRevenue()
  const swaps     = loadSwapCount()

  console.log(`[DB] Volume: ${_root} — ${health.totalMB}MB stored`)
  console.log(`[DB] Caps: ${OVERLAY_DISK_CAP.toLocaleString()} disk · ${OVERLAY_RAM_CAP.toLocaleString()} RAM · ~${Math.round(OVERLAY_DISK_CAP*80/MB)}MB max`)
  if (overlayTotal > 0)
    console.log(`[DB] Overlay: ${overlayTotal.toLocaleString()} entries on disk`)
  if (Object.keys(contracts).length > 0)
    console.log(`[DB] Contracts: ${Object.keys(contracts).length} chains`)
  if (revenue.allTime > 0)
    console.log(`[DB] Revenue: ${revenue.allTime>=1e9?'$'+(revenue.allTime/1e9).toFixed(2)+'B':'$'+(revenue.allTime/1e6).toFixed(2)+'M'} all-time`)
  if (swaps > 0)
    console.log(`[DB] Swaps: ${swaps.toLocaleString()} restored`)
  if (!_mounted)
    console.warn('[DB] /data not a Railway volume — add one for persistence')

  startMemoryGovernor()

  return health
}

export const DB_CONSTANTS = {
  OVERLAY_RAM_CAP,
  OVERLAY_DISK_CAP,
  CONFIG_KEY_CAP,
  HEAP_GC_MB,
  HEAP_WARN_MB,
  HEAP_CRIT_MB,
}
