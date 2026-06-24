// X7-SV · dashboard.js — Express + WebSocket server · REST API · Nightfall backend

import express from 'express'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { getConfig, setConfig, getExecutions, getStats } from './db.js'
import { getActiveChains } from './chains.js'
import { getExecutorAddress, getContractAddr } from './pimlico.js'
import { getSVStats } from './vaults.js'
import { getAllBalances, withdraw, startTreasury } from './treasury.js'
import { getPropellerStats, getPropellerConfig, setPropellerConfig } from './propellers.js'
import { getStreamStats, getSolverStats, processOrder } from './revenue.js'
import { getBootstrapStatus } from './bootstrap.js'
import { on } from './events.js'

const __dir  = dirname(fileURLToPath(import.meta.url))
const app    = express()
const server = createServer(app)
const wss    = new WebSocketServer({ server })
const PORT   = process.env.PORT || 3000
// FIXED: passkey fallback — never exposes literal __PASSKEY__
const PASSKEY = process.env.NIGHTFALL_PASSKEY || '3530588'

app.use(express.json())

// ── WEBSOCKET ────────────────────────────────────────────────────────────────
const clients = new Set()

export function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() })
  clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg) })
}

wss.on('connection', ws => {
  clients.add(ws)
  ws.on('close', () => clients.delete(ws))
  // Send full state on connect
  buildOverview().then(d => ws.send(JSON.stringify({ type:'tick', data:d }))).catch(() => {})
})

// Forward events to WebSocket clients
on('sv_update',     d => broadcast('sv_update',     d))
on('missed_rev',    d => broadcast('missed_rev',     d))
on('mega_swap',     d => broadcast('mega_swap',      d))
on('deploy_success',d => broadcast('deploy_success', d))
on('chain_funding', d => broadcast('chain_funding',  d))
on('propeller_fire',d => broadcast('propeller_fire', d))
on('revenue_stream',d => broadcast('revenue_stream', d))
on('depeg_detected',d => broadcast('depeg_detected', d))
on('cex_price',     d => broadcast('cex_price',      d))

// ── HEALTH (binds first — Railway checks this) ────────────────────────────────
app.get('/health', (_, res) => res.json({ status:'ok', uptime: process.uptime()|0 }))

// ── OVERVIEW ─────────────────────────────────────────────────────────────────
async function buildOverview() {
  const stats    = getStats()
  const sv       = getSVStats()
  const balances = await getAllBalances()
  const chains   = {}
  const bootstrap= getBootstrapStatus()

  getActiveChains().forEach(c => {
    chains[c.name] = {
      contract: getContractAddr(c.name) || getConfig('deploy_status_'+c.name) || 'waiting',
      balance:  balances[c.name] || '0',
      profit24: parseFloat(getConfig('profit24_'+c.name)||'0'),
      tier:     c.tier,
      deployStatus: getConfig('deploy_status_'+c.name) || 'waiting'
    }
  })

  return {
    totalRevenue:  stats.profit,
    todayRevenue:  stats.today,
    executor:      getExecutorAddress(),
    balances, chains, sv,
    prices:        JSON.parse(getConfig('prices')||'{}'),
    propellers:    getPropellerConfig(),
    propellerStats:getPropellerStats(),
    solver:        getSolverStats(),
    revenue:       getStreamStats(),
    bootstrap,
    stats: { total:stats.total, winRate:stats.winRate, profit:stats.profit },
    recentExecutions: getExecutions(20),
    uptime:  process.uptime()|0,
    activeChains: getActiveChains().length
  }
}

app.get('/api/overview',    async (_, res) => { try { res.json(await buildOverview()) } catch(e) { res.json({ initializing:true }) } })
app.get('/api/executions',  (req, res) => { res.json({ executions:getExecutions(100, req.query.sv||''), stats:getStats() }) })
app.get('/api/treasury',    async (_, res) => {
  const stats = getStats(); const b = await getAllBalances(); const by = {}
  getActiveChains().forEach(c => { by[c.name] = parseFloat(getConfig('profit24_'+c.name)||'0') })
  res.json({ totalRevenue:stats.profit, byChain:by, autoWithdraw:getConfig('auto_withdraw')==='true', balances:b })
})
app.get('/api/system', (_, res) => {
  const m = process.memoryUsage()
  res.json({
    uptime:process.uptime()|0, memory:(m.rss/1024/1024).toFixed(0)+'MB',
    heapUsed:(m.heapUsed/1024/1024).toFixed(0)+'MB',
    activeChains:getActiveChains(), dbReady:true,
    envStatus:{
      EXECUTOR_KEY:   !!process.env.EXECUTOR_PRIVATE_KEY,
      ALCHEMY_ETH:    !!process.env.ALCHEMY_ETH_KEY,
      ALCHEMY_ARB:    !!process.env.ALCHEMY_ARB_KEY,
      ALCHEMY_POL:    !!process.env.ALCHEMY_POL_KEY,
      PIMLICO:        !!process.env.PIMLICO_API_KEY,
      MODEM_PAY:      !!process.env.MODEM_PAY_SECRET_KEY,
      DATABASE_URL:   !!process.env.DATABASE_URL,
    }
  })
})
app.get('/api/bootstrap',   (_, res) => res.json(getBootstrapStatus()))
app.get('/api/revenue',     (_, res) => res.json(getStreamStats()))

// ── CONTROLS ─────────────────────────────────────────────────────────────────
app.post('/api/config',    (req, res) => { const { key, value } = req.body; if (key) { setConfig(key, value); res.json({ ok:true }) } else res.status(400).json({ error:'key required' }) })
app.post('/api/propeller', (req, res) => { const { key, value } = req.body; if (key) { setPropellerConfig(key, value); broadcast('propeller_update', getPropellerConfig()); res.json({ ok:true, config:getPropellerConfig() }) } else res.status(400).json({ error:'key required' }) })
app.post('/api/withdraw',  async (req, res) => { const { amount } = req.body; if (!amount) return res.status(400).json({ error:'amount required' }); try { res.json(await withdraw(parseFloat(amount))) } catch(e) { res.status(500).json({ error:e.message }) } })
app.post('/api/toggle-auto-withdraw', (req, res) => { const c = getConfig('auto_withdraw')==='true'; setConfig('auto_withdraw', String(!c)); res.json({ autoWithdraw:!c }) })

// Solver order intake (Architecture 2 — Stream 1)
app.post('/api/order', async (req, res) => {
  try { res.json(await processOrder(req.body)) }
  catch(e) { res.status(500).json({ error:e.message }) }
})

// ── SERVE NIGHTFALL UI ───────────────────────────────────────────────────────
const uiPath = join(__dir, 'dashboard/nightfall.html')
app.get('/', (_, res) => {
  if (existsSync(uiPath)) {
    const html = readFileSync(uiPath, 'utf8').replace('__PASSKEY__', PASSKEY)
    res.send(html)
  } else {
    res.send('<h1>X7-SV Nightfall</h1><p>Starting up...</p>')
  }
})

export function startDashboard() {
  server.listen(PORT, () => console.log(`[DASHBOARD] Nightfall live on :${PORT}`))
  // Broadcast tick every 3s
  setInterval(async () => {
    try { broadcast('tick', await buildOverview()) } catch {}
  }, 3000)
}
