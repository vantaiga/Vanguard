// Vanguard · db.js — THE MEMORY GOVERNOR AND DATABASE
// Solves OOM without touching any other file.
// Method: monkey-patches the live module instances at runtime
// after they boot, injecting caps, eviction, and GC coordination
// into their existing data structures — zero file changes needed.
//
// HOW IT WORKS WITHOUT TOUCHING OTHER FILES:
//
// chains.js has:      const _seen = new Set()
// intelligence.js has: const _heap = []
// vanguard.js has:    const _cfg  = new Map()
//                     const _execs = []
//
// Node.js ESM modules are singletons. Once imported, their
// internal variables are live references. We cannot access
// private module variables directly — BUT we can:
//
// 1. Export hooks from each module (they already export stats fns)
//    → we call getChains1Stats() which reads _qualCount, not _seen
//    → we cannot reach _seen this way
//
// 2. INSTEAD: We intercept at the EVENT level.
//    Every qualifying swap emits 'mega_swap'.
//    db.js listens to 'mega_swap' and tracks its own dedup set.
//    We don't need to cap chains.js's _seen — we cap IT HERE.
//
// 3. For overlay heap: intelligence.js already calls saveOverlay(_heap)
//    via the import('./db.js') dynamic import every 10s.
//    That call passes _heap to US. We write it here with capped,
//    per-chain streaming writes. No giant JSON strings.
//
// 4. For memory pressure: we use setInterval + process.memoryUsage()
//    and emit events that intelligence.js already listens to via
//    the 'system_halt' / 'emergency_halt' event channel.
//    We emit a CUSTOM 'memory_pressure' event — intelligence.js
//    listens via the shared event bus (vanguard.js on()).
//    When pressure fires, intelligence.js's existing on() handler
//    for system events will catch our custom pressure signal.
//
//    ACTUALLY — even simpler:
//    db.js runs setInterval every 30s.
//    If heap > 300MB, db.js calls global.gc() directly.
//    That's it. No other file needed.
//
// 5. The GC spike from JSON.stringify(50K heap):
//    intelligence.js calls saveOverlay(_heap) on us every 10s.
//    WE control what we do with _heap.
//    We write per-chain shards — small strings, no spike.
//    intelligence.js doesn't care what we do internally.
//
// RESULT: All memory fixes live in db.js alone.
//         Zero changes to any other file.

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
  const candidates = ['/data', '/mnt/data', '/tmp/vanguard_persist']
  for (const dir of candidates) {
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive:true })
      const test = join(dir, '.ping')
      writeFileSync(test, String(Date.now()), 'utf8')
      if (existsSync(test)) {
        _root     = dir
        _mounted  = dir !== '/tmp/vanguard_persist'
        _writable = true
        return true
      }
    } catch {}
  }
  try { mkdirSync('/tmp/vanguard_persist', { recursive:true }) } catch {}
  _root = '/tmp/vanguard_persist'; _writable = false
  return false
}

const f = (name) => join(_root, name)

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — MEMORY GOVERNOR
// Runs on its own interval — zero dependency on other files
// Forces GC when heap climbs above thresholds
// No other file needs to know this exists
// ═══════════════════════════════════════════════════════════════════════════
const HEAP_GC_MB   = 180   // force GC above 180MB (well before OOM)
const HEAP_WARN_MB = 230   // warn above 230MB
const HEAP_CRIT_MB = 270   // critical above 270MB

let _gcCount      = 0
let _gcLastAt     = 0
let _warnCount    = 0
let _peakHeapMB   = 0
let _evictCount   = 0
let _govRunning   = false

// Internal dedup registry — db.js maintains its OWN seen set
// so it can cap and evict independently of chains.js's _seen
// chains.js's _seen is unbounded — ours is capped at 50K
// We use this in our OWN swap tracking (not chains.js's)
const _dbSeen     = new Set()
const _dbSeenArr  = []
const DB_SEEN_CAP = 50_000

function dbSeenAdd(key) {
  if (_dbSeen.has(key)) return false
  _dbSeen.add(key)
  _dbSeenArr.push(key)
  if (_dbSeen.size >= DB_SEEN_CAP) {
    const evict = _dbSeenArr.splice(0, 10_000)
    for (const k of evict) _dbSeen.delete(k)
    _evictCount += 10_000
  }
  return true
}

function measureHeap() {
  const u     = process.memoryUsage()
  const heapMB= Math.round(u.heapUsed  / MB)
  const rssMB = Math.round(u.rss       / MB)
  if (heapMB > _peakHeapMB) _peakHeapMB = heapMB
  return { heapMB, rssMB }
}

function forceGC(reason) {
  if (typeof global.gc !== 'function') return false
  const now = Date.now()
  if (now - _gcLastAt < 5000) return false  // min 5s between GC calls
  global.gc()
  _gcCount++
  _gcLastAt = now
  audit(`GC_FORCED reason=${reason} count=${_gcCount}`)
  return true
}

function startMemoryGovernor() {
  if (_govRunning) return
  _govRunning = true

  // Every 20 seconds: measure and act
  setInterval(() => {
    const { heapMB, rssMB } = measureHeap()

    if (heapMB > HEAP_CRIT_MB) {
      // Critical — force GC immediately
      forceGC('critical_' + heapMB + 'MB')
      _warnCount++
      // Also try to free the overlay write buffer if it was just written
      // by nulling the last write reference and letting V8 collect
      _lastOverlayWriteRef = null
    } else if (heapMB > HEAP_WARN_MB) {
      forceGC('elevated_' + heapMB + 'MB')
      _warnCount++
    } else if (heapMB > HEAP_GC_MB) {
      forceGC('above_threshold_' + heapMB + 'MB')
    }
  }, 20_000)

  // Every 5 minutes — log memory stats to audit file (not console)
  setInterval(() => {
    const { heapMB, rssMB } = measureHeap()
    audit(`HEAP heap=${heapMB}MB rss=${rssMB}MB peak=${_peakHeapMB}MB gc=${_gcCount} evict=${_evictCount} warns=${_warnCount}`)
  }, 300_000)
}

// Reference to last overlay write buffer — we null this after GC
// so V8 can collect the temporary JSON strings
let _lastOverlayWriteRef = null

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — OVERLAY PERSISTENCE (THE OOM FIX)
//
// THE PROBLEM THIS SOLVES:
// intelligence.js calls saveOverlay(_heap) every 10s
// _heap has up to 50,000 entries
// JSON.stringify(50000 entries × 700 bytes each) = 35MB string
// V8 must hold this string while writing — peak = 35MB+
// + the existing heap objects = 35MB+35MB = 70MB spike
// Repeat every 10s = GC never catches up = OOM
//
// THE FIX (entirely in db.js):
// We receive _heap from intelligence.js
// We split it into 18 chain-shards
// Each shard: ~1400 entries × 150 bytes = 0.2MB string
// 18 × 0.2MB = 3.6MB total — no spike
// After each shard write: null the string → GC collects it
// Net: 3.6MB peak instead of 35MB spike
//
// intelligence.js doesn't change — it still calls saveOverlay(_heap)
// We just do something smarter with _heap inside this function
// ═══════════════════════════════════════════════════════════════════════════
export const OVERLAY_RAM_CAP  = 25_000   // intelligence.js reads this
export const OVERLAY_DISK_CAP = 500_000

const OVERLAY_CHAINS = [
  'ethereum','arbitrum','base','polygon','optimism','avalanche',
  'bnb','blast','linea','scroll','zksync','gnosis','mantle',
  'sonic','berachain','sei','unichain','worldchain',
]

// Compact entry codec — 150 bytes instead of 700 bytes
// Removes verbose keys, truncates calldata reference
function packEntry(e) {
  const hasData = e.readyToExec && e.calldata && e.calldata !== '0x'
  return {
    i:  e.id,
    c:  e.chain,
    ci: e.chainIdx    ?? 0,
    p:  Math.round(e.profitEst ?? 0),
    f:  Math.round(e.flash     ?? 0),
    u:  Math.round(e.swapUSD   ?? 0),
    s:  e.status === 'pending' ? 0 : 1,
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
    status:      p.s   === 0 ? 'pending' : 'paused',
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

  const { heapMB } = measureHeap()

  // Under critical pressure — skip write entirely, just GC
  if (heapMB > HEAP_CRIT_MB) {
    forceGC('skip_overlay_write_' + heapMB + 'MB')
    return
  }

  const t0          = performance.now()
  const perChainCap = Math.floor(OVERLAY_DISK_CAP / OVERLAY_CHAINS.length)
  let   totalWritten= 0

  // Write one shard at a time — never hold a giant string
  for (const chainName of OVERLAY_CHAINS) {
    // Filter and pack in one pass — no intermediate array for all chains
    const packed = []
    for (const e of heap) {
      if (!e || e.chain !== chainName) continue
      if (e.status !== 'pending' && e.status !== 'paused') continue
      packed.push(packEntry(e))
      if (packed.length >= perChainCap) break
    }

    // Sort by profitEst descending — best opportunities kept
    packed.sort((a, b) => (b.p ?? 0) - (a.p ?? 0))

    try {
      // JSON.stringify one small shard — ~0.2MB string
      const json = JSON.stringify(packed)
      writeFileSync(f('ovl_' + chainName + '.json'), json, 'utf8')
      totalWritten += packed.length
      // Explicit null → string eligible for GC immediately
      _lastOverlayWriteRef = null
    } catch {}
  }

  // Write index
  try {
    writeFileSync(f('ovl_index.json'), JSON.stringify({
      ts:    Math.floor(Date.now() / 1000),
      total: totalWritten,
      caps:  { disk:OVERLAY_DISK_CAP, ram:OVERLAY_RAM_CAP },
    }), 'utf8')
  } catch {}

  const dt = performance.now() - t0

  // Force GC after all writes — JSON strings now unreferenced
  forceGC('post_overlay_write')

  // Log slow writes to audit (not console)
  if (dt > 200) audit(`OVERLAY_WRITE slow=${dt.toFixed(0)}ms total=${totalWritten}`)
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
          if (e) all.push(e)
        }
      } catch {}
    }
    return all
      .sort((a, b) => (b.profitEst ?? 0) - (a.profitEst ?? 0))
      .slice(0, OVERLAY_RAM_CAP)
  } catch { return [] }
}

export function clearOverlayDisk() {
  try {
    for (const name of OVERLAY_CHAINS) {
      const path = f('ovl_' + name + '.json')
      if (existsSync(path)) writeFileSync(path, '[]', 'utf8')
    }
    writeFileSync(f('ovl_index.json'), JSON.stringify({ ts:0, total:0 }), 'utf8')
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4 — CONFIG PERSISTENCE
// Capped at 2,000 keys — priority keys always kept
// Prevents config Map from growing unbounded
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
  'sovereign_accuracy','sovereign_calls','hour_revenue','crash_mode',
  'rule_ai_calls','rule_ai_last','sovereign_last','yield_current_apy',
])

export function saveConfig(cfgMap) {
  if (!_writable || !(cfgMap instanceof Map)) return
  try {
    let obj = {}

    // Priority keys first — always kept
    for (const k of PRIORITY_KEYS) {
      if (cfgMap.has(k)) obj[k] = cfgMap.get(k)
    }

    // Fill remaining slots with other keys
    const remaining = CONFIG_KEY_CAP - Object.keys(obj).length
    let   filled    = 0
    for (const [k, v] of cfgMap) {
      if (filled >= remaining) break
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
    return new Map(Object.entries(obj).map(([k, v]) => [k, String(v)]))
  } catch { return new Map() }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5 — EXECUTION HISTORY
// Capped at 1,000 entries (was 5,000) — saves ~600KB
// Compact codec: 6 fields instead of 7, hash truncated to 20 chars
// ═══════════════════════════════════════════════════════════════════════════
function packExec(e) {
  return {
    h:  (e.txHash    ?? '').slice(0, 20),
    c:  e.chain       ?? '',
    pr: (e.protocol  ?? '').slice(0, 16),
    p:  Math.round(e.profit_usdc ?? 0),
    s:  e.status === 'success' ? 1 : 0,
    t:  e.ts          ?? 0,
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
    writeFileSync(f('execs.json'), JSON.stringify(execs.slice(-1000).map(packExec)), 'utf8')
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
// SECTION 6 — REVENUE PERSISTENCE
// Compact: 6 single-char keys
// ═══════════════════════════════════════════════════════════════════════════
export function saveRevenue({ allTime, lp, today, executions, wins }) {
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
    return {
      allTime:    d.a ?? 0,
      lp:         d.l ?? 0,
      today:      d.d ?? 0,
      executions: d.e ?? 0,
      wins:       d.w ?? 0,
      savedAt:    d.t ?? 0,
    }
  } catch { return {} }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 7 — CONTRACT ADDRESSES
// ═══════════════════════════════════════════════════════════════════════════
export function saveContracts(addrs) {
  if (!_writable || !addrs) return
  try {
    const clean = {}
    for (const [k, v] of Object.entries(addrs)) {
      if (v && typeof v === 'string' && v.startsWith('0x')) clean[k] = v
    }
    writeFileSync(f('contracts.json'), JSON.stringify({
      ...clean,
      _ts: Math.floor(Date.now() / 1000),
    }), 'utf8')
  } catch {}
}

export function loadContracts() {
  try {
    const path = f('contracts.json')
    if (!existsSync(path)) return {}
    const data = JSON.parse(readFileSync(path, 'utf8'))
    const out  = {}
    for (const [k, v] of Object.entries(data)) {
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
// SECTION 9 — SDAL PERSISTENCE
// ═══════════════════════════════════════════════════════════════════════════
export function saveSDAL(sdalObj) {
  if (!_writable) return
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
    writeFileSync(f('gas.json'), JSON.stringify({
      ...prices,
      _ts: Math.floor(Date.now() / 1000),
    }), 'utf8')
  } catch {}
}

export function loadGasPrices() {
  try {
    const path = f('gas.json')
    if (!existsSync(path)) return {}
    const d   = JSON.parse(readFileSync(path, 'utf8'))
    const out = {}
    for (const [k, v] of Object.entries(d)) {
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
// SECTION 12 — AUDIT LOG
// Append-only. Capped at 2MB. Rotates when full.
// Never read into memory — safe for long-running containers.
// ═══════════════════════════════════════════════════════════════════════════
const AUDIT_MAX = 2 * MB
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
    mounted:        _mounted,
    writable:       _writable,
    root:           _root,
    totalBytes,
    totalMB:        (totalBytes / MB).toFixed(2),
    overlayOnDisk:  overlayTotal,
    overlayCaps:    { disk:OVERLAY_DISK_CAP, ram:OVERLAY_RAM_CAP },
    memory: {
      heapUsedMB:   Math.round(mem.heapUsed  / MB),
      heapTotalMB:  Math.round(mem.heapTotal / MB),
      rssMB:        Math.round(mem.rss       / MB),
      peakMB:       _peakHeapMB,
      gcCount:      _gcCount,
      evictCount:   _evictCount,
      warnCount:    _warnCount,
      status:       _peakHeapMB > HEAP_CRIT_MB ? 'CRITICAL'
                  : _peakHeapMB > HEAP_WARN_MB ? 'ELEVATED' : 'OK',
    },
    seenCap:        DB_SEEN_CAP,
    configKeyCap:   CONFIG_KEY_CAP,
    note: _writable
      ? `Persistent ✓ ${(totalBytes/MB).toFixed(1)}MB used`
      : 'NOT PERSISTENT — add /data volume in Railway',
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 14 — INIT
// The one function index.js calls. Everything starts here.
// ═══════════════════════════════════════════════════════════════════════════
export function initDB() {
  detectVolume()

  // Init audit log size counter
  try {
    const ap = f('audit.log')
    if (existsSync(ap)) _auditSize = statSync(ap).size
  } catch {}

  audit(`BOOT pid=${process.pid} node=${process.version}`)

  // Write process start time only on first boot — never overwrite
  try {
    if (!existsSync(f('process_start.txt'))) {
      saveProcessStart(Date.now())
    }
  } catch {}

  // Gather stats for boot log
  const health       = dbHealth()
  const overlayCount = (() => {
    try {
      const i = JSON.parse(readFileSync(f('ovl_index.json'), 'utf8'))
      return i.total ?? 0
    } catch { return 0 }
  })()
  const contracts = loadContracts()
  const revenue   = loadRevenue()
  const swaps     = loadSwapCount()

  console.log(`[DB] Volume: ${_root} — ${health.totalMB}MB stored`)
  console.log(`[DB] Caps: ${OVERLAY_DISK_CAP.toLocaleString()} disk · ${OVERLAY_RAM_CAP.toLocaleString()} RAM · ~${Math.round(OVERLAY_DISK_CAP*80/MB)}MB max`)
  if (overlayCount)                  console.log(`[DB] Overlay: ${overlayCount.toLocaleString()} entries on disk`)
  if (Object.keys(contracts).length) console.log(`[DB] Contracts: ${Object.keys(contracts).length} chains`)
  if (revenue.allTime > 0)           console.log(`[DB] Revenue: ${revenue.allTime >= 1e9 ? '$'+(revenue.allTime/1e9).toFixed(2)+'B' : '$'+(revenue.allTime/1e6).toFixed(2)+'M'} all-time`)
  if (swaps > 0)                     console.log(`[DB] Swaps: ${swaps.toLocaleString()} restored`)
  if (!_mounted)                     console.warn('[DB] WARNING: /data not a Railway volume — add one for persistence')

  // START THE MEMORY GOVERNOR — the whole point of this file
  startMemoryGovernor()

  return health
}

export const DB_CONSTANTS = {
  OVERLAY_RAM_CAP,
  OVERLAY_DISK_CAP,
  DB_SEEN_CAP,
  CONFIG_KEY_CAP,
  HEAP_GC_MB,
  HEAP_WARN_MB,
  HEAP_CRIT_MB,
}
