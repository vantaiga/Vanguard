// Vanguard · db.js
// Pure JavaScript. Zero native dependencies. Zero node-gyp. Zero Python.
// In-memory Map + JSON file persistence every 10 seconds.
// Same API surface as before — all 24 files import this unchanged.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'

const CFG_PATH  = '/data/vanguard_cfg.json'
const EXEC_PATH = '/data/vanguard_execs.json'

// ── In-memory stores ──────────────────────────────────────────────────────────
const _cfg   = new Map()
const _execs = []         // ring buffer — max 10,000 entries
let   _cfgDirty  = false
let   _execDirty = false

// ── Disk helpers ──────────────────────────────────────────────────────────────
function ensureDir(p) {
  try { mkdirSync(dirname(p), { recursive: true }) } catch {}
}

function loadCfg() {
  try {
    if (!existsSync(CFG_PATH)) return
    const obj = JSON.parse(readFileSync(CFG_PATH, 'utf8'))
    for (const [k, v] of Object.entries(obj)) _cfg.set(k, String(v))
    console.log(`[DB] Loaded ${_cfg.size} config keys`)
  } catch(e) {
    console.warn('[DB] Config load skipped:', e.message?.slice(0, 60))
  }
}

function loadExecs() {
  try {
    if (!existsSync(EXEC_PATH)) return
    const arr = JSON.parse(readFileSync(EXEC_PATH, 'utf8'))
    if (Array.isArray(arr)) _execs.push(...arr.slice(-1000))
    console.log(`[DB] Loaded ${_execs.length} executions`)
  } catch {}
}

function saveCfg() {
  if (!_cfgDirty) return
  _cfgDirty = false
  try { ensureDir(CFG_PATH); writeFileSync(CFG_PATH, JSON.stringify(Object.fromEntries(_cfg)), 'utf8') } catch {}
}

function saveExecs() {
  if (!_execDirty) return
  _execDirty = false
  try { ensureDir(EXEC_PATH); writeFileSync(EXEC_PATH, JSON.stringify(_execs.slice(-1000)), 'utf8') } catch {}
}

// ── Config API ────────────────────────────────────────────────────────────────
export function getConfig(key) {
  return _cfg.get(key) ?? null
}

export function setConfig(key, value) {
  _cfg.set(key, String(value))
  _cfgDirty = true
}

export function delConfig(key) {
  _cfg.delete(key)
  _cfgDirty = true
}

export function bulkSetConfig(pairs) {
  for (const [k, v] of pairs) _cfg.set(k, String(v))
  _cfgDirty = true
}

// ── Executions API ────────────────────────────────────────────────────────────
export function recordExecution({ txHash, chain, protocol, profitUsdc, gasUsed, status }) {
  _execs.push({
    txHash:      txHash     || '',
    chain:       chain      || '',
    protocol:    protocol   || '',
    profit_usdc: profitUsdc || 0,
    gas_used:    gasUsed    || 0,
    status:      status     || 'pending',
    ts:          Math.floor(Date.now() / 1000),
  })
  if (_execs.length > 10000) _execs.shift()
  _execDirty = true

  const prev  = parseFloat(getConfig('all_time_profit')  || '0')
  const count = parseInt(getConfig('total_executions')    || '0')
  setConfig('all_time_profit',  (prev + (profitUsdc || 0)).toFixed(2))
  setConfig('total_executions', String(count + 1))
  if (status === 'success') {
    setConfig('total_wins', String(parseInt(getConfig('total_wins') || '0') + 1))
  }
  const tot = parseInt(getConfig('total_executions') || '0')
  const win = parseInt(getConfig('total_wins')       || '0')
  if (tot > 0) setConfig('win_rate', ((win / tot) * 100).toFixed(1) + '%')
}

export function getExecutions(limit = 50, chain = null) {
  let result = [..._execs].reverse()
  if (chain) result = result.filter(e => e.chain === chain)
  return result.slice(0, Math.min(limit, 1000))
}

export function getStats() {
  return {
    profit:     parseFloat(getConfig('all_time_profit')  || '0'),
    executions: parseInt(getConfig('total_executions')   || '0'),
    wins:       parseInt(getConfig('total_wins')         || '0'),
    winRate:    getConfig('win_rate')                    || '0%',
    lp:         parseFloat(getConfig('lp_total')         || '0'),
    today:      parseFloat(getConfig('daily_achieved')   || '0'),
  }
}

export function dbHealth() {
  return { ok: true, configKeys: _cfg.size, executions: _execs.length, engine: 'pure-js' }
}

// ── Init ──────────────────────────────────────────────────────────────────────
export async function initDB() {
  loadCfg()
  loadExecs()
  setInterval(saveCfg,   10000)
  setInterval(saveExecs, 30000)
  console.log('[DB] Pure JS store — zero native deps — ready')
}

process.on('SIGTERM', () => { saveCfg(); saveExecs() })
process.on('exit',    () => { saveCfg(); saveExecs() })
