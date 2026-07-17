// Vanguard · db.js — Zero native dependencies
// Uses pure JavaScript Map for config (in-memory, fast)
// Persists to JSON file — no SQLite, no node-gyp, no Python, no gcc
// Falls back gracefully if /data volume not mounted

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'

const DB_PATH     = process.env.DB_PATH || '/data/vanguard.db.json'
const EXEC_PATH   = process.env.DB_PATH
  ? process.env.DB_PATH.replace('.json', '_execs.json')
  : '/data/vanguard_execs.json'

// ── In-memory store ───────────────────────────────────────────────────────────
const _config = new Map()
const _execs  = []          // ring buffer, max 10K entries
let   _dirty  = false
let   _execDirty = false

// ── Load from disk ─────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    if (!existsSync(DB_PATH)) return
    const raw  = readFileSync(DB_PATH, 'utf8')
    const data = JSON.parse(raw)
    for (const [k, v] of Object.entries(data)) _config.set(k, String(v))
    console.log(`[DB] Loaded ${_config.size} config keys from ${DB_PATH}`)
  } catch(e) {
    console.warn('[DB] Config load error (starting fresh):', e.message?.slice(0,60))
  }
}

function loadExecs() {
  try {
    if (!existsSync(EXEC_PATH)) return
    const raw  = readFileSync(EXEC_PATH, 'utf8')
    const data = JSON.parse(raw)
    if (Array.isArray(data)) {
      _execs.push(...data.slice(-1000))  // restore last 1K executions
      console.log(`[DB] Loaded ${_execs.length} executions from ${EXEC_PATH}`)
    }
  } catch {}
}

// ── Persist to disk (batched, every 10s) ──────────────────────────────────────
function persistConfig() {
  if (!_dirty) return
  _dirty = false
  try {
    const dir = dirname(DB_PATH)
    mkdirSync(dir, { recursive: true })
    const obj = Object.fromEntries(_config)
    writeFileSync(DB_PATH, JSON.stringify(obj), 'utf8')
  } catch {
    // Silent — /data may not be mounted. In-memory still works.
  }
}

function persistExecs() {
  if (!_execDirty) return
  _execDirty = false
  try {
    const dir = dirname(EXEC_PATH)
    mkdirSync(dir, { recursive: true })
    writeFileSync(EXEC_PATH, JSON.stringify(_execs.slice(-1000)), 'utf8')
  } catch {}
}

// ── Public API ────────────────────────────────────────────────────────────────
export function getConfig(key) {
  return _config.get(key) ?? null
}

export function setConfig(key, value) {
  _config.set(key, String(value))
  _dirty = true
}

export function delConfig(key) {
  _config.delete(key)
  _dirty = true
}

export function bulkSetConfig(pairs) {
  for (const [k, v] of pairs) _config.set(k, String(v))
  _dirty = true
}

// ── Executions ────────────────────────────────────────────────────────────────
export function recordExecution({ txHash, chain, protocol, profitUsdc, gasUsed, status }) {
  const entry = {
    txHash:      txHash     || '',
    chain:       chain      || '',
    protocol:    protocol   || '',
    profit_usdc: profitUsdc || 0,
    gas_used:    gasUsed    || 0,
    status:      status     || 'pending',
    ts:          Math.floor(Date.now() / 1000),
  }

  _execs.push(entry)
  if (_execs.length > 10000) _execs.shift()  // ring buffer
  _execDirty = true

  // Running totals
  const prev  = parseFloat(getConfig('all_time_profit')  || '0')
  const count = parseInt(getConfig('total_executions')   || '0')
  setConfig('all_time_profit',  (prev + (profitUsdc || 0)).toFixed(2))
  setConfig('total_executions', String(count + 1))

  if (status === 'success') {
    const wins = parseInt(getConfig('total_wins') || '0')
    setConfig('total_wins', String(wins + 1))
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
    winRate:    getConfig('win_rate')  || '0%',
    lp:         parseFloat(getConfig('lp_total')         || '0'),
    today:      parseFloat(getConfig('daily_achieved')   || '0'),
  }
}

export function dbHealth() {
  return {
    ok:         true,
    configKeys: _config.size,
    executions: _execs.length,
    path:       DB_PATH,
    engine:     'pure-js-json',
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
export async function initDB() {
  loadConfig()
  loadExecs()
  setInterval(persistConfig, 10000)
  setInterval(persistExecs,  30000)
  console.log('[DB] Pure JS store ready — zero native dependencies')
  console.log(`[DB] Config: ${_config.size} keys | Execs: ${_execs.length} entries`)
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on('SIGTERM', () => { persistConfig(); persistExecs() })
process.on('exit',    () => { persistConfig(); persistExecs() })
