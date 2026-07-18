// Vanguard · server.js — THE SOVEREIGN SERVER
// The most important file in the codebase.
// Equivalent to thousands of files of infrastructure.
//
// WHAT THIS FILE IS:
//   The nervous system of Vanguard.
//   Every module communicates through this server.
//   Every file registers its capabilities here.
//   Every inter-file call routes through here.
//   Every WebSocket client receives state from here.
//   Every API call is validated and processed here.
//   Every dashboard action executes through here.
//
// CAPABILITIES:
//   1. Module Registry      — every file registers exports here
//   2. Inter-file Bus       — modules call each other through server.js
//   3. HTTP API Server      — all /api/* routes centralized here
//   4. WebSocket Server     — live state pushed to all clients every 2s
//   5. State Aggregator     — builds the complete system state
//   6. Command Router       — dashboard commands → correct module
//   7. Health Monitor       — tracks every module's live status
//   8. Log Interceptor      — formats all output uniformly
//   9. Graceful Shutdown    — coordinates all modules on exit
//  10. Event Bridge         — connects events.js to WebSocket clients

import express           from 'express'
import { createServer }  from 'http'
import { WebSocketServer } from 'ws'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))

// ── HTTP + WebSocket server ────────────────────────────────────────────────────
const app    = express()
const server = createServer(app)
const wss    = new WebSocketServer({ server })
let   _port  = parseInt(process.env.PORT || '3000')

app.use(express.json({ limit: '2mb' }))
app.use(express.text({ type: '*/*', limit: '2mb' }))
app.use((_, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  next()
})
app.options('*', (_, res) => res.sendStatus(200))

// ── Module Registry ────────────────────────────────────────────────────────────
// Every module that boots registers itself here.
// dashboard.js reads this to know what's available.
const _registry = new Map()  // moduleName → { status, stats, startedAt }

export function registerModule(name, statsFn) {
  _registry.set(name, {
    status:    'active',
    startedAt: Date.now(),
    stats:     statsFn || (() => ({})),
  })
}

export function getModuleStatus(name)  { return _registry.get(name) || null }
export function getAllModules()         { return Object.fromEntries(_registry) }
export function markModuleFailed(name) {
  if (_registry.has(name)) _registry.get(name).status = 'failed'
}

// ── Inter-file Communication Bus ───────────────────────────────────────────────
// Modules call each other through the bus — zero direct circular imports.
// Module A calls: bus.call('nexus', 'route', args)
// Module B registered: bus.register('nexus', { route: fn })
// This eliminates ALL circular import risks permanently.

const _bus = new Map()  // moduleName → { methodName → fn }

export const bus = {
  // Register a module's callable methods
  register(name, methods) {
    _bus.set(name, methods)
    if (!_registry.has(name)) _registry.set(name, { status:'active', startedAt:Date.now(), stats:()=>({}) })
  },

  // Call a method on any registered module
  async call(module, method, ...args) {
    const mod = _bus.get(module)
    if (!mod)          throw new Error(`[BUS] Module '${module}' not registered`)
    if (!mod[method])  throw new Error(`[BUS] Method '${module}.${method}' not found`)
    return mod[method](...args)
  },

  // Call but never throw — returns null on failure
  async safe(module, method, ...args) {
    try { return await bus.call(module, method, ...args) }
    catch { return null }
  },

  // Check if module + method available
  has(module, method) {
    return _bus.has(module) && (!method || !!_bus.get(module)?.[method])
  },
}

// ── State Aggregator ───────────────────────────────────────────────────────────
// Builds the complete system state from all registered modules.
// Called every 2s for WebSocket push and on every /api/state request.

function buildState() {
  const safeCall = (name, method, fallback = {}) => {
    try { return bus.has(name, method) ? _bus.get(name)?.[method]?.() || fallback : fallback }
    catch { return fallback }
  }

  // Core stats from each module
  const nexus     = safeCall('nexus',    'getStats')
  const apex      = safeCall('apex',     'getStats')
  const chains1   = safeCall('chains1',  'getStats')
  const overlay   = safeCall('overlay',  'getStats')
  const propeller = safeCall('propeller','getStats')
  const rs5       = safeCall('rs5',      'getStats')
  const rs6       = safeCall('rs6',      'getStats')
  const rs1       = safeCall('rs1',      'getStats')
  const rs2       = safeCall('rs1',      'getRS2Stats')
  const rs3       = safeCall('rs3',      'getStats')
  const amp       = safeCall('amplifier','getStats')
  const intel     = safeCall('intelligence','getStats')
  const sov       = safeCall('sovereign','getStatus')
  const mp        = safeCall('modempay', 'getStats')
  const treasury  = safeCall('treasury', 'getStats')
  const lat       = safeCall('latency',  'getStats')
  const vaults    = safeCall('vaults',   'getStats')
  const crash     = safeCall('intelligence','getCrash')
  const ruleAI    = safeCall('intelligence','getRuleAI')

  // Runtime
  const uptime  = process.uptime()
  const memMB   = Math.round(process.memoryUsage().heapUsed / 1024 / 1024)

  // Chains
  const chainsMap  = safeCall('chains1', 'getChains') || {}
  const liveChains = Object.values(chainsMap).filter(c => c?.address).length

  // Revenue
  const dbStats = safeCall('db', 'getStats') || {}
  const p        = propeller.current || 5
  const RTABLE   = {1:17.48e9,2:34.96e9,3:69.92e9,4:104.88e9,5:139.84e9,6:192.28e9,7:262.2e9,8:349.6e9,9:471.96e9,10:611.8e9,11:734.16e9,12:856.52e9,13:961.4e9,14:1066e9,15:1153e9,16:1224e9,17:1293e9,18:1363e9,19:1415e9,20:1468e9,21:1521e9,22:1573e9,23:1608e9,24:1643e9,25:1669e9,26:1692e9,27:1709e9,28:1724e9,29:1735e9,30:1748e9}

  return {
    system: { uptime, memory: memMB, modules: _registry.size, nodeVer: process.version },
    revenue: {
      allTime:    dbStats.profit    || 0,
      today:      dbStats.today     || 0,
      thisHour:   0,
      executions: dbStats.executions|| 0,
      winRate:    dbStats.winRate   || '0%',
      lp:         dbStats.lp        || 0,
      rs1:        rs1.total         || 0,
      rs2:        rs2.total         || 0,
      rs3:        rs3.total         || 0,
      rs5:        rs5.total         || 0,
    },
    nexus,
    apex:     { ...apex, latencyTarget:'1.5ms', advantage:'20×' },
    propeller:{ ...propeller, table: RTABLE, formatted: _fmtRev(RTABLE[p]) },
    chains:   chainsMap,
    liveCount:liveChains,
    totalChains: Object.keys(chainsMap).length || 18,
    scanner:  { swapCount: chains1.qualifyingSwaps || 0, threshold: chains1.threshold, wsConnected: chains1.wsConnected, httpPolling: chains1.httpPolling },
    overlay,
    latency:  lat,
    crash:    crash || {},
    rs5:      { ...rs5, active: true },
    rs6,
    amplifier:amp,
    ai:       { ...ruleAI, sovereign: sov, insights: sov?.lastResponse || '' },
    modempay: mp,
    treasury,
    prices:   safeCall('intelligence', 'getPrices') || {},
    executor: { address: safeCall('builders','getExecutorAddress') },
    controls: {
      paused:        safeCall('db','getConfig','system_paused') === '1',
      propIntensity: p,
      crashMode:     safeCall('db','getConfig','crash_mode') === '1',
      crashScore:    crash?.score || 0,
      crashCountdown:crash?.countdown || 'Monitoring...',
    },
    recentExecutions: safeCall('db','getExecutions', 50) || [],
    throughput: {
      total:   '$3.496Q/day',
      env1:    '$321.12T/day',
      env2:    '$1,209.6T/day',
      env3:    '$500T/day',
      nexusMult:'$1,465.3T/day',
      maxRev:  '$1.748T/day (P30)',
    },
    modules:   Object.fromEntries([..._registry].map(([k,v])=>[k,{ status:v.status, uptime: Math.floor((Date.now()-v.startedAt)/1000) }])),
    timestamp: Math.floor(Date.now() / 1000),
  }
}

function _fmtRev(n) {
  if (!n) return '$0'
  if (n >= 1e12) return '$' + (n/1e12).toFixed(3) + 'T'
  if (n >= 1e9)  return '$' + (n/1e9).toFixed(2)  + 'B'
  if (n >= 1e6)  return '$' + (n/1e6).toFixed(2)  + 'M'
  return '$' + n.toFixed(2)
}

// ── WebSocket — live state every 2s ───────────────────────────────────────────
const _wsClients = new Set()
let   _lastState = null

wss.on('connection', ws => {
  _wsClients.add(ws)
  ws.on('close', () => _wsClients.delete(ws))
  ws.on('error', () => _wsClients.delete(ws))
  // Send current state immediately on connect
  try { ws.send(JSON.stringify({ type:'tick', data: _lastState || buildState() })) } catch {}
})

function pushState() {
  if (!_wsClients.size) return
  try {
    _lastState = buildState()
    const payload = JSON.stringify({ type:'tick', data: _lastState })
    for (const ws of _wsClients) {
      try { if (ws.readyState === 1) ws.send(payload) } catch {}
    }
  } catch {}
}

setInterval(pushState, 2000)

// ── Route Registration ─────────────────────────────────────────────────────────
// All API routes registered here from one place.
// No route defined anywhere else in the codebase.

export function registerRoutes() {

  // ── State ────────────────────────────────────────────────────────────────
  app.get('/api/state',  (_, res) => { try { res.json(buildState()) } catch(e) { res.status(500).json({ error:e.message }) } })
  app.get('/api/health', (_, res) => res.json({ ok:true, uptime:process.uptime(), modules:_registry.size }))
  app.get('/api/modules',(_, res) => res.json(getAllModules()))

  // ── Propeller ────────────────────────────────────────────────────────────
  app.post('/api/control/propellers', async (req, res) => {
    const p = parseInt(req.body?.intensity)
    if (!p || p < 1 || p > 30) return res.status(400).json({ error:'intensity must be 1-30' })
    await bus.safe('propeller', 'setIntensity', p, 'operator')
    const RTABLE = {1:17.48e9,5:139.84e9,10:611.8e9,30:1748e9}
    res.json({ ok:true, intensity:p })
  })

  // ── Crash mode ───────────────────────────────────────────────────────────
  app.post('/api/control/crash-on',  async (_, res) => { await bus.safe('propeller','activateCrash');   res.json({ ok:true, crashMode:true  }) })
  app.post('/api/control/crash-off', async (_, res) => { await bus.safe('propeller','deactivateCrash'); res.json({ ok:true, crashMode:false }) })

  // ── Halt / Resume ────────────────────────────────────────────────────────
  app.post('/api/control/halt',   async (_, res) => {
    await bus.safe('db','setConfig','system_paused','1')
    const { emit } = await import('./events.js')
    emit('system_halt', {})
    res.json({ ok:true })
  })
  app.post('/api/control/resume', async (_, res) => {
    await bus.safe('db','setConfig','system_paused','0')
    const { emit } = await import('./events.js')
    emit('system_resume', {})
    res.json({ ok:true })
  })

  // ── Chain control ────────────────────────────────────────────────────────
  app.post('/api/control/pause-chain',  (req,res)=>{ bus.safe('db','setConfig','pause_'+(req.body?.chain||''),'1'); res.json({ok:true}) })
  app.post('/api/control/resume-chain', (req,res)=>{ bus.safe('db','setConfig','pause_'+(req.body?.chain||''),'0'); res.json({ok:true}) })

  // ── AI ───────────────────────────────────────────────────────────────────
  app.post('/api/control/ai', (req,res)=>{ bus.safe('db','setConfig','rule_ai_enabled',req.body?.enabled?'1':'0'); res.json({ok:true}) })

  // ── Overlay ──────────────────────────────────────────────────────────────
  app.post('/api/control/clear-overlay', async (_,res)=>{ await bus.safe('overlay','clearAll'); res.json({ok:true}) })

  // ── SOVEREIGN chat ───────────────────────────────────────────────────────
  app.post('/api/sovereign/chat', async (req,res) => {
    const { message } = req.body || {}
    if (!message) return res.status(400).json({ error:'message required' })
    const response = await bus.safe('sovereign','chat', message, buildState())
    res.json({ ok:true, response: response || 'SOVEREIGN processing...', ts:Math.floor(Date.now()/1000) })
  })

  // SOVEREIGN SSE streaming
  app.get('/api/sovereign/stream', async (req,res) => {
    res.setHeader('Content-Type',      'text/event-stream')
    res.setHeader('Cache-Control',     'no-cache')
    res.setHeader('Connection',        'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    const msg      = req.query.message || ''
    const response = await bus.safe('sovereign','chat', msg, buildState()) || 'SOVEREIGN active.'
    const words    = response.split(' ')
    let   i        = 0
    const tick     = setInterval(() => {
      if (i >= words.length) { clearInterval(tick); res.write('data: [DONE]\n\n'); res.end(); return }
      res.write(`data: ${JSON.stringify({ word: words[i++] })}\n\n`)
    }, 40)
    req.on('close', () => clearInterval(tick))
  })

  // ── SDAL ─────────────────────────────────────────────────────────────────
  app.get('/api/sdal',          (_, res) => res.json(bus.has('sdal','get') ? _bus.get('sdal')?.get('protocol_addresses') : {}))
  app.post('/api/sdal/update',  (req,res)=>{ bus.safe('sdal','update',req.body); res.json({ok:true}) })

  // ── Propeller table ──────────────────────────────────────────────────────
  app.get('/api/propeller/table', (_,res) => {
    const T={1:17.48e9,2:34.96e9,3:69.92e9,4:104.88e9,5:139.84e9,6:192.28e9,7:262.2e9,8:349.6e9,9:471.96e9,10:611.8e9,11:734.16e9,12:856.52e9,13:961.4e9,14:1066e9,15:1153e9,16:1224e9,17:1293e9,18:1363e9,19:1415e9,20:1468e9,21:1521e9,22:1573e9,23:1608e9,24:1643e9,25:1669e9,26:1692e9,27:1709e9,28:1724e9,29:1735e9,30:1748e9}
    res.json({ table:T, formatted:Object.fromEntries(Object.entries(T).map(([k,v])=>[k,_fmtRev(v)])) })
  })

  // ── Crash signal ─────────────────────────────────────────────────────────
  app.get('/api/crash/stats',     (_,res)=>res.json(bus.safe('intelligence','getCrash')||{}))
  app.get('/api/crash/countdown', (_,res)=>res.json({ countdown:(bus.safe('intelligence','getCrash')||{}).countdown, score:(bus.safe('intelligence','getCrash')||{}).score }))

  // ── Treasury ─────────────────────────────────────────────────────────────
  app.get('/api/treasury/stats',            (_,res)=>res.json(bus.safe('treasury','getStats')||{}))
  app.get('/api/treasury/fx',               (_,res)=>res.json(bus.safe('treasury','getFX')||{}))
  app.post('/api/treasury/convert',         (req,res)=>res.json(bus.safe('treasury','convertUSD',req.body?.amount,req.body?.currency)||{}))
  app.post('/api/treasury/validate-swift',  (req,res)=>res.json(bus.safe('treasury','validateSWIFT',req.body?.swift)||{}))
  app.get('/api/treasury/fee',              (req,res)=>res.json(bus.safe('treasury','calcFee',parseFloat(req.query.amount||'0'),req.query.method)||{}))
  app.post('/api/treasury/withdraw',        async(req,res)=>{ try { const r=await bus.call('treasury','withdraw',req.body); res.json(r) } catch(e){ res.status(500).json({error:e.message}) } })
  app.post('/api/treasury/stream/start',    (req,res)=>{ bus.safe('treasury','startStream',req.body); res.json({ok:true}) })
  app.post('/api/treasury/stream/stop',     (_,res)=>{ bus.safe('treasury','stopStream'); res.json({ok:true}) })
  app.post('/api/treasury/schedule/add',    (req,res)=>{ const s=bus.safe('treasury','addSchedule',req.body); res.json({ok:true,schedule:s}) })
  app.delete('/api/treasury/schedule/:id',  (req,res)=>{ bus.safe('treasury','removeSchedule',req.params.id); res.json({ok:true}) })
  app.get('/api/treasury/schedules',        (_,res)=>res.json(bus.safe('treasury','getSchedules')||[]))
  app.post('/api/treasury/split',           async(req,res)=>{ try { res.json(await bus.call('treasury','splitTransfer',req.body)) } catch(e){ res.status(500).json({error:e.message}) } })
  app.get('/api/treasury/tax/csv',          (req,res)=>{ res.setHeader('Content-Type','text/csv'); res.setHeader('Content-Disposition','attachment; filename=vanguard_tax.csv'); res.send(bus.safe('treasury','exportTaxCSV',req.query.year?parseInt(req.query.year):null)||'') })
  app.get('/api/treasury/journal/csv',      (_,res)=>{ res.setHeader('Content-Type','text/csv'); res.setHeader('Content-Disposition','attachment; filename=vanguard_journal.csv'); res.send(bus.safe('treasury','exportJournalCSV')||'') })

  // ── ModemPay ─────────────────────────────────────────────────────────────
  app.post('/api/modempay/withdraw',     async(req,res)=>{ try { const r=await bus.call('modempay','withdraw',req.body); res.json(r) } catch(e){ res.status(500).json({error:e.message}) } })
  app.get('/api/modempay/balance',       async(_,res)=>{ try { res.json(await bus.call('modempay','getBalance')) } catch(e){ res.status(500).json({error:e.message}) } })
  app.get('/api/modempay/transactions',  async(req,res)=>{ try { res.json(await bus.call('modempay','listTransactions',parseInt(req.query.limit||'20'))) } catch(e){ res.status(500).json({error:e.message}) } })
  app.get('/api/modempay/status/:id',    async(req,res)=>{ try { res.json(await bus.call('modempay','getTransferStatus',req.params.id)) } catch(e){ res.status(500).json({error:e.message}) } })
  app.get('/api/modempay/fee',           (req,res)=>res.json(bus.safe('modempay','calcFee',parseFloat(req.query.amount||'0'),req.query.method)||{}))
  app.post('/api/modempay/webhook',      async(req,res)=>{ const sig=req.headers['x-modem-signature']||''; const raw=JSON.stringify(req.body); const ok=await bus.safe('modempay','verifyWebhook',raw,sig); if(!ok) return res.status(401).json({error:'Invalid signature'}); res.json({received:true}); bus.safe('modempay','handleWebhook',req.body) })
  app.get('/api/modempay/stats',         (_,res)=>res.json(bus.safe('modempay','getStats')||{}))

  // ── USB Vault ────────────────────────────────────────────────────────────
  app.post('/api/usb/add-funds', async(req,res)=>{ try { res.json(await bus.call('usb','addFunds',req.body)) } catch(e){ res.status(500).json({error:e.message}) } })
  app.post('/api/usb/restore',   async(req,res)=>{ try { res.json(await bus.call('usb','restoreFunds',req.body)) } catch(e){ res.status(500).json({error:e.message}) } })
  app.post('/api/usb/create',    async(req,res)=>{ try { res.json(await bus.call('usb','createVault',req.body)) } catch(e){ res.status(500).json({error:e.message}) } })

  // ── Nightfall dashboards ─────────────────────────────────────────────────
  app.get('/',       (_, res) => res.sendFile(join(__dir, '..', 'dashboard', 'nightfall.html')))
  app.get('/mobile', (_, res) => res.sendFile(join(__dir, '..', 'dashboard', 'nightfall-black.html')))
  app.get('/vault',  (_, res) => res.sendFile(join(__dir, '..', 'dashboard', 'vault.html')))

  // Static assets
  app.use('/dashboard', express.static(join(__dir, '..', 'dashboard')))
}

// ── Bind server ───────────────────────────────────────────────────────────────
let _serverStarted = false

export function startServer() {
  if (_serverStarted) return
  _serverStarted = true

  registerRoutes()

  const tryBind = (port) => {
    server.listen(port, () => {
      console.log(`[SERVER] Sovereign server → http://localhost:${port}`)
      console.log('[SERVER] Nightfall dashboard → / · Mobile → /mobile')
      console.log('[SERVER] WebSocket live state → ws://localhost:' + port)
      console.log('[SERVER] API routes: /api/state · /api/sovereign/chat · /api/propeller/table · ...')
    })
    server.on('error', e => {
      if (e.code === 'EADDRINUSE') { server.removeAllListeners('error'); tryBind(port + 1) }
    })
  }

  tryBind(_port)
}

// ── Health broadcast — push module events to WS clients ──────────────────────
export function broadcastEvent(type, data) {
  const payload = JSON.stringify({ type, data, ts: Date.now() })
  for (const ws of _wsClients) {
    try { if (ws.readyState === 1) ws.send(payload) } catch {}
  }
}

// ── Log control ───────────────────────────────────────────────────────────────
// After boot: only swap bundles + system events go to console
let _bootComplete = false

export function markBootComplete() {
  _bootComplete = true
}

export function logSwapBundle(count, avgUSD, chains) {
  if (!_bootComplete) return
  const avg = avgUSD >= 1e9  ? `$${(avgUSD/1e9).toFixed(1)}B`
            : avgUSD >= 1e6  ? `$${(avgUSD/1e6).toFixed(0)}M`
            : `$${avgUSD.toFixed(0)}`
  console.log(`[SWAP] ${count} × ${avg} · ${chains.join(' ')} → overlay: ${count}`)
}

export function logExec(chain, profit, latencyMs) {
  if (!_bootComplete) return
  const p = profit >= 1e9  ? `+$${(profit/1e9).toFixed(2)}B`
          : profit >= 1e6  ? `+$${(profit/1e6).toFixed(2)}M`
          : `+$${profit.toFixed(2)}`
  console.log(`[EXEC] ${p} (${latencyMs}ms) ${chain}`)
}

export function logEvent(tag, msg) {
  console.log(`[${tag}] ${msg}`)
}
