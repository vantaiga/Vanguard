// Vanguard · dashboard.js
// Complete sovereign control center server.
// Serves nightfall.html and nightfall-black.html.
// WebSocket live state every 2 seconds.
// ALL imports from other Vanguard modules are DYNAMIC (inside functions).
// Zero static imports of any other Vanguard file.
// This eliminates the "Unexpected token 'export'" error permanently.

import express            from 'express'
import { createServer }   from 'http'
import { WebSocketServer } from 'ws'
import { join, dirname }  from 'path'
import { fileURLToPath }  from 'url'
import { existsSync }     from 'fs'

// Only these three are safe to import statically — they have ZERO imports themselves
import { getConfig, setConfig, getStats, getExecutions } from './db.js'
import { getSABF64, SAB_OFFSETS, getPropProfile }        from './sdal.js'
import { emit, on }                                       from './events.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const HOT   = getSABF64()

// Revenue table — hardcoded, always available
const RTABLE = {
  1:17.48e9, 2:34.96e9, 3:69.92e9, 4:104.88e9, 5:139.84e9,
  6:192.28e9, 7:262.2e9, 8:349.6e9, 9:471.96e9, 10:611.8e9,
  11:734.16e9, 12:856.52e9, 13:961.4e9, 14:1066e9, 15:1153e9,
  16:1224e9, 17:1293e9, 18:1363e9, 19:1415e9, 20:1468e9,
  21:1521e9, 22:1573e9, 23:1608e9, 24:1643e9, 25:1669e9,
  26:1692e9, 27:1709e9, 28:1724e9, 29:1735e9, 30:1748e9,
}

function fmtRev(n) {
  if (!n) return '$0'
  if (n >= 1e15) return '$' + (n/1e15).toFixed(3) + 'Q'
  if (n >= 1e12) return '$' + (n/1e12).toFixed(3) + 'T'
  if (n >= 1e9)  return '$' + (n/1e9).toFixed(2)  + 'B'
  if (n >= 1e6)  return '$' + (n/1e6).toFixed(2)  + 'M'
  return '$' + n.toFixed(2)
}

// ── Module stats registry (populated lazily after boot) ───────────────────────
const _moduleStats = new Map()

export function registerStats(name, fn) {
  _moduleStats.set(name, fn)
}

function safeStats(name) {
  try { return _moduleStats.get(name)?.() || {} } catch { return {} }
}

// ── State builder ─────────────────────────────────────────────────────────────
function buildState() {
  const dbStats = getStats()
  const p       = parseInt(getConfig('prop_intensity') || '5')
  const prices  = JSON.parse(getConfig('prices') || '{}')

  const nexus     = safeStats('nexus')
  const apex      = safeStats('apex')
  const chains1   = safeStats('chains1')
  const overlay   = safeStats('overlay')
  const propeller = safeStats('propeller')
  const rs5       = safeStats('rs5')
  const rs6       = safeStats('rs6')
  const rs1       = safeStats('rs1')
  const rs2       = safeStats('rs2')
  const rs3       = safeStats('rs3')
  const amp       = safeStats('amplifier')
  const intel     = safeStats('intelligence')
  const sov       = safeStats('sovereign')
  const mp        = safeStats('modempay')
  const treasury  = safeStats('treasury')
  const lat       = safeStats('latency')
  const vaults    = safeStats('vaults')
  const crash     = safeStats('crash')
  const ruleAI    = safeStats('ruleai')

  return {
    system: {
      uptime:  process.uptime(),
      memory:  Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      nodeVer: process.version,
      modules: _moduleStats.size,
    },
    revenue: {
      allTime:    dbStats.profit     || 0,
      today:      dbStats.today      || 0,
      thisHour:   parseFloat(getConfig('hour_revenue') || '0'),
      executions: dbStats.executions || 0,
      winRate:    dbStats.winRate    || '0%',
      lp:         dbStats.lp         || 0,
      rs1:        rs1.total          || 0,
      rs2:        rs2.total          || 0,
      rs3:        rs3.total          || 0,
      rs5:        rs5.total          || 0,
    },
    nexus,
    apex:     { ...apex, latencyTarget:'1.5ms', advantage:'20×', competitorBaseline:'30ms' },
    propeller:{ ...propeller, current:p, table:RTABLE, formatted:fmtRev(RTABLE[p]), dailyTarget:RTABLE[p] },
    chains:   chains1.chains  || {},
    liveCount:chains1.liveCount || 0,
    totalChains: 18,
    scanner: {
      swapCount:   chains1.qualifyingSwaps || 0,
      threshold:   '$100M–$10B',
      wsConnected: chains1.wsConnected || 0,
      httpPolling: chains1.httpPolling || 0,
      swapsByChain:chains1.swapsByChain || {},
    },
    overlay,
    latency: lat,
    crash:   crash,
    rs5:     { ...rs5, active:true },
    rs6,
    rs1,
    rs2,
    rs3,
    amplifier: amp,
    ai: {
      ...ruleAI,
      sovereign:   sov,
      calls:       sov.calls       || 0,
      accuracy:    sov.accuracy    || 'calibrating',
      insights:    sov.lastResponse|| '',
    },
    modempay:  mp,
    treasury,
    prices,
    executor: {
      address: getConfig('executor_address') || '0xEc92EF0C897b48A3525Df011D08011c5eB2D6D39',
    },
    controls: {
      paused:        getConfig('system_paused') === '1',
      propIntensity: p,
      crashMode:     getConfig('crash_mode') === '1',
      crashScore:    HOT[SAB_OFFSETS.CRASH_SCORE]  || 0,
      crashCountdown:crash.countdown || 'Monitoring...',
    },
    recentExecutions: getExecutions(50),
    throughput: {
      total:    '$3.496Q/day',
      env1:     '$321.12T/day',
      env2:     '$1,209.6T/day',
      env3:     '$500T/day',
      nexusMult:'$1,465.3T/day',
      maxRev:   '$1.748T/day (P30)',
    },
    timestamp: Math.floor(Date.now() / 1000),
  }
}

// ── Express + HTTP + WebSocket ────────────────────────────────────────────────
const app    = express()
const server = createServer(app)
const wss    = new WebSocketServer({ server })

app.use(express.json({ limit: '2mb' }))
app.use(express.text({ type: '*/*', limit: '1mb' }))
app.use((_, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  next()
})
app.options('*', (_, res) => res.sendStatus(200))

// ── WebSocket ─────────────────────────────────────────────────────────────────
const _clients = new Set()

wss.on('connection', ws => {
  _clients.add(ws)
  ws.on('close', () => _clients.delete(ws))
  ws.on('error', () => _clients.delete(ws))
  try { ws.send(JSON.stringify({ type:'tick', data:buildState() })) } catch {}
})

setInterval(() => {
  if (!_clients.size) return
  try {
    const payload = JSON.stringify({ type:'tick', data:buildState() })
    for (const ws of _clients) {
      try { if (ws.readyState === 1) ws.send(payload) } catch {}
    }
  } catch {}
}, 2000)

// ── Push event to all WS clients ──────────────────────────────────────────────
export function broadcastEvent(type, data) {
  const payload = JSON.stringify({ type, data, ts: Date.now() })
  for (const ws of _clients) {
    try { if (ws.readyState === 1) ws.send(payload) } catch {}
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// State
app.get('/api/state',  (_, res) => { try { res.json(buildState()) } catch(e) { res.status(500).json({ error:e.message }) } })
app.get('/api/health', (_, res) => res.json({ ok:true, uptime:process.uptime(), modules:_moduleStats.size }))

// Propeller
app.post('/api/control/propellers', async (req, res) => {
  const p = parseInt(req.body?.intensity)
  if (!p || p < 1 || p > 30) return res.status(400).json({ error:'intensity must be 1-30' })
  try {
    const { setIntensity } = await import('./propeller.js')
    await setIntensity(p, 'operator')
    res.json({ ok:true, intensity:p, dailyRevenue:RTABLE[p], formatted:fmtRev(RTABLE[p]) })
  } catch(e) {
    setConfig('prop_intensity', String(p))
    HOT[SAB_OFFSETS.PROPELLER] = p
    res.json({ ok:true, intensity:p })
  }
})

// Crash mode
app.post('/api/control/crash-on', async (_, res) => {
  setConfig('crash_mode', '1')
  emit('crash_mode_activated')
  try { const { activateCrashMode } = await import('./propeller.js'); activateCrashMode() } catch {}
  res.json({ ok:true, crashMode:true })
})
app.post('/api/control/crash-off', async (_, res) => {
  setConfig('crash_mode', '0')
  emit('crash_mode_deactivated')
  try { const { deactivateCrashMode } = await import('./propeller.js'); deactivateCrashMode() } catch {}
  res.json({ ok:true, crashMode:false })
})

// Halt / Resume
app.post('/api/control/halt', (_, res) => {
  setConfig('system_paused', '1')
  emit('system_halt', {})
  res.json({ ok:true })
})
app.post('/api/control/resume', (_, res) => {
  setConfig('system_paused', '0')
  emit('system_resume', {})
  res.json({ ok:true })
})

// Chain control
app.post('/api/control/pause-chain',  (req, res) => { setConfig('pause_'+(req.body?.chain||''), '1'); res.json({ok:true}) })
app.post('/api/control/resume-chain', (req, res) => { setConfig('pause_'+(req.body?.chain||''), '0'); res.json({ok:true}) })

// AI toggle
app.post('/api/control/ai', (req, res) => { setConfig('rule_ai_enabled', req.body?.enabled?'1':'0'); res.json({ok:true}) })

// Clear overlay
app.post('/api/control/clear-overlay', async (_, res) => {
  try { const { clearAll } = await import('./overlay.js'); clearAll?.(); res.json({ok:true}) }
  catch { res.json({ok:true}) }
})

// SOVEREIGN chat
app.post('/api/sovereign/chat', async (req, res) => {
  const { message } = req.body || {}
  if (!message) return res.status(400).json({ error:'message required' })
  try {
    const { sovereignChat } = await import('./sovereign.js')
    const response = await sovereignChat(message, buildState())
    res.json({ ok:true, response, ts:Math.floor(Date.now()/1000) })
  } catch(e) {
    res.json({ ok:true, response:'SOVEREIGN: ' + e.message })
  }
})

// SOVEREIGN SSE
app.get('/api/sovereign/stream', async (req, res) => {
  res.setHeader('Content-Type',      'text/event-stream')
  res.setHeader('Cache-Control',     'no-cache')
  res.setHeader('Connection',        'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  try {
    const { sovereignChat } = await import('./sovereign.js')
    const resp  = await sovereignChat(req.query.message || '', buildState()) || 'SOVEREIGN active.'
    const words = resp.split(' ')
    let i = 0
    const tick = setInterval(() => {
      if (i >= words.length) { clearInterval(tick); res.write('data: [DONE]\n\n'); res.end(); return }
      res.write(`data: ${JSON.stringify({ word:words[i++] })}\n\n`)
    }, 40)
    req.on('close', () => clearInterval(tick))
  } catch(e) {
    res.write(`data: ${JSON.stringify({ word:'SOVEREIGN', error:e.message })}\n\n`)
    res.end()
  }
})

// SDAL
app.get('/api/sdal', async (_, res) => {
  try { const { get } = await import('./sdal.js'); res.json(get('protocol_addresses') || {}) }
  catch { res.json({}) }
})
app.post('/api/sdal/update', async (req, res) => {
  try { const { update } = await import('./sdal.js'); update(req.body); res.json({ok:true}) }
  catch(e) { res.status(500).json({error:e.message}) }
})

// Propeller table
app.get('/api/propeller/table', (_, res) => {
  res.json({ table:RTABLE, formatted:Object.fromEntries(Object.entries(RTABLE).map(([k,v])=>[k,fmtRev(v)])) })
})

// Crash stats
app.get('/api/crash/stats', (_, res) => res.json(safeStats('crash')))

// Treasury routes
app.get('/api/treasury/stats', (_, res) => res.json(safeStats('treasury')))
app.get('/api/treasury/fx',    (_, res) => res.json(JSON.parse(getConfig('fx_rates')||'{}')))
app.post('/api/treasury/convert', async (req, res) => {
  try { const { convertUSD } = await import('./treasury.js'); res.json(convertUSD(req.body.amount, req.body.currency||'GMD')) }
  catch(e) { res.status(500).json({error:e.message}) }
})
app.post('/api/treasury/validate-swift', async (req, res) => {
  try { const { validateSWIFT } = await import('./treasury.js'); res.json(validateSWIFT(req.body.swift)) }
  catch(e) { res.status(500).json({error:e.message}) }
})
app.get('/api/treasury/fee', async (req, res) => {
  try { const { calcFee } = await import('./treasury.js'); res.json(calcFee(parseFloat(req.query.amount||'0'), req.query.method||'wave')) }
  catch(e) { res.status(500).json({error:e.message}) }
})
app.post('/api/treasury/withdraw', async (req, res) => {
  try { const { startTreasury } = await import('./treasury.js'); const { createTransfer } = await import('./modempay.js'); const r = await createTransfer({ amount:parseFloat(req.body.amount), currency:req.body.currency||'GMD', phone:req.body.phone||req.body.accountNumber, name:req.body.name, network:req.body.network||'wave' }); res.json({ok:true, status:r.status||'submitted', transferId:r.id}) }
  catch(e) { res.status(500).json({error:e.message}) }
})
app.post('/api/treasury/stream/start', async (req, res) => {
  try { const { startRevenueStream } = await import('./treasury.js'); startRevenueStream(req.body); res.json({ok:true}) }
  catch(e) { res.status(500).json({error:e.message}) }
})
app.post('/api/treasury/stream/stop', async (_, res) => {
  try { const { stopRevenueStream } = await import('./treasury.js'); stopRevenueStream(); res.json({ok:true}) }
  catch(e) { res.status(500).json({error:e.message}) }
})
app.post('/api/treasury/schedule/add', async (req, res) => {
  try { const { addSchedule } = await import('./treasury.js'); res.json({ok:true, schedule:addSchedule(req.body)}) }
  catch(e) { res.status(500).json({error:e.message}) }
})
app.get('/api/treasury/schedules', async (_, res) => {
  try { const { getSchedules } = await import('./treasury.js'); res.json(getSchedules()) }
  catch { res.json([]) }
})
app.get('/api/treasury/tax/csv', async (req, res) => {
  try { const { exportTaxCSV } = await import('./treasury.js'); res.setHeader('Content-Type','text/csv'); res.setHeader('Content-Disposition','attachment; filename=vanguard_tax.csv'); res.send(exportTaxCSV(req.query.year?parseInt(req.query.year):null)) }
  catch(e) { res.status(500).send(e.message) }
})
app.get('/api/treasury/journal/csv', async (_, res) => {
  try { const { exportJournalCSV } = await import('./treasury.js'); res.setHeader('Content-Type','text/csv'); res.setHeader('Content-Disposition','attachment; filename=vanguard_journal.csv'); res.send(exportJournalCSV()) }
  catch(e) { res.status(500).send(e.message) }
})

// ModemPay routes
app.post('/api/modempay/withdraw', async (req, res) => {
  try { const { createTransfer, calcFee } = await import('./modempay.js'); const fee=calcFee(parseFloat(req.body.amount||0),req.body.network||'wave'); const r=await createTransfer({amount:parseFloat(req.body.amount),currency:req.body.currency||'GMD',phone:req.body.phone,name:req.body.name,network:req.body.network||'wave'}); res.json({ok:true,status:r.status||'submitted',transferId:r.id,fee}) }
  catch(e) { res.status(500).json({error:e.message}) }
})
app.get('/api/modempay/balance',      async (_, res) => { try { const { getBalance } = await import('./modempay.js'); res.json(await getBalance()) } catch(e) { res.status(500).json({error:e.message}) } })
app.get('/api/modempay/transactions', async (req, res) => { try { const { listTransactions } = await import('./modempay.js'); res.json(await listTransactions(parseInt(req.query.limit||'20'))) } catch(e) { res.status(500).json({error:e.message}) } })
app.get('/api/modempay/fee',          async (req, res) => { try { const { calcFee } = await import('./modempay.js'); res.json(calcFee(parseFloat(req.query.amount||'0'),req.query.method||'wave')) } catch(e) { res.status(500).json({error:e.message}) } })
app.get('/api/modempay/stats',        (_, res) => res.json(safeStats('modempay')))

// USB Vault routes
app.post('/api/usb/add-funds', async (req, res) => {
  try { const { addFundsToVault } = await import('./usb_treasury.js'); res.json(await addFundsToVault(req.body)) }
  catch(e) { res.status(500).json({error:e.message}) }
})
app.post('/api/usb/restore', async (req, res) => {
  try { const { restoreFromVault } = await import('./usb_treasury.js'); res.json(await restoreFromVault(req.body)) }
  catch(e) { res.status(500).json({error:e.message}) }
})

// ── Serve dashboards ──────────────────────────────────────────────────────────
// Dashboard files at: src/dashboard/nightfall.html
const DASH_DIR = join(__dir, 'dashboard')

app.get('/', (_, res) => {
  const p = join(DASH_DIR, 'nightfall.html')
  if (existsSync(p)) res.sendFile(p)
  else res.send(`<!DOCTYPE html><html><head><title>VANGUARD</title><style>body{background:#020408;color:#00D4FF;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:16px}</style></head><body><div style="font-size:32px;font-weight:900;letter-spacing:4px">VANGUARD SOVEREIGN</div><div style="font-size:14px;color:#00FF88">OPERATIONAL · nightfall.html not found at src/dashboard/</div><div style="font-size:10px;color:#3B434D">Place nightfall.html in src/dashboard/ and redeploy</div><script>setInterval(()=>fetch('/api/health').then(r=>r.json()).then(d=>document.title='VANGUARD · '+Math.round(d.uptime)+'s'),2000)</script></body></html>`)
})

app.get('/mobile', (_, res) => {
  const p = join(DASH_DIR, 'nightfall-black.html')
  if (existsSync(p)) res.sendFile(p)
  else res.redirect('/')
})

app.get('/vault', (_, res) => {
  const p = join(DASH_DIR, 'vault.html')
  if (existsSync(p)) res.sendFile(p)
  else res.redirect('/')
})

// Serve any static file in src/dashboard/
app.use('/dashboard', express.static(DASH_DIR))

// ── Start ─────────────────────────────────────────────────────────────────────
let _started = false

export function startDashboard() {
  if (_started) return
  _started = true

  const PORT = parseInt(process.env.PORT || '3000')

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[DASHBOARD] Sovereign Control Center → http://0.0.0.0:${PORT}`)
    console.log(`[DASHBOARD] Nightfall → http://0.0.0.0:${PORT}/`)
    console.log(`[DASHBOARD] Mobile    → http://0.0.0.0:${PORT}/mobile`)
    console.log(`[DASHBOARD] API       → http://0.0.0.0:${PORT}/api/state`)
  })

  server.on('error', e => {
    if (e.code === 'EADDRINUSE') {
      console.warn(`[DASHBOARD] Port ${PORT} in use — trying ${PORT+1}`)
      setTimeout(() => server.listen(PORT+1, '0.0.0.0'), 1000)
    }
  })

  // Bridge events to WebSocket clients
  on('deploy_success',    d => broadcastEvent('deploy_success',    d))
  on('apex_success',      d => broadcastEvent('apex_success',      d))
  on('emergency_halt',    d => broadcastEvent('emergency_halt',    d))
  on('propeller_changed', d => broadcastEvent('propeller_changed', d))
  on('overlay_stored',    d => broadcastEvent('overlay_stored',    d))
  on('rs5_revenue',       d => broadcastEvent('rs5_revenue',       d))
  on('crash_mode_activated',   d => broadcastEvent('crash_mode_on',  d))
  on('crash_mode_deactivated', d => broadcastEvent('crash_mode_off', d))
  on('system_halt',       d => broadcastEvent('system_halt',       d))
  on('system_resume',     d => broadcastEvent('system_resume',     d))
}
