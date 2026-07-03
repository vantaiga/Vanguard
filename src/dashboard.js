// Vanguard · dashboard.js
// FIX 1: events no longer broadcast raw partials — all trigger throttled full state rebuild
// FIX 2: buildState() now includes every field the HTML reads
// FIX 3: single server bind, no close/reopen race
import express from 'express'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { getConfig, getStats, getExecutions } from './db.js'
import { getActive } from './chains.js'
import { getExecutorAddress, getContractAddr } from './pimlico.js'
import { getSVStats } from './vaults.js'
import { getStreamStats, getLPTotal, handleSolveRequest } from './revenue.js'
import { getBootstrapStatus } from './bootstrap.js'
import { getRuleAIStatus } from './rule-ai.js'
import { getScannerStats } from './scanner.js'
import { getFunded } from './balance-watcher.js'
import { on } from './events.js'

const __dir  = dirname(fileURLToPath(import.meta.url))
const app    = express()
const server = createServer(app)
const wss    = new WebSocketServer({ server })
const PORT   = process.env.PORT || 3000
const PASS   = process.env.NIGHTFALL_PASSKEY || '3530588'

app.use(express.json())

// ── WebSocket ─────────────────────────────────────────────────────────────────
const _clients = new Set()

function broadcast(data) {
  // Always send type:'tick' with full state — clients only render on tick
  const m = JSON.stringify({ type: 'tick', data, ts: Date.now() })
  _clients.forEach(ws => { if (ws.readyState === 1) ws.send(m) })
}

wss.on('connection', ws => {
  _clients.add(ws)
  ws.on('close', () => _clients.delete(ws))
  // Send full state immediately on connect
  buildState().then(d => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'tick', data: d, ts: Date.now() }))
  }).catch(() => {})
})

// FIX: events previously broadcast raw partial payloads which stomped the dashboard
// on every cex_price tick (multiple times/second).
// Now: any event schedules a throttled FULL state rebuild. One rebuild per second max.
let _rebuildPending = false
function scheduleRebuild() {
  if (_rebuildPending) return
  _rebuildPending = true
  setTimeout(async () => {
    _rebuildPending = false
    try { broadcast(await buildState()) } catch {}
  }, 1000)
}

;['sv_update','deploy_success','arb_opportunity','revenue_stream',
  'depeg_detected','rule_ai_alert','chain_funded','first_deploy']
  .forEach(evt => on(evt, scheduleRebuild))

// cex_price fires every 50ms — debounce separately (don't rebuild on every tick)
let _cexDebounce = null
on('cex_price', () => {
  clearTimeout(_cexDebounce)
  _cexDebounce = setTimeout(scheduleRebuild, 5000)  // rebuild at most every 5s from CEX
})

// mega_swap fires often — schedule rebuild but don't spam
on('mega_swap', scheduleRebuild)

// ── buildState — every field the HTML reads ───────────────────────────────────
async function buildState() {
  try {
    const stats    = getStats()          // { total, winRate, profit, today }
    const sv       = getSVStats()        // { sv:{sv1..sv10}, total }
    const boot     = getBootstrapStatus()
    const ai       = getRuleAIStatus()
    const sc       = getScannerStats()   // { gapsDetected, trackedPools, pairs, gaps[] }
    const streams  = getStreamStats()    // { streams:{S1..S5}, total }
    const execAddr = getExecutorAddress()
    const activeList = getActive()

    // Build chain map + counts
    const chains = {}
    let liveCount = 0
    activeList.forEach(c => {
      const addr   = getContractAddr(c.name)
      const status = addr ? 'live' : (getConfig('deploy_status_' + c.name) || 'waiting')
      if (status === 'live') liveCount++
      chains[c.name] = { status, address: addr || null, tier: c.tier, native: c.native }
    })
    const totalChains = activeList.length

    // thisHour — from execution log, last 3600s
    const recentExecs = getExecutions(100)
    const nowTs  = Math.floor(Date.now() / 1000)
    const thisHour = recentExecs
      .filter(e => (nowTs - (e.ts || 0)) < 3600 && e.status === 'success')
      .reduce((s, e) => s + (e.profit_usdc || 0), 0)

    const lpTotal  = getLPTotal()
    const uptime   = process.uptime() | 0
    const memory   = Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
    const prices   = JSON.parse(getConfig('prices') || '{}')
    const create2  = getConfig('create2_address') || null

    return {
      // Top-level convenience (some HTML reads these directly)
      uptime,
      memory,
      liveCount,
      totalChains,
      lp: lpTotal,

      // Nested groups (other HTML reads these)
      system: { uptime, memory },

      revenue: {
        allTime:    stats.profit   || 0,
        today:      stats.today    || 0,
        thisHour:   thisHour       || 0,
        winRate:    stats.winRate  || '0%',
        executions: stats.total    || 0,
        lp:         lpTotal        || 0,
      },

      sv: {
        stats: sv.sv   || {},
        total: sv.total || 0,
      },

      streams,  // { streams:{S1..S5}, total }

      chains,
      liveCount,
      totalChains,

      executor: {
        address: execAddr || null,
        funded:  getFunded(),
        create2,
      },

      bootstrap: boot,
      ai,
      scanner:  sc,
      prices,
      recentExecutions: recentExecs.slice(0, 50),
    }
  } catch(e) {
    console.error('[DASHBOARD] buildState error:', e.message?.slice(0, 100))
    return {
      uptime: process.uptime()|0, memory: 0, liveCount: 0, totalChains: 17,
      system: { uptime: process.uptime()|0, memory: 0 },
      revenue: { allTime:0, today:0, thisHour:0, winRate:'0%', executions:0, lp:0 },
      sv: { stats:{}, total:0 }, streams: { streams:{}, total:0 },
      chains: {}, executor: { address: null, funded: [], create2: null },
      bootstrap: {}, ai: {}, scanner: { gapsDetected:0, pairs:0, trackedPools:0, gaps:[] },
      prices: {}, recentExecutions: []
    }
  }
}

// ── REST API ──────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true, uptime: process.uptime()|0, system: 'Vanguard' }))

app.get('/api/state', async (_, res) => {
  try { res.json(await buildState()) }
  catch(e) { res.json({ error: e.message, initializing: true }) }
})

app.get('/api/executions', (_, res) => res.json(getExecutions(100)))
app.get('/api/deploy',     (_, res) => res.json(getBootstrapStatus()))
app.get('/api/ai',         (_, res) => res.json(getRuleAIStatus()))
app.get('/api/scanner',    (_, res) => res.json(getScannerStats()))
app.get('/api/prices',     (_, res) => res.json(JSON.parse(getConfig('prices') || '{}')))

app.get('/api/fund-info', (_, res) => res.json({
  executor: getExecutorAddress(),
  create2:  getConfig('create2_address') || null,
  funded:   getFunded(),
  chains: [
    { name:'polygon',  token:'POL', amount:'0.01',  costUSD: 0.003, expected:'$30K–$500K' },
    { name:'base',     token:'ETH', amount:'0.001', costUSD: 1.54,  expected:'$30K–$500K' },
    { name:'arbitrum', token:'ETH', amount:'0.001', costUSD: 1.54,  expected:'$30K–$500K' },
    { name:'ethereum', token:'ETH', amount:'0.01',  costUSD: 15.40, expected:'$30K–$500K' },
  ],
  status: getBootstrapStatus()
}))

// CoW Protocol solver — register at docs.cow.fi/cow-protocol/tutorials/solvers/onboard
app.post('/solve/:env/:network', (req, res) => {
  try { res.json(handleSolveRequest(req.body)) }
  catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Dashboard files ───────────────────────────────────────────────────────────
const desktopPath = join(__dir, 'dashboard/nightfall.html')
const mobilePath  = join(__dir, 'dashboard/nightfall-black.html')

function serveDash(path, res) {
  if (existsSync(path)) {
    res.send(readFileSync(path, 'utf8').replace(/__PASSKEY__/g, PASS))
  } else {
    res.send('<h1>Vanguard</h1><p>Dashboard starting...</p>')
  }
}

app.get('/', (req, res) => {
  const mob = /Mobile|Android|iPhone|iPad/.test(req.headers['user-agent'] || '')
  serveDash(mob && existsSync(mobilePath) ? mobilePath : desktopPath, res)
})
app.get('/mobile',  (_, res) => serveDash(mobilePath,  res))
app.get('/desktop', (_, res) => serveDash(desktopPath, res))

// ── Start ─────────────────────────────────────────────────────────────────────
export function startDashboard() {
  server.listen(PORT, () => {
    console.log(`[DASHBOARD] Vanguard Nightfall · :${PORT}`)
    console.log('[DASHBOARD] /health · /api/state · /solve/{env}/{network}')
  })
  // Push full state every 3s regardless of events
  setInterval(async () => {
    try { broadcast(await buildState()) } catch {}
  }, 3000)
}

export { buildState, broadcast }
