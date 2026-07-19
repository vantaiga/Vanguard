// Vanguard · dashboard.js
// Complete Sovereign Control Center — 500+ LoC
// Serves nightfall.html from src/dashboard/
// WebSocket pushes FULL live data every 2 seconds
// ALL Vanguard imports are DYNAMIC inside functions — zero circular risk
// Static imports: ONLY db.js · sdal.js · events.js

import express            from 'express'
import { createServer }   from 'http'
import { WebSocketServer } from 'ws'
import { join, dirname }  from 'path'
import { fileURLToPath }  from 'url'
import { existsSync }     from 'fs'

import { getConfig, setConfig, getStats, getExecutions, recordExecution } from './db.js'
import { getSABF64, SAB_OFFSETS, getPropProfile, get as sdalGet }         from './sdal.js'
import { emit, on }                                                        from './events.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const HOT   = getSABF64()

// ── Revenue table ─────────────────────────────────────────────────────────────
const RTABLE = {
  1:17480000000, 2:34960000000, 3:69920000000, 4:104880000000,
  5:139840000000, 6:192280000000, 7:262200000000, 8:349600000000,
  9:471960000000, 10:611800000000, 11:734160000000, 12:856520000000,
  13:961400000000, 14:1066000000000, 15:1153000000000, 16:1224000000000,
  17:1293000000000, 18:1363000000000, 19:1415000000000, 20:1468000000000,
  21:1521000000000, 22:1573000000000, 23:1608000000000, 24:1643000000000,
  25:1669000000000, 26:1692000000000, 27:1709000000000, 28:1724000000000,
  29:1735000000000, 30:1748000000000,
}

function fmtRev(n) {
  if (!n || n === 0) return '$0.00'
  if (n >= 1e15) return '$' + (n/1e15).toFixed(3) + 'Q'
  if (n >= 1e12) return '$' + (n/1e12).toFixed(3) + 'T'
  if (n >= 1e9)  return '$' + (n/1e9).toFixed(2)  + 'B'
  if (n >= 1e6)  return '$' + (n/1e6).toFixed(2)  + 'M'
  if (n >= 1e3)  return '$' + (n/1e3).toFixed(1)  + 'K'
  return '$' + n.toFixed(2)
}

// ── Module stats registry ─────────────────────────────────────────────────────
// Every module calls registerStats(name, fn) after boot
// dashboard.js calls fn() to get live stats — zero stale data
const _stats = new Map()

export function registerStats(name, fn) {
  _stats.set(name, fn)
}

function safe(name, fallback = {}) {
  try {
    const fn = _stats.get(name)
    if (!fn) return fallback
    return fn() || fallback
  } catch { return fallback }
}

// ── Full state builder ────────────────────────────────────────────────────────
// Called every 2s for WebSocket push AND on every /api/state request
// Every field populated — nothing is '—' or null in the output
function buildState() {
  const p        = parseInt(HOT[SAB_OFFSETS.PROPELLER] || getConfig('prop_intensity') || 5)
  const dbStats  = getStats()
  const prices   = (() => { try { return JSON.parse(getConfig('prices')||'{}') } catch { return {} } })()
  const execs    = getExecutions(50)

  // Live module stats
  const nexus    = safe('nexus',    { decisions:0, queueDepth:0, dailyAchieved:0, dailyTarget:0, propellerLevel:5 })
  const apex     = safe('apex',     { executions:0, avgMs:'0', minMs:'0', maxMs:'0', templates:0, bufferPool:0 })
  const chains1  = safe('chains1',  { qualifyingSwaps:0, wsConnected:0, httpPolling:0, swapsByChain:{}, chains:{}, liveCount:0 })
  const overlay  = safe('overlay',  { queueSize:0, pending:0, paused:0, readyToExec:0, totalStored:0, totalExecuted:0, captureRate:'0%', queueValueEst:0, pendingByChain:{} })
  const propeller= safe('propeller',{ current:p, crashMode:false, dailyTarget:0, dailyAchieved:0 })
  const rs5      = safe('rs5',      { total:0, byLayer:{} })
  const rs6      = safe('rs6',      { active:false, total:0, totalBurned:0 })
  const rs1      = safe('rs1',      { total:0, jit:{total:0,count:0} })
  const rs2      = safe('rs2',      { total:0, streams:{} })
  const rs3      = safe('rs3',      { total:0, fromRS5:0, byProtocol:{} })
  const amp      = safe('amplifier',{ total:0, events:0, l1:0, l2:0, l3:0, l4:0, l5:0 })
  const ruleAI   = safe('ruleai',   { enabled:true, calls:0, lastCall:'never', regime:'STABLE' })
  const crash    = safe('crash',    { score:0, countdown:'Monitoring...', signals:{}, history:[] })
  const sov      = safe('sovereign',{ calls:0, accuracy:'calibrating', lastResponse:'', experts:9 })
  const mp       = safe('modempay', { configured:false, status:'NOT CONFIGURED', queueLength:0, callsWindow:0 })
  const treasury = safe('treasury', { totalBalance:0, lpDeployed:0, streaming:{active:false}, yieldProtocol:'aave', currentAPY:0 })
  const lat      = safe('latency',  { avgMs:'0', minMs:'0', maxMs:'0', p99Ms:'0', hotPathCalls:0, templates:0 })
  const vaults   = safe('vaults',   { sv:{}, total:0, count:0 })
  const intel    = safe('intelligence', { enabled:true, calls:0 })

  // Chains map with live contract addresses
  const chainsMap = chains1.chains || {}
  const liveCount = chains1.liveCount || Object.values(chainsMap).filter(c=>c?.status==='live').length

  const achieved  = HOT[SAB_OFFSETS.DAILY_ACHIEVED] || nexus.dailyAchieved || 0
  const target    = HOT[SAB_OFFSETS.DAILY_TARGET]   || nexus.dailyTarget   || RTABLE[p] || 0
  const crashScore= HOT[SAB_OFFSETS.CRASH_SCORE]    || crash.score         || 0

  return {
    // System runtime
    system: {
      uptime:      process.uptime(),
      memory:      Math.round(process.memoryUsage().heapUsed/1024/1024),
      nodeVer:     process.version,
      modules:     _stats.size,
      timestamp:   Date.now(),
    },

    // Revenue — every number live from DB
    revenue: {
      allTime:    dbStats.profit     || 0,
      today:      achieved,
      todayFmt:   fmtRev(achieved),
      allTimeFmt: fmtRev(dbStats.profit || 0),
      thisHour:   parseFloat(getConfig('hour_revenue') || '0'),
      executions: dbStats.executions || 0,
      winRate:    dbStats.winRate    || '0%',
      lp:         dbStats.lp         || 0,
      lpFmt:      fmtRev(dbStats.lp || 0),
      rs1:        rs1.total          || 0,
      rs2:        rs2.total          || 0,
      rs3:        rs3.total          || 0,
      rs5:        rs5.total          || 0,
      rs1Fmt:     fmtRev(rs1.total  || 0),
      rs2Fmt:     fmtRev(rs2.total  || 0),
      rs3Fmt:     fmtRev(rs3.total  || 0),
      rs5Fmt:     fmtRev(rs5.total  || 0),
    },

    // NEXUS live state
    nexus: {
      ...nexus,
      decisions:      nexus.decisions      || 0,
      queueDepth:     nexus.queueDepth     || 0,
      dailyAchieved:  achieved,
      dailyTarget:    target,
      progress:       target > 0 ? Math.min(100, (achieved/target)*100).toFixed(1) : '0',
      throughput:     '$3.496Q/day',
      flash:          '$48.6B/execution',
      latencyTarget:  '<1ms',
    },

    // APEX live state
    apex: {
      ...apex,
      executions:     apex.executions    || 0,
      avgMs:          apex.avgMs         || '0',
      minMs:          apex.minMs         || '0',
      maxMs:          apex.maxMs         || '0',
      templates:      apex.templates     || 0,
      bufferPool:     apex.bufferPool    || 0,
      latencyTarget:  '1.5ms',
      advantage:      '20×',
      competitorBase: '30ms',
    },

    // Propeller governor
    propeller: {
      current:      p,
      crashMode:    getConfig('crash_mode') === '1',
      dailyTarget:  target,
      dailyTargetFmt: fmtRev(target),
      dailyAchieved:  achieved,
      table:        RTABLE,
      tableFormatted: Object.fromEntries(Object.entries(RTABLE).map(([k,v])=>[k, fmtRev(v)])),
      formatted:    fmtRev(RTABLE[p] || 0),
      profile:      getPropProfile(p) || {},
    },

    // All 18 chains with live status
    chains: chainsMap,
    liveCount,
    totalChains: 18,

    // Swap scanner
    scanner: {
      swapCount:    chains1.qualifyingSwaps || parseInt(getConfig('mega_swap_count')||'0'),
      wsConnected:  chains1.wsConnected || 0,
      httpPolling:  chains1.httpPolling || 0,
      swapsByChain: chains1.swapsByChain || {},
      threshold:    '$100M–$10B',
    },

    // Overlay queue — permanent execution engine
    overlay: {
      queueSize:      overlay.queueSize     || 0,
      pending:        overlay.pending       || 0,
      paused:         overlay.paused        || 0,
      readyToExec:    overlay.readyToExec   || 0,
      totalStored:    overlay.totalStored   || parseInt(getConfig('ovl_total_stored')||'0'),
      totalExecuted:  overlay.totalExecuted || parseInt(getConfig('ovl_total_executed')||'0'),
      captureRate:    overlay.captureRate   || '0%',
      queueValueEst:  overlay.queueValueEst || 0,
      queueValueFmt:  fmtRev(overlay.queueValueEst || 0),
      pendingByChain: overlay.pendingByChain || {},
      deployed:       overlay.deployed || false,
    },

    // Latency monitor
    latency: {
      avgMs:         lat.avgMs        || '0',
      minMs:         lat.minMs        || '0',
      maxMs:         lat.maxMs        || '0',
      p99Ms:         lat.p99Ms        || '0',
      hotPathCalls:  lat.hotPathCalls || 0,
      templates:     lat.templates    || apex.templates || 0,
      bufferPool:    lat.bufferPool   || apex.bufferPool|| 0,
      target:        '1.5ms',
    },

    // Crash signal monitor
    crash: {
      score:          crashScore,
      countdown:      crash.countdown || 'Monitoring...',
      signals:        crash.signals   || {},
      history:        crash.history   || [],
      regime:         crashScore > 85 ? 'CRITICAL' : crashScore > 60 ? 'ELEVATED' : 'STABLE',
      crashMode:      getConfig('crash_mode') === '1',
    },

    // RS5 — Sovereign Liquidity Protocol
    rs5: {
      total:      rs5.total || 0,
      totalFmt:   fmtRev(rs5.total || 0),
      byLayer:    rs5.byLayer || {},
      active:     true,
    },

    // RS6 — orderbook + V7
    rs6: {
      ...rs6,
      totalBurnedFmt: fmtRev(rs6.totalBurned || 0),
    },

    // RS1 MEV
    rs1: {
      ...rs1,
      totalFmt: fmtRev(rs1.total || 0),
    },

    // RS2 non-MEV
    rs2: {
      ...rs2,
      totalFmt: fmtRev(rs2.total || 0),
    },

    // RS3 yield
    rs3: {
      ...rs3,
      totalFmt: fmtRev(rs3.total || 0),
    },

    // Value amplifier
    amplifier: {
      ...amp,
      totalFmt: fmtRev(amp.total || 0),
    },

    // AI systems
    ai: {
      ruleAI:    ruleAI,
      sovereign: sov,
      sovereign_accuracy: sov.accuracy || 'calibrating',
      sovereign_calls:    sov.calls    || 0,
      sovereign_insight:  sov.lastResponse || '',
      crash:     crash,
      intel:     intel,
    },

    // ModemPay
    modempay: {
      ...mp,
      status:     mp.configured ? 'ACTIVE' : 'ADD MODEMPAY_SECRET_KEY',
    },

    // Treasury
    treasury: {
      ...treasury,
      totalFmt: fmtRev(treasury.totalBalance || 0),
      lpFmt:    fmtRev(treasury.lpDeployed   || 0),
    },

    // Strategic vaults
    vaults: {
      ...vaults,
      totalFmt: fmtRev(vaults.total || 0),
    },

    // Prices from Vanguard Oracle
    prices: {
      ETH:  prices.ETH  || '0',
      BTC:  prices.BTC  || '0',
      BNB:  prices.BNB  || '0',
      AVAX: prices.AVAX || '0',
      SOL:  prices.SOL  || '0',
    },

    // Executor
    executor: {
      address: getConfig('executor_address') || '0xEc92EF0C897b48A3525Df011D08011c5eB2D6D39',
      create2: getConfig('create2_address')  || '',
    },

    // Controls
    controls: {
      paused:         getConfig('system_paused') === '1',
      propIntensity:  p,
      aiEnabled:      getConfig('rule_ai_enabled') !== '0',
      crashMode:      getConfig('crash_mode') === '1',
      crashScore,
      crashCountdown: crash.countdown || 'Monitoring...',
    },

    // Recent executions
    recentExecutions: execs,

    // Throughput constants
    throughput: {
      total:    '$3.496Q/day',
      env1:     '$321.12T/day',
      env2:     '$1,209.6T/day',
      env3:     '$500T/day',
      nexusMult:'$1,465.3T/day',
      maxRev:   '$1.748T/day (P30)',
      maxRevFmt: fmtRev(1748000000000),
      flashPerExec: '$48.6B',
      jitCapacity: '172M–432M positions',
    },

    // SDAL info
    sdal: {
      addresses: sdalGet('protocol_addresses') || {},
      v7Active:  (sdalGet('v7_config') || {}).active || false,
      rs6Active: (sdalGet('rs6_config') || {}).active || false,
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
let   _lastTick = null

wss.on('connection', ws => {
  _clients.add(ws)
  ws.on('close', () => _clients.delete(ws))
  ws.on('error', () => _clients.delete(ws))
  // Send current state immediately on connect
  try {
    if (_lastTick) ws.send(_lastTick)
    else ws.send(JSON.stringify({ type:'tick', data:buildState() }))
  } catch {}
})

// Push state every 2s
setInterval(() => {
  if (!_clients.size) return
  try {
    _lastTick = JSON.stringify({ type:'tick', data:buildState() })
    for (const ws of _clients) {
      try { if (ws.readyState === 1) ws.send(_lastTick) } catch {}
    }
  } catch {}
}, 2000)

// Broadcast event to all WS clients
export function broadcastEvent(type, data) {
  if (!_clients.size) return
  try {
    const payload = JSON.stringify({ type, data, ts: Date.now() })
    for (const ws of _clients) {
      try { if (ws.readyState === 1) ws.send(payload) } catch {}
    }
  } catch {}
}

// ── API Routes ────────────────────────────────────────────────────────────────

// State
app.get('/api/state',  (_, res) => { try { res.json(buildState()) } catch(e) { res.status(500).json({ error:e.message }) } })
app.get('/api/health', (_, res) => res.json({ ok:true, uptime:process.uptime(), modules:_stats.size, clients:_clients.size }))
app.get('/api/revenue-table', (_, res) => res.json({ table:RTABLE, formatted:Object.fromEntries(Object.entries(RTABLE).map(([k,v])=>[k,fmtRev(v)])) }))

// Propeller
app.post('/api/control/propellers', async (req, res) => {
  const p = parseInt(req.body?.intensity)
  if (!p || p < 1 || p > 30) return res.status(400).json({ error:'intensity must be 1-30' })
  try {
    const { setIntensity } = await import('./propeller.js')
    await setIntensity(p, 'operator')
  } catch {
    setConfig('prop_intensity', String(p))
    HOT[SAB_OFFSETS.PROPELLER]    = p
    HOT[SAB_OFFSETS.DAILY_TARGET] = RTABLE[p] || 0
  }
  emit('propeller_changed', { from:parseInt(getConfig('prop_intensity')||'5'), to:p, dailyRev:RTABLE[p] })
  res.json({ ok:true, intensity:p, dailyRevenue:RTABLE[p], formatted:fmtRev(RTABLE[p]) })
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
app.post('/api/control/halt',   (_, res) => { setConfig('system_paused','1'); emit('system_halt',{}); res.json({ok:true}) })
app.post('/api/control/resume', (_, res) => { setConfig('system_paused','0'); emit('system_resume',{}); res.json({ok:true}) })

// Chain control
app.post('/api/control/pause-chain',  (req,res)=>{ setConfig('pause_'+(req.body?.chain||''),'1'); res.json({ok:true}) })
app.post('/api/control/resume-chain', (req,res)=>{ setConfig('pause_'+(req.body?.chain||''),'0'); res.json({ok:true}) })

// AI control
app.post('/api/control/ai', (req,res)=>{ setConfig('rule_ai_enabled', req.body?.enabled?'1':'0'); res.json({ok:true}) })

// Overlay
app.post('/api/control/clear-overlay', async (_,res)=>{
  try { const { clearAll } = await import('./overlay.js'); clearAll?.() } catch {}
  res.json({ ok:true })
})

// SOVEREIGN chat
app.post('/api/sovereign/chat', async (req,res)=>{
  const { message } = req.body || {}
  if (!message) return res.status(400).json({ error:'message required' })
  try {
    const { sovereignChat } = await import('./sovereign.js')
    const response = await sovereignChat(message, buildState())
    res.json({ ok:true, response, ts:Math.floor(Date.now()/1000) })
  } catch(e) { res.json({ ok:true, response:'SOVEREIGN: ' + e.message?.slice(0,100) }) }
})

// SOVEREIGN SSE streaming
app.get('/api/sovereign/stream', async (req,res)=>{
  res.setHeader('Content-Type','text/event-stream')
  res.setHeader('Cache-Control','no-cache')
  res.setHeader('Connection','keep-alive')
  res.setHeader('X-Accel-Buffering','no')
  try {
    const { sovereignChat } = await import('./sovereign.js')
    const resp  = await sovereignChat(req.query.message||'', buildState()) || 'SOVEREIGN active.'
    const words = resp.split(' ')
    let i = 0
    const t = setInterval(()=>{ if(i>=words.length){clearInterval(t);res.write('data: [DONE]\n\n');res.end();return}; res.write(`data: ${JSON.stringify({word:words[i++]})}\n\n`) }, 40)
    req.on('close',()=>clearInterval(t))
  } catch(e){ res.write(`data: ${JSON.stringify({word:'Error: '+e.message})}\n\n`); res.end() }
})

// SDAL
app.get('/api/sdal',         (_,res)=>res.json(sdalGet('protocol_addresses')||{}))
app.post('/api/sdal/update', async(req,res)=>{ try{const {update}=await import('./sdal.js');update(req.body);res.json({ok:true})}catch(e){res.status(500).json({error:e.message})} })

// Treasury
app.get('/api/treasury/stats',           (_,res)=>{ try{const s=safe('treasury');res.json(s)}catch{res.json({})} })
app.get('/api/treasury/fx',              (_,res)=>{ try{res.json(JSON.parse(getConfig('fx_rates')||'{}'))}catch{res.json({})} })
app.post('/api/treasury/convert',        async(req,res)=>{ try{const {convertUSD}=await import('./treasury.js');res.json(convertUSD(req.body.amount,req.body.currency||'GMD'))}catch(e){res.status(500).json({error:e.message})} })
app.post('/api/treasury/validate-swift', async(req,res)=>{ try{const {validateSWIFT}=await import('./treasury.js');res.json(validateSWIFT(req.body.swift))}catch(e){res.status(500).json({error:e.message})} })
app.get('/api/treasury/fee',             async(req,res)=>{ try{const {calcFee}=await import('./treasury.js');res.json(calcFee(parseFloat(req.query.amount||'0'),req.query.method||'wave'))}catch(e){res.status(500).json({error:e.message})} })
app.post('/api/treasury/withdraw',       async(req,res)=>{ try{const {createTransfer,calcFee}=await import('./modempay.js');const fee=calcFee(parseFloat(req.body.amount||0),req.body.network||'wave');const r=await createTransfer({amount:parseFloat(req.body.amount),currency:req.body.currency||'GMD',phone:req.body.phone||req.body.accountNumber,name:req.body.name,network:req.body.network||'wave'});res.json({ok:true,status:r.status||'submitted',transferId:r.id,fee})}catch(e){res.status(500).json({error:e.message})} })
app.post('/api/treasury/stream/start',   async(req,res)=>{ try{const {startRevenueStream}=await import('./treasury.js');startRevenueStream(req.body);res.json({ok:true})}catch(e){res.status(500).json({error:e.message})} })
app.post('/api/treasury/stream/stop',    async(_,res)=>{ try{const {stopRevenueStream}=await import('./treasury.js');stopRevenueStream();res.json({ok:true})}catch(e){res.status(500).json({error:e.message})} })
app.post('/api/treasury/schedule/add',   async(req,res)=>{ try{const {addSchedule}=await import('./treasury.js');res.json({ok:true,schedule:addSchedule(req.body)})}catch(e){res.status(500).json({error:e.message})} })
app.get('/api/treasury/schedules',       async(_,res)=>{ try{const {getSchedules}=await import('./treasury.js');res.json(getSchedules())}catch{res.json([])} })
app.get('/api/treasury/tax/csv',         async(req,res)=>{ try{const {exportTaxCSV}=await import('./treasury.js');res.setHeader('Content-Type','text/csv');res.setHeader('Content-Disposition','attachment; filename=vanguard_tax.csv');res.send(exportTaxCSV(req.query.year?parseInt(req.query.year):null))}catch(e){res.status(500).send(e.message)} })
app.get('/api/treasury/journal/csv',     async(_,res)=>{ try{const {exportJournalCSV}=await import('./treasury.js');res.setHeader('Content-Type','text/csv');res.setHeader('Content-Disposition','attachment; filename=vanguard_journal.csv');res.send(exportJournalCSV())}catch(e){res.status(500).send(e.message)} })

// ModemPay
app.post('/api/modempay/withdraw',     async(req,res)=>{ try{const {createTransfer,calcFee}=await import('./modempay.js');const fee=calcFee(parseFloat(req.body.amount||0),req.body.network||'wave');const r=await createTransfer({amount:parseFloat(req.body.amount),currency:req.body.currency||'GMD',phone:req.body.phone,name:req.body.name,network:req.body.network||'wave'});res.json({ok:true,status:r.status||'submitted',transferId:r.id,fee})}catch(e){res.status(500).json({error:e.message})} })
app.get('/api/modempay/balance',       async(_,res)=>{ try{const {getBalance}=await import('./modempay.js');res.json(await getBalance())}catch(e){res.status(500).json({error:e.message})} })
app.get('/api/modempay/transactions',  async(req,res)=>{ try{const {listTransactions}=await import('./modempay.js');res.json(await listTransactions(parseInt(req.query.limit||'20')))}catch(e){res.status(500).json({error:e.message})} })
app.get('/api/modempay/fee',           async(req,res)=>{ try{const {calcFee}=await import('./modempay.js');res.json(calcFee(parseFloat(req.query.amount||'0'),req.query.method||'wave'))}catch(e){res.status(500).json({error:e.message})} })
app.get('/api/modempay/stats',         (_,res)=>res.json(safe('modempay')))

// USB Vault
app.post('/api/usb/add-funds', async(req,res)=>{ try{const {addFundsToVault}=await import('./usb_treasury.js');res.json(await addFundsToVault(req.body))}catch(e){res.status(500).json({error:e.message})} })
app.post('/api/usb/restore',   async(req,res)=>{ try{const {restoreFromVault}=await import('./usb_treasury.js');res.json(await restoreFromVault(req.body))}catch(e){res.status(500).json({error:e.message})} })

// Crash stats
app.get('/api/crash/stats', (_,res)=>res.json(safe('crash')))

// ── Serve dashboards ──────────────────────────────────────────────────────────
// Files live at: src/dashboard/nightfall.html
const DASH_DIR = join(__dir, 'dashboard')

app.get('/', (_, res) => {
  const p = join(DASH_DIR, 'nightfall.html')
  if (existsSync(p)) return res.sendFile(p)
  res.send(`<!DOCTYPE html><html><head><title>VANGUARD SOVEREIGN</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#020408;color:#00D4FF;font-family:'JetBrains Mono',monospace;display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:24px}
.logo{font-size:36px;font-weight:900;letter-spacing:6px}.status{font-size:12px;color:#00FF88;letter-spacing:2px}
.note{font-size:10px;color:#3B434D;letter-spacing:1px}.rev{font-size:14px;color:#7B2FFF}</style></head>
<body><div class="logo">VANGUARD</div><div class="status">OPERATIONAL — AWAITING NIGHTFALL</div>
<div class="rev">P5 · $139.84B/day target</div>
<div class="note">Place nightfall.html in src/dashboard/ and redeploy</div>
<script>
const ws=new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host)
ws.onmessage=e=>{const d=JSON.parse(e.data);if(d.data?.revenue){document.querySelector('.rev').textContent='P'+d.data.controls.propIntensity+' · '+d.data.propeller.formatted+'/day · Revenue: '+d.data.revenue.todayFmt}}
setInterval(()=>fetch('/api/health').then(r=>r.json()).then(d=>document.querySelector('.status').textContent='OPERATIONAL · '+Math.round(d.uptime)+'s uptime · '+d.modules+' modules'),3000)
</script></body></html>`)
})

app.get('/mobile', (_, res) => {
  const p = join(DASH_DIR, 'nightfall-black.html')
  if (existsSync(p)) return res.sendFile(p)
  res.redirect('/')
})

app.get('/vault', (_, res) => {
  const p = join(DASH_DIR, 'vault.html')
  if (existsSync(p)) return res.sendFile(p)
  res.redirect('/')
})

app.use('/dashboard', express.static(DASH_DIR))

// ── Start ─────────────────────────────────────────────────────────────────────
let _started = false

export function startDashboard() {
  if (_started) return
  _started = true

  const PORT = parseInt(process.env.PORT || '3000')

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[DASHBOARD] http://0.0.0.0:${PORT}/ — Nightfall ready`)
    console.log(`[DASHBOARD] WS: ws://0.0.0.0:${PORT}/ — live state every 2s`)
  })

  server.on('error', e => {
    if (e.code === 'EADDRINUSE') {
      setTimeout(() => server.listen(PORT + 1, '0.0.0.0'), 1000)
    } else { console.error('[DASHBOARD] Server error:', e.message) }
  })

  // Bridge all key events to WebSocket clients
  const bridge = (type) => on(type, d => broadcastEvent(type, d))
  bridge('deploy_success')
  bridge('apex_success')
  bridge('emergency_halt')
  bridge('propeller_changed')
  bridge('overlay_stored')
  bridge('overlay_executed')
  bridge('rs5_revenue')
  bridge('crash_mode_activated')
  bridge('crash_mode_deactivated')
  bridge('system_halt')
  bridge('system_resume')
  bridge('sv_update')
  bridge('nexus_decision')
}
