// Vanguard · db.js — SQLite persistence layer
// Uses better-sqlite3 (synchronous, no async overhead)
// WAL mode: fast writes, safe reads
// Volume mount: /data/vanguard.db (Railway persistent volume)
// Exports: initDB, getConfig, setConfig, recordExecution, getExecutions, getStats

import Database from 'better-sqlite3'
import { existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'

const DB_PATH = process.env.DB_PATH || '/data/vanguard.db'

// Ensure /data directory exists
try {
  const dir = dirname(DB_PATH)
  if (!mkdirSync) {}
  mkdirSync(dir, { recursive: true })
} catch {}

let _db = null

// ── Init ──────────────────────────────────────────────────────────────────────
export async function initDB() {
  try {
    _db = new Database(DB_PATH, { verbose: null })

    // WAL mode for concurrent reads + fast writes
    _db.pragma('journal_mode = WAL')
    _db.pragma('synchronous = NORMAL')
    _db.pragma('cache_size = -32000')   // 32MB cache
    _db.pragma('temp_store = MEMORY')
    _db.pragma('mmap_size = 268435456') // 256MB mmap

    await migrateFirst()
    console.log(`[DB] SQLite ready: ${DB_PATH}`)
    console.log(`[DB] WAL mode · 32MB cache · mmap enabled`)
  } catch(e) {
    console.error('[DB] Fatal init error:', e.message)
    // Fall back to in-memory DB so system still boots
    _db = new Database(':memory:', { verbose: null })
    _db.pragma('journal_mode = WAL')
    await migrateFirst()
    console.warn('[DB] Using in-memory fallback — data will not persist across restarts')
  }
}

// ── Schema migrations ─────────────────────────────────────────────────────────
async function migrateFirst() {
  // config table — key/value store for all operational state
  _db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      ts    INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `)

  // executions table — every arb/MEV execution
  _db.exec(`
    CREATE TABLE IF NOT EXISTS executions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tx_hash     TEXT,
      chain       TEXT,
      protocol    TEXT,
      profit_usdc REAL DEFAULT 0,
      gas_used    REAL DEFAULT 0,
      status      TEXT DEFAULT 'pending',
      ts          INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `)

  // Add ts column if upgrading from older schema that lacked it
  try { _db.exec(`ALTER TABLE executions ADD COLUMN ts INTEGER NOT NULL DEFAULT (unixepoch())`) } catch {}

  // Index for fast time-range queries
  _db.exec(`CREATE INDEX IF NOT EXISTS idx_exec_ts    ON executions(ts)`)
  _db.exec(`CREATE INDEX IF NOT EXISTS idx_exec_chain ON executions(chain)`)
  _db.exec(`CREATE INDEX IF NOT EXISTS idx_exec_status ON executions(status)`)
}

// ── Prepared statements (cached for performance) ──────────────────────────────
let _stmts = {}

function stmt(key, sql) {
  if (!_stmts[key]) _stmts[key] = _db.prepare(sql)
  return _stmts[key]
}

// ── Config: key/value store ───────────────────────────────────────────────────
// Used by every module — synchronous, sub-millisecond (SQLite WAL)
const _cache = new Map()  // in-memory cache — avoids SQLite reads on hot path

export function getConfig(key) {
  // Check memory cache first (hot path — zero disk I/O)
  if (_cache.has(key)) return _cache.get(key)
  if (!_db) return null
  try {
    const row = stmt('getConfig', 'SELECT value FROM config WHERE key = ?').get(key)
    const val = row?.value ?? null
    if (val !== null) _cache.set(key, val)
    return val
  } catch { return null }
}

export function setConfig(key, value) {
  _cache.set(key, String(value))  // update cache immediately
  if (!_db) return
  try {
    stmt('setConfig', 'INSERT OR REPLACE INTO config (key, value, ts) VALUES (?, ?, unixepoch())')
      .run(key, String(value))
  } catch(e) {
    // Silent — config is cached in memory, DB write is best-effort
  }
}

export function delConfig(key) {
  _cache.delete(key)
  if (!_db) return
  try { stmt('delConfig', 'DELETE FROM config WHERE key = ?').run(key) } catch {}
}

// ── Executions ────────────────────────────────────────────────────────────────
export function recordExecution({ txHash, chain, protocol, profitUsdc, gasUsed, status }) {
  if (!_db) return
  try {
    stmt('insertExec', `
      INSERT INTO executions (tx_hash, chain, protocol, profit_usdc, gas_used, status, ts)
      VALUES (?, ?, ?, ?, ?, ?, unixepoch())
    `).run(
      txHash    || '',
      chain     || '',
      protocol  || '',
      profitUsdc || 0,
      gasUsed   || 0,
      status    || 'pending'
    )

    // Update running totals in config cache (avoids extra reads)
    const prev  = parseFloat(getConfig('all_time_profit') || '0')
    const execs = parseInt(getConfig('total_executions') || '0')
    setConfig('all_time_profit',  (prev + (profitUsdc || 0)).toFixed(2))
    setConfig('total_executions', String(execs + 1))

    // Win rate
    if (status === 'success') {
      const wins = parseInt(getConfig('total_wins') || '0')
      setConfig('total_wins', String(wins + 1))
    }
    const totalE = parseInt(getConfig('total_executions') || '0')
    const totalW = parseInt(getConfig('total_wins') || '0')
    if (totalE > 0) {
      setConfig('win_rate', ((totalW / totalE) * 100).toFixed(1) + '%')
    }
  } catch(e) {
    // Silent — execution recording is non-critical
  }
}

export function getExecutions(limit = 50, chain = null) {
  if (!_db) return []
  try {
    if (chain) {
      return stmt('getExecsByChain', `
        SELECT tx_hash as txHash, chain, protocol, profit_usdc, status, ts
        FROM executions WHERE chain = ? ORDER BY ts DESC LIMIT ?
      `).all(chain, Math.min(limit, 1000)).map(mapExec)
    }
    return stmt('getExecs', `
      SELECT tx_hash as txHash, chain, protocol, profit_usdc, status, ts
      FROM executions ORDER BY ts DESC LIMIT ?
    `).all(Math.min(limit, 1000)).map(mapExec)
  } catch { return [] }
}

function mapExec(row) {
  return {
    txHash:      row.txHash,
    chain:       row.chain,
    protocol:    row.protocol,
    profit_usdc: row.profit_usdc,
    status:      row.status,
    ts:          row.ts,
  }
}

// ── Stats ─────────────────────────────────────────────────────────────────────
export function getStats() {
  const profit     = parseFloat(getConfig('all_time_profit') || '0')
  const executions = parseInt(getConfig('total_executions') || '0')
  const wins       = parseInt(getConfig('total_wins') || '0')
  const winRate    = executions > 0 ? ((wins / executions) * 100).toFixed(1) + '%' : '0%'

  return {
    profit,
    executions,
    wins,
    winRate,
    lp:      parseFloat(getConfig('lp_total') || '0'),
    today:   parseFloat(getConfig('daily_achieved') || '0'),
  }
}

// ── Bulk config for startup ────────────────────────────────────────────────────
export function bulkSetConfig(pairs) {
  if (!_db) return
  const insertMany = _db.transaction((rows) => {
    const s = stmt('setConfig', 'INSERT OR REPLACE INTO config (key, value, ts) VALUES (?, ?, unixepoch())')
    for (const [key, value] of rows) {
      _cache.set(key, String(value))
      s.run(key, String(value))
    }
  })
  try { insertMany(pairs) } catch {}
}

// ── Health check ──────────────────────────────────────────────────────────────
export function dbHealth() {
  if (!_db) return { ok: false, error: 'No database connection' }
  try {
    const row = _db.prepare('SELECT COUNT(*) as n FROM config').get()
    return { ok: true, configRows: row.n, path: DB_PATH }
  } catch(e) {
    return { ok: false, error: e.message }
  }
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  try { _db?.close(); console.log('[DB] Closed gracefully') } catch {}
})
process.on('exit', () => {
  try { _db?.close() } catch {}
})
