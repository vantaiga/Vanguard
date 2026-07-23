// Vanguard · db.js
// Persistent volume storage — survives ALL restarts and redeploys
// Compact JSON: short keys reduce disk size 3.3×
// 500,000 overlay entries on disk (75MB) — top 50K in RAM
// Zero native deps — pure Node.js

import {
  readFileSync, writeFileSync, existsSync,
  mkdirSync, statSync, readdirSync, appendFileSync,
} from 'fs'
import { join, dirname } from 'path'

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — VOLUME DETECTION + FALLBACK
// ═══════════════════════════════════════════════════════════════════════════
let _root    = '/data'
let _mounted = false
let _writable= false

function detectVolume() {
  const candidates = ['/data', '/mnt/data', '/var/data', '/tmp/vanguard_persist']
  for (const dir of candidates) {
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const test = join(dir, '.ping')
      writeFileSync(test, '1')
      if (existsSync(test)) {
        _root     = dir
        _mounted  = dir !== '/tmp/vanguard_persist'
        _writable = true
        return
      }
    } catch {}
  }
  _root     = '/tmp/vanguard_persist'
  _writable = false
  try { mkdirSync(_root, { recursive: true }) } catch {}
}

const f = (name) => join(_root, name)

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — COMPACT OVERLAY ENTRY CODEC
// Short keys: id→i, chain→c, profitEst→p, flash→f, calldata→d,
//             swapUSD→u, status→s, ts→t, expiresAt→e, chainId→x,
//             readyToExec→r, poolAddr→a, retries→rt, chainIdx→ci
// Full entry ~500 bytes → compact ~150 bytes (3.3× reduction)
// ═══════════════════════════════════════════════════════════════════════════

function pack(entry) {
  // Omit calldata from main index — stored separately only when readyToExec
  return {
    i:  entry.id,
    c:  entry.chain,
    ci: entry.chainIdx       ?? 0,
    p:  entry.profitEst      ?? 0,
    f:  Math.floor(entry.flash ?? 0),
    u:  Math.floor(entry.swapUSD ?? 0),
    s:  entry.status         ?? 'pending',
    t:  entry.ts             ?? 0,
    e:  entry.expiresAt      ?? 0,
    x:  entry.chainId        ?? 1,
    r:  entry.readyToExec    ? 1 : 0,
    a:  entry.poolAddr       ?? '',
    rt: entry.retries        ?? 0,
    // Only store calldata if present and not empty
    d:  (entry.readyToExec && entry.calldata && entry.calldata !== '0x')
        ? entry.calldata
        : '',
  }
}

function unpack(p) {
  return {
    id:          p.i,
    chain:       p.c,
    chainIdx:    p.ci  ?? 0,
    profitEst:   p.p   ?? 0,
    flash:       p.f   ?? 0,
    swapUSD:     p.u   ?? 0,
    status:      p.s   ?? 'pending',
    ts:          p.t   ?? 0,
    expiresAt:   p.e   ?? 0,
    chainId:     p.x   ?? 1,
    readyToExec: p.r   === 1,
    poolAddr:    p.a   ?? '',
    retries:     p.rt  ?? 0,
    calldata:    p.d   ?? '',
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — OVERLAY STORAGE
// Disk: 500,000 entries max (75MB) in compact JSON
// RAM:  50,000 entries max (~20MB JavaScript objects)
// Strategy: disk holds full history, RAM holds best 50K by profitEst
// ═══════════════════════════════════════════════════════════════════════════
const DISK_CAP = 500_000    // max entries on disk
const RAM_CAP  =  50_000    // max entries in RAM heap

// Overlay split across multiple shard files to keep each file < 10MB
// Shard by chainName for fast per-chain restore and independent writes
const OVERLAY_CHAINS = [
  'ethereum','arbitrum','base','polygon','optimism','avalanche',
  'bnb','blast','linea','scroll','zksync','gnosis','mantle',
  'sonic','berachain','sei','unichain','worldchain',
]

export function saveOverlay(heap, allEntries) {
  if (!_writable) return
  try {
    // Group by chain
    const byChain = {}
    for (const name of OVERLAY_CHAINS) byChain[name] = []

    // Use heap for RAM entries (top 50K)
    // If allEntries provided (full history), use that for disk
    const source = allEntries ?? heap

    for (const e of source) {
      if (!e?.chain || !OVERLAY_CHAINS.includes(e.chain)) continue
      if (e.status !== 'pending' && e.status !== 'paused') continue
      byChain[e.chain].push(pack(e))
    }

    // Write each chain shard
    let totalWritten = 0
    for (const name of OVERLAY_CHAINS) {
      const entries = byChain[name]
        .sort((a, b) => (b.p ?? 0) - (a.p ?? 0))
        .slice(0, Math.floor(DISK_CAP / OVERLAY_CHAINS.length))
      if (entries.length > 0 || existsSync(f('ovl_'+name+'.json'))) {
        writeFileSync(f('ovl_'+name+'.json'), JSON.stringify(entries), 'utf8')
        totalWritten += entries.length
      }
    }

    // Write index (for fast health check)
    writeFileSync(f('ovl_index.json'), JSON.stringify({
      ts:      Math.floor(Date.now() / 1000),
      total:   totalWritten,
      chains:  Object.fromEntries(OVERLAY_CHAINS.map(n => [n, byChain[n].length])),
    }), 'utf8')

  } catch {}
}

export function loadOverlay() {
  const all = []
  try {
    for (const name of OVERLAY_CHAINS) {
      const path = f('ovl_'+name+'.json')
      if (!existsSync(path)) continue
      try {
        const packed = JSON.parse(readFileSync(path, 'utf8'))
        if (!Array.isArray(packed)) continue
        for (const p of packed) {
          if (p?.i && p?.c) all.push(unpack(p))
        }
      } catch {}
    }

    // Return top RAM_CAP by profitEst
    return all
      .filter(e => e.status === 'pending' || e.status === 'paused')
      .sort((a, b) => (b.profitEst ?? 0) - (a.profitEst ?? 0))
      .slice(0, RAM_CAP)
  } catch { return [] }
}

export function clearOverlayDisk() {
  try {
    for (const name of OVERLAY_CHAINS) {
      const path = f('ovl_'+name+'.json')
      if (existsSync(path)) writeFileSync(path, '[]', 'utf8')
    }
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4 — CONFIG PERSISTENCE
// ═══════════════════════════════════════════════════════════════════════════
export function saveConfig(cfgMap) {
  if (!_writable) return
  try {
    writeFileSync(f('cfg.json'), JSON.stringify(Object.fromEntries(cfgMap)), 'utf8')
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
// ═══════════════════════════════════════════════════════════════════════════

// Compact exec entry codec
function packExec(e) {
  return {
    h: e.txHash?.slice(0, 20) ?? '',  // truncate — full hash wastes space
    c: e.chain                ?? '',
    pr: e.protocol            ?? '',
    p:  Math.floor(e.profit_usdc ?? 0),
    s:  e.status === 'success' ? 1 : 0,
    t:  e.ts                  ?? 0,
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
  if (!_writable) return
  try {
    writeFileSync(
      f('execs.json'),
      JSON.stringify(execs.slice(-5000).map(packExec)),
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
// SECTION 6 — SDAL PERSISTENCE
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
// SECTION 7 — SWAP COUNT PERSISTENCE
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
// SECTION 8 — REVENUE PERSISTENCE
// ═══════════════════════════════════════════════════════════════════════════
export function saveRevenue({ allTime, lp, today, executions, wins }) {
  if (!_writable) return
  try {
    writeFileSync(f('revenue.json'), JSON.stringify({
      a: Math.round((allTime    ?? 0) * 100) / 100,
      l: Math.round((lp         ?? 0) * 100) / 100,
      d: Math.round((today      ?? 0) * 100) / 100,
      e: Math.floor(executions  ?? 0),
      w: Math.floor(wins        ?? 0),
      t: Math.floor(Date.now()  / 1000),
    }), 'utf8')
  } catch {}
}

export function loadRevenue() {
  try {
    const path = f('revenue.json')
    if (!existsSync(path)) return {}
    const d = JSON.parse(readFileSync(path, 'utf8'))
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
// SECTION 9 — CONTRACT ADDRESSES
// Critical: survive restart so system doesn't re-deploy (wastes gas)
// ═══════════════════════════════════════════════════════════════════════════
export function saveContracts(addrs) {
  if (!_writable) return
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
      if (k !== '_ts' && v?.startsWith?.('0x')) out[k] = v
    }
    return out
  } catch { return {} }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 10 — GAS PRICE HISTORY (for NEXUS adaptive gas)
// ═══════════════════════════════════════════════════════════════════════════
export function saveGasPrices(prices) {
  if (!_writable) return
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
    const d = JSON.parse(readFileSync(path, 'utf8'))
    const out = {}
    for (const [k, v] of Object.entries(d)) {
      if (k !== '_ts' && typeof v === 'number') out[k] = v
    }
    return out
  } catch { return {} }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 11 — AUDIT LOG
// ═══════════════════════════════════════════════════════════════════════════
export function audit(msg) {
  if (!_writable) return
  try {
    appendFileSync(f('audit.log'), `${new Date().toISOString()} ${msg}\n`)
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 12 — DISK USAGE HEALTH
// ═══════════════════════════════════════════════════════════════════════════
export function dbHealth() {
  const FILES = [
    'cfg.json', 'execs.json', 'revenue.json', 'contracts.json',
    'gas.json', 'swaps.txt', 'sdal.json', 'ovl_index.json',
    'audit.log',
    ...OVERLAY_CHAINS.map(n => 'ovl_'+n+'.json'),
  ]

  let totalBytes = 0
  const status   = {}

  for (const name of FILES) {
    try {
      const fp = f(name)
      if (existsSync(fp)) {
        const s = statSync(fp)
        status[name] = { size:s.size, age: Math.floor((Date.now()-s.mtimeMs)/1000)+'s' }
        totalBytes  += s.size
      }
    } catch {}
  }

  // Overlay index
  let overlayTotal = 0
  try {
    const idx = JSON.parse(readFileSync(f('ovl_index.json'), 'utf8'))
    overlayTotal = idx.total ?? 0
  } catch {}

  return {
    mounted:       _mounted,
    writable:      _writable,
    root:          _root,
    totalBytes,
    totalMB:       (totalBytes / 1048576).toFixed(2),
    overlayOnDisk: overlayTotal,
    overlayCap:    { disk: DISK_CAP, ram: RAM_CAP },
    files:         status,
    note: _writable
      ? `Persistent ✓ ${(totalBytes/1048576).toFixed(1)}MB used`
      : 'NOT PERSISTENT — add /data volume in Railway',
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 13 — INIT
// ═══════════════════════════════════════════════════════════════════════════
export function initDB() {
  detectVolume()
  audit(`BOOT pid=${process.pid} node=${process.version}`)

  const health = dbHealth()

  if (_writable) {
    const overlayCount = (() => {
      try {
        const idx = JSON.parse(readFileSync(f('ovl_index.json'), 'utf8'))
        return idx.total ?? 0
      } catch { return 0 }
    })()

    const contracts = loadContracts()
    const revenue   = loadRevenue()
    const swaps     = loadSwapCount()

    console.log(`[DB] Volume: ${_root} — ${health.totalMB}MB stored`)
    console.log(`[DB] Caps: ${DISK_CAP.toLocaleString()} disk · ${RAM_CAP.toLocaleString()} RAM · ~${Math.round(DISK_CAP*150/1048576)}MB max`)
    if (overlayCount) console.log(`[DB] Overlay: ${overlayCount.toLocaleString()} entries on disk`)
    if (Object.keys(contracts).length) console.log(`[DB] Contracts: ${Object.keys(contracts).length} chains`)
    if (revenue.allTime > 0) console.log(`[DB] Revenue: ${revenue.allTime >= 1e9 ? '$'+(revenue.allTime/1e9).toFixed(2)+'B' : '$'+(revenue.allTime/1e6).toFixed(2)+'M'} all-time`)
    if (swaps > 0) console.log(`[DB] Swaps: ${swaps.toLocaleString()} restored`)
    if (!_mounted) console.warn('[DB] WARNING: /data not a Railway volume — add one for true persistence')
  } else {
    console.warn('[DB] No writable volume — data lost on restart')
    console.warn('[DB] FIX: Railway → Service → Settings → Add Volume → Mount at /data')
  }

  return health
}

export const DB_CONSTANTS = { DISK_CAP, RAM_CAP }
