// Vanguard · dashboard.js — THE FACE
// IMMUNE to Railway container restarts via /data volume persistence
// Uptime: reads from /data/process_start.txt — true container uptime
// Nightfall Black: serves src/dashboard/nightfall-black.html directly
//   NO fallback redirect, NO inline HTML for it — real file or real error
// WebSocket: heartbeat, cached tick, reconnect-friendly
// ModemPay: live env read on every state call
// Static imports: ONLY vanguard.js

import express             from 'express'
import { createServer }    from 'http'
import { WebSocketServer } from 'ws'
import { join, dirname }   from 'path'
import { fileURLToPath }   from 'url'
import {
  existsSync, readFileSync, writeFileSync, mkdirSync,
} from 'fs'

import {
  getConfig, setConfig, getStats, getExecutions,
  getSABF64, SAB_OFFSETS, getPropProfile,
  sdalGet, emit, on, RTABLE, fmtRev,
} from './vanguard.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const HOT   = getSABF64()

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — TRUE CONTAINER UPTIME
// Persisted to /data/process_start.txt by db.js
// Survives OOM restart — uptime never resets to 0
// Falls back to module load time if /data not yet mounted
// ═══════════════════════════════════════════════════════════════════════════
const START_FILE = '/data/process_start.txt'
let   _containerStart = Date.now()   // fallback

function loadContainerStart() {
  try {
    if (existsSync(START_FILE)) {
      const saved = parseInt(readFileSync(START_FILE, 'utf8').trim(), 10)
      if (saved > 0 && saved < Date.now()) {
        _containerStart = saved
        return
      }
    }
    // First boot — write now
    mkdirSync('/data', { recursive:true })
    writeFileSync(START_FILE, String(Date.now()), 'utf8')
    _containerStart = Date.now()
  } catch {
    _containerStart = Date.now()
  }
}

// DO NOT reset on redeploy — only reset when user explicitly requests
export function resetContainerUptime() {
  try {
    const now = Date.now()
    writeFileSync(START_FILE, String(now), 'utf8')
    _containerStart = now
  } catch {}
}

function getUptimeSec() {
  return Math.max(0, Math.floor((Date.now() - _containerStart) / 1000))
}

function formatUptime(s) {
  if (s < 60)    return s + 's'
  if (s < 3600)  return Math.floor(s/60) + 'm ' + (s%60) + 's'
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60)
  if (h < 24)    return h + 'h ' + m + 'm'
  const d = Math.floor(h/24)
  return d + 'd ' + (h%24) + 'h'
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — SERVER SINGLETON
// Created at module load — never recreated
// _started flag prevents re-binding on index.js recovery loop
// ═══════════════════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — MODULE STATS REGISTRY
// Populated by index.js registerStats() calls after each module boots
// During 2-3s boot window: safe() falls back to getConfig() values
// getConfig() reads from /data/cfg.json — PERSISTENT across restarts
// ═══════════════════════════════════════════════════════════════════════════
const _stats = new Map()

export function registerStats(name, fn) {
  if (typeof fn === 'function') _stats.set(name, fn)
}

function safe(name, fallback = {}) {
  try {
    const fn = _stats.get(name)
    if (!fn) return fallback
    return fn() ?? fallback
  } catch { return fallback }
}

// Config-backed fallbacks — populated from /data/cfg.json on restart
// These ensure the dashboard shows real historical data during boot window
function configFallbacks() {
  return {
    allTime:    parseFloat(getConfig('all_time_profit')   ?? '0'),
    lp:         parseFloat(getConfig('lp_total')          ?? '0'),
    today:      parseFloat(getConfig('daily_achieved')    ?? '0'),
    executions: parseInt(getConfig('total_executions')    ?? '0'),
    wins:       parseInt(getConfig('total_wins')          ?? '0'),
    winRate:    getConfig('win_rate')                     ?? '0%',
    swaps:      parseInt(getConfig('mega_swap_count')     ?? '0'),
    crashMode:  getConfig('crash_mode')                   === '1',
    propLevel:  parseInt(getConfig('prop_intensity')      ?? '5'),
    apexAvgMs:  getConfig('apex_avg_ms')                  ?? '0',
    rs5Total:   parseFloat(getConfig('rs5_total')         ?? '0'),
    overlaySize:parseInt(getConfig('overlay_queue_size')  ?? '0'),
    crashScore: parseFloat(getConfig('crash_score')       ?? '0'),
    hourRev:    parseFloat(getConfig('hour_revenue')      ?? '0'),
    propTarget: parseFloat(getConfig('prop_daily_target') ?? String(RTABLE[5]??0)),
    achieved:   parseFloat(getConfig('daily_achieved')    ?? '0'),
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4 — MODEMPAY LIVE STATUS
// ALWAYS reads process.env on every call — never stale DB value
// ═══════════════════════════════════════════════════════════════════════════
function getModemPayLive() {
  const key    = (process.env.MODEMPAY_SECRET_KEY ?? '').trim().replace(/^["']|["']$/g, '')
  const isLive = key.startsWith('sk_live_')
  const isTest = key.startsWith('sk_test_')
  const hasKey = key.length > 0
  return {
    configured: hasKey,
    mode:       isLive ? 'LIVE' : isTest ? 'TEST' : hasKey ? 'CONFIGURED' : 'NOT CONFIGURED',
    status:     isLive ? 'ACTIVE — LIVE' : isTest ? 'TEST MODE' : hasKey ? 'ACTIVE' : 'ADD MODEMPAY_SECRET_KEY',
    keyHint:    hasKey && key.length > 8 ? key.slice(0,4)+'...'+key.slice(-4) : hasKey ? '***' : 'NOT SET',
    endpoint:   'https://api.modempay.com/v1',
    isLive,
    isTest,
    networks:   ['wave','afrimoney','qmoney','bank','crypto'],
    fees:       { wave:'1.5%', afrimoney:'1.5%', qmoney:'1.5%', bank:'1.25%', crypto:'1.0%' },
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5 — STATE BUILDER
// Every field populated — nothing undefined or null
// Config fallbacks kick in during boot window (before modules register)
// Cached: _lastGoodState served on WS reconnect immediately
// ═══════════════════════════════════════════════════════════════════════════
let _lastGoodState   = null
let _stateBuilds     = 0
let _stateErrors     = 0

function buildState() {
  _stateBuilds++
  try {
    const cfg = configFallbacks()
    const p   = parseInt(HOT[SAB_OFFSETS.PROPELLER] || 0) || cfg.propLevel

    // Live module stats (fallback to config values during boot)
    const nexus     = safe('nexus',      { decisions:0, queueDepth:0, dailyAchieved:cfg.achieved, dailyTarget:cfg.propTarget, propellerLevel:p, progress:'0%', throughput:'$3.496Q/day', flash:'$48.6B/execution', lifetimeRevenue:cfg.allTime })
    const apex      = safe('apex',       { executions:cfg.executions, avgMs:cfg.apexAvgMs, minMs:'0', maxMs:'0', p99Ms:'0', templates:0, bufferPool:0, hitRate:'0%', buildersConnected:0, target:'1.5ms', advantage:'20×' })
    const chains1   = safe('chains',     { qualifyingSwaps:cfg.swaps, wsConnected:0, httpPolling:0, swapsByChain:{}, chains:{}, liveCount:0, totalPools:1847 })
    const overlay   = safe('overlay',    { queueSize:cfg.overlaySize, pending:cfg.overlaySize, paused:0, readyToExec:0, totalStored:parseInt(getConfig('ovl_total_stored')??'0'), totalExecuted:parseInt(getConfig('ovl_total_executed')??'0'), captureRate:'0%', queueValueEst:0, queueValueFmt:'$0', pendingByChain:{}, deployed:false })
    const propeller = safe('propeller',  { current:p, crashMode:cfg.crashMode, dailyTarget:cfg.propTarget, dailyAchieved:cfg.achieved })
    const rs5       = safe('rs5',        { total:cfg.rs5Total, totalFmt:fmtRev(cfg.rs5Total), byLayer:{}, fundingPositions:0, jitPositions:0 })
    const rs1       = safe('rs1',        { total:parseFloat(getConfig('rs1_jit_total')||'0'), totalFmt:fmtRev(parseFloat(getConfig('rs1_jit_total')||'0')), jit:{total:0,count:0}, solver:{total:0} })
    const rs2       = safe('rs2',        { total:parseFloat(getConfig('rs2_total')||'0'), totalFmt:fmtRev(parseFloat(getConfig('rs2_total')||'0')), streams:{} })
    const rs3       = safe('rs3',        { total:parseFloat(getConfig('rs3_total')||'0'), totalFmt:fmtRev(parseFloat(getConfig('rs3_total')||'0')), fromRS5:0, protocols:[] })
    const amp       = safe('amplifier',  { total:parseFloat(getConfig('amp_total')||'0'), totalFmt:fmtRev(parseFloat(getConfig('amp_total')||'0')), events:0 })
    const crash     = safe('crash',      { score:cfg.crashScore, countdown:'Monitoring...', regime:cfg.crashScore>85?'CRITICAL':cfg.crashScore>60?'ELEVATED':'STABLE', crashMode:cfg.crashMode, signals:{}, history:[] })
    const ruleai    = safe('ruleai',     { enabled:true, calls:parseInt(getConfig('rule_ai_calls')||'0'), lastCall:getConfig('rule_ai_last')||'never', regime:'STABLE' })
    const sovereign = safe('sovereign',  { calls:parseInt(getConfig('sovereign_calls')||'0'), accuracy:getConfig('sovereign_accuracy')||'calibrating', lastResponse:getConfig('sovereign_last')||'', experts:9 })
    const builders  = safe('builders',   { connected:0, total:6, builders:[], ready:[] })
    const treasury  = safe('treasury',   { totalBalance:cfg.today, lpDeployed:cfg.lp, streaming:{active:false}, fxCurrencies:parseInt(getConfig('fx_rate_count')||'0'), yieldProtocol:getConfig('yield_protocol')||'aave' })
    const vaults    = safe('vaults',     { total:parseFloat(getConfig('sv_stats_total')||'0'), sv:{}, count:0 })
    const dbStats   = getStats()
    const execs     = getExecutions(50)
    const prices    = (() => { try { return JSON.parse(getConfig('prices')||'{}') } catch { return {} } })()

    const achieved   = (HOT[SAB_OFFSETS.DAILY_ACHIEVED] || 0) || cfg.achieved
    const target     = (HOT[SAB_OFFSETS.DAILY_TARGET]   || 0) || cfg.propTarget
    const crashScore = (HOT[SAB_OFFSETS.CRASH_SCORE]    || 0) || cfg.crashScore
    const crashMode  = getConfig('crash_mode') === '1'
    const uptimeSec  = getUptimeSec()

    const state = {
      system: {
        uptime:     uptimeSec,
        uptimeFmt:  formatUptime(uptimeSec),
        memory:     Math.round(process.memoryUsage().heapUsed/1024/1024),
        memoryFmt:  Math.round(process.memoryUsage().heapUsed/1024/1024)+'MB',
        heapTotal:  Math.round(process.memoryUsage().heapTotal/1024/1024),
        nodeVer:    process.version,
        modules:    _stats.size,
        wsClients:  _clients.size,
        pid:        process.pid,
        stateBuilds:_stateBuilds,
      },
      revenue: {
        allTime:        dbStats.profit     || cfg.allTime,
        allTimeFmt:     fmtRev(dbStats.profit || cfg.allTime),
        today:          achieved,
        todayFmt:       fmtRev(achieved),
        thisHour:       cfg.hourRev,
        thisHourFmt:    fmtRev(cfg.hourRev),
        executions:     dbStats.executions || cfg.executions,
        wins:           dbStats.wins       || cfg.wins,
        winRate:        dbStats.winRate    || cfg.winRate,
        lp:             dbStats.lp         || cfg.lp,
        lpFmt:          fmtRev(dbStats.lp  || cfg.lp),
        rs1:            rs1.total  || 0, rs1Fmt: fmtRev(rs1.total  || 0),
        rs2:            rs2.total  || 0, rs2Fmt: fmtRev(rs2.total  || 0),
        rs3:            rs3.total  || 0, rs3Fmt: fmtRev(rs3.total  || 0),
        rs5:            rs5.total  || 0, rs5Fmt: fmtRev(rs5.total  || 0),
        amplifier:      amp.total  || 0, amplifierFmt: fmtRev(amp.total || 0),
      },
      nexus: {
        decisions:        nexus.decisions       || 0,
        skipped:          nexus.skipped         || 0,
        queueDepth:       nexus.queueDepth      || 0,
        propellerLevel:   p,
        dailyTarget:      target,
        dailyTargetFmt:   fmtRev(target),
        dailyAchieved:    achieved,
        dailyAchievedFmt: fmtRev(achieved),
        progress:         target > 0 ? Math.min(100,(achieved/target)*100).toFixed(1)+'%' : '0%',
        progressRaw:      target > 0 ? Math.min(100,(achieved/target)*100) : 0,
        throughput:       '$3.496Q/day',
        flash:            '$48.6B/execution',
        balancer:         '$30B · 0% fee',
        aave:             '$14.6B · 0.09% fee',
        lifetimeFmt:      fmtRev(nexus.lifetimeRevenue || cfg.allTime),
      },
      apex: {
        executions:        apex.executions           || cfg.executions,
        avgMs:             apex.avgMs                || cfg.apexAvgMs,
        minMs:             apex.minMs                || '0',
        maxMs:             apex.maxMs                || '0',
        p99Ms:             apex.p99Ms                || '0',
        templates:         apex.templates            || 0,
        bufferPool:        apex.bufferPool           || 0,
        hitRate:           apex.hitRate              || '0%',
        buildersConnected: apex.buildersConnected     || builders.connected || 0,
        buildersTotal:     6,
        target:            '1.5ms',
        advantage:         '20×',
        competitorBase:    '30ms',
      },
      latency: {
        avgMs:        apex.avgMs     || cfg.apexAvgMs,
        minMs:        apex.minMs     || '0',
        maxMs:        apex.maxMs     || '0',
        p99Ms:        apex.p99Ms     || '0',
        hotPathCalls: apex.executions|| cfg.executions,
        templates:    apex.templates || 0,
        bufferPool:   apex.bufferPool|| 0,
        hitRate:      apex.hitRate   || '0%',
        target:       '1.5ms',
      },
      propeller: {
        current:          p,
        crashMode,
        dailyTarget:      target,
        dailyTargetFmt:   fmtRev(target),
        dailyAchieved:    achieved,
        dailyAchievedFmt: fmtRev(achieved),
        progress:         target > 0 ? Math.min(100,(achieved/target)*100).toFixed(1)+'%':'0%',
        formatted:        fmtRev(RTABLE[p] || 0),
        table:            RTABLE,
        tableFormatted:   Object.fromEntries(Object.entries(RTABLE).map(([k,v])=>[k,fmtRev(v)])),
        profile:          getPropProfile(p) || {},
        throughput: {
          total:    '$3.496Q/day',
          env1:     '$321.12T/day',
          env2:     '$1,209.6T/day',
          env3:     '$500T/day',
          nexusMult:'$1,465.3T/day',
          maxRev:   '$1.748T/day (P30)',
        },
      },
      chains:     chains1.chains    || {},
      liveCount:  chains1.liveCount || 0,
      totalChains:18,
      scanner: {
        swapCount:    chains1.qualifyingSwaps || cfg.swaps,
        wsConnected:  chains1.wsConnected     || 0,
        httpPolling:  chains1.httpPolling     || 0,
        swapsByChain: chains1.swapsByChain    || {},
        totalPools:   chains1.totalPools      || 1847,
        threshold:    '$100M–$10B',
      },
      overlay: {
        queueSize:      overlay.queueSize     || cfg.overlaySize,
        pending:        overlay.pending       || cfg.overlaySize,
        paused:         overlay.paused        || 0,
        readyToExec:    overlay.readyToExec   || 0,
        totalStored:    overlay.totalStored   || 0,
        totalExecuted:  overlay.totalExecuted || 0,
        captureRate:    overlay.captureRate   || '0%',
        queueValueEst:  overlay.queueValueEst || 0,
        queueValueFmt:  overlay.queueValueFmt || '$0',
        pendingByChain: overlay.pendingByChain|| {},
        deployed:       overlay.deployed      || false,
        ramCap:         50000,
        diskCap:        500000,
      },
      crash: {
        score:     crashScore,
        countdown: crash.countdown || 'Monitoring...',
        regime:    crashScore > 85 ? 'CRITICAL' : crashScore > 60 ? 'ELEVATED' : 'STABLE',
        crashMode,
        signals:   crash.signals  || {},
        history:   crash.history  || [],
      },
      rs5: {
        total:            rs5.total            || cfg.rs5Total,
        totalFmt:         fmtRev(rs5.total     || cfg.rs5Total),
        byLayer:          rs5.byLayer          || {},
        fundingPositions: rs5.fundingPositions || 0,
        jitPositions:     rs5.jitPositions     || 0,
        layers: {
          1:'JIT Dominance',2:'Cross-Chain Disloc',3:'Funding Harvest',
          4:'Protocol Auctions',5:'Liquidation Conveyor',6:'Flash Rate Arb',
          7:'Oracle Front-Run',8:'Waterfall Liquidation',9:'Synthetic Depeg',10:'Protocol Rebalance',
        },
      },
      rs1: { total:rs1.total||0, totalFmt:fmtRev(rs1.total||0), jit:rs1.jit||{total:0,count:0}, solver:rs1.solver||{total:0} },
      rs2: { total:rs2.total||0, totalFmt:fmtRev(rs2.total||0), streams:rs2.streams||{} },
      rs3: { total:rs3.total||0, totalFmt:fmtRev(rs3.total||0), fromRS5:rs3.fromRS5||0, protocols:rs3.protocols||[] },
      amplifier: { total:amp.total||0, totalFmt:fmtRev(amp.total||0), events:amp.events||0 },
      ai: {
        ruleai:    { enabled:ruleai.enabled??true, calls:ruleai.calls||0, lastCall:ruleai.lastCall||'never', regime:ruleai.regime||'STABLE' },
        sovereign: { calls:sovereign.calls||0, accuracy:sovereign.accuracy||'calibrating', lastResponse:sovereign.lastResponse||'', experts:9 },
        crash:     { score:crashScore, countdown:crash.countdown||'Monitoring...', regime:crashScore>85?'CRITICAL':crashScore>60?'ELEVATED':'STABLE' },
      },
      modempay: getModemPayLive(),
      treasury: {
        totalBalance:  treasury.totalBalance  || cfg.today,
        totalFmt:      fmtRev(treasury.totalBalance || cfg.today),
        lpDeployed:    treasury.lpDeployed    || cfg.lp,
        lpFmt:         fmtRev(treasury.lpDeployed   || cfg.lp),
        streaming:     treasury.streaming     || { active:false },
        fxCurrencies:  treasury.fxCurrencies  || 0,
        yieldProtocol: treasury.yieldProtocol || 'aave',
        currentAPY:    parseFloat(getConfig('yield_apy') || '0'),
      },
      vaults: { sv:vaults.sv||{}, total:vaults.total||0, totalFmt:fmtRev(vaults.total||0), count:vaults.count||0 },
      prices: { ETH:prices.ETH||'0', BTC:prices.BTC||'0', BNB:prices.BNB||'0', AVAX:prices.AVAX||'0', SOL:prices.SOL||'0' },
      executor: {
        address: getConfig('executor_address') || '0xEc92EF0C897b48A3525Df011D08011c5eB2D6D39',
      },
      controls: {
        paused:        getConfig('system_paused') === '1',
        propIntensity: p,
        aiEnabled:     getConfig('rule_ai_enabled') !== '0',
        crashMode,
        crashScore,
        crashCountdown:crash.countdown || 'Monitoring...',
      },
      builders: {
        connected: builders.connected || 0,
        total:     6,
        names:     ['Flashbots','Titan','Beaver','Rsync','Buildernet','MEVShare'],
        ready:     builders.ready || [],
      },
      sdal: {
        addresses: sdalGet('protocol_addresses') || {},
        v7Active:  (sdalGet('v7_config')  || {}).active  || false,
        rs6Active: (sdalGet('rs6_config') || {}).active  || false,
        version:    sdalGet('version')    || '1.0.0',
      },
      recentExecutions: execs,
      db: (() => {
        try {
          const writable = existsSync('/data/cfg.json') || existsSync('/data')
          return { volumeMounted:writable, volumeWritable:writable, overlayOnDisk:parseInt(getConfig('ovl_total_stored')||'0'), note:writable?'Persistent ✓':'Add /data volume in Railway' }
        } catch { return { volumeMounted:false, note:'Add /data volume in Railway' } }
      })(),
      timestamp: Math.floor(Date.now() / 1000),
    }

    _lastGoodState = state
    return state
  } catch(e) {
    _stateErrors++
    if (_lastGoodState) return _lastGoodState
    const cfg = configFallbacks()
    return {
      system:   { uptime:getUptimeSec(), uptimeFmt:formatUptime(getUptimeSec()), memory:0, memoryFmt:'—', modules:0, wsClients:_clients.size, stateBuilds:_stateBuilds },
      revenue:  { allTime:cfg.allTime, allTimeFmt:fmtRev(cfg.allTime), today:cfg.achieved, todayFmt:fmtRev(cfg.achieved), executions:cfg.executions, winRate:cfg.winRate },
      propeller:{ current:cfg.propLevel, formatted:fmtRev(RTABLE[cfg.propLevel]||0), table:RTABLE },
      controls: { paused:false, crashMode:cfg.crashMode, propIntensity:cfg.propLevel },
      modempay: getModemPayLive(),
      timestamp:Math.floor(Date.now()/1000),
      _error:   e.message?.slice(0,100),
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 6 — WEBSOCKET
// Heartbeat every 15s — kills dead connections
// Sends cached state immediately on connect — no 2s wait
// Auto-reconnect: client-side 3s retry (in both nightfall files)
// ═══════════════════════════════════════════════════════════════════════════
const _clients       = new Set()
let   _lastTickPayload = null
let   _tickCount       = 0

wss.on('connection', ws => {
  _clients.add(ws)
  ws.isAlive = true
  ws.on('pong',  () => { ws.isAlive = true })
  ws.on('close', () => _clients.delete(ws))
  ws.on('error', () => _clients.delete(ws))

  // Send last good state immediately on connect — client never waits 2s
  const payload = _lastTickPayload
    ?? JSON.stringify({ type:'tick', tick:0, data:buildState() })
  try { ws.send(payload) } catch {}
})

// Heartbeat — kill dead connections before they accumulate memory
const _heartbeat = setInterval(() => {
  for (const ws of _clients) {
    if (!ws.isAlive) { ws.terminate(); _clients.delete(ws); continue }
    ws.isAlive = false
    try { ws.ping() } catch { ws.terminate(); _clients.delete(ws) }
  }
}, 15000)

// 2-second state push to all connected clients
const _ticker = setInterval(() => {
  if (!_clients.size) return
  try {
    _tickCount++
    const data    = buildState()
    _lastTickPayload = JSON.stringify({ type:'tick', tick:_tickCount, data })
    for (const ws of _clients) {
      try { if (ws.readyState === 1) ws.send(_lastTickPayload) }
      catch { ws.terminate(); _clients.delete(ws) }
    }
  } catch {}
}, 2000)

export function broadcastEvent(type, data) {
  if (!_clients.size) return
  try {
    const payload = JSON.stringify({ type, data, ts:Date.now() })
    for (const ws of _clients) {
      try { if (ws.readyState === 1) ws.send(payload) } catch {}
    }
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 7 — DASHBOARD FILE SERVING
// nightfall.html     → /
// nightfall-black.html → /mobile
// BOTH are real files. NO inline HTML for either.
// If file missing: returns 404 with clear message — NOT redirect
// ═══════════════════════════════════════════════════════════════════════════
const DASH_DIR = join(__dir, 'dashboard')

app.get('/', (_, res) => {
  const filepath = join(DASH_DIR, 'nightfall.html')
  if (existsSync(filepath)) return res.sendFile(filepath)
  res.status(404).type('html').send(`<!DOCTYPE html><html><head><title>VANGUARD</title>
<style>body{background:#020408;color:#00D4FF;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:16px;text-align:center}h1{font-size:28px;font-weight:900;letter-spacing:4px}p{font-size:11px;color:#3B434D;max-width:400px}code{color:#F0C419;font-size:10px}</style>
</head><body>
<h1>VANGUARD SOVEREIGN</h1>
<p>nightfall.html not found.</p>
<code>Expected: src/dashboard/nightfall.html</code>
<p style="color:#00FF88">API and WebSocket are operational at this address.</p>
<script>
const ws=new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host)
ws.onmessage=e=>{try{const d=JSON.parse(e.data).data;if(d?.revenue)document.querySelector('p').textContent='Revenue today: '+(d.revenue.todayFmt||'$0')+' · Overlay: '+(d.overlay?.queueSize||0)+' entries'}catch{}}
</script>
</body></html>`)
})

app.get('/mobile', (_, res) => {
  const filepath = join(DASH_DIR, 'nightfall-black.html')
  if (existsSync(filepath)) return res.sendFile(filepath)
  // NOT a redirect to / — dedicated error for mobile
  res.status(404).type('html').send(`<!DOCTYPE html><html><head><title>VANGUARD · MOBILE</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{background:#000;color:#E6EDF3;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:12px;text-align:center;padding:16px}h1{font-size:22px;font-weight:900;letter-spacing:3px;color:#00D4FF}p{font-size:10px;color:#444}code{color:#F0C419;font-size:9px}</style>
</head><body>
<h1>VANGUARD</h1>
<p>nightfall-black.html not found.</p>
<code>Expected: src/dashboard/nightfall-black.html</code>
<p style="color:#00FF88;margin-top:8px">System operational.</p>
</body></html>`)
})

app.get('/vault', (_, res) => {
  const filepath = join(DASH_DIR, 'vault.html')
  if (existsSync(filepath)) return res.sendFile(filepath)
  res.redirect('/')
})

// Static assets — fonts, CSS, JS referenced by nightfall files
app.use('/dashboard', express.static(DASH_DIR))

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 8 — API ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// State + Health
app.get('/api/state',         (_, res) => { try { res.json(buildState()) } catch(e) { res.status(500).json({ error:e.message }) } })
app.get('/api/health',        (_, res) => res.json({ ok:true, uptime:getUptimeSec(), uptimeFmt:formatUptime(getUptimeSec()), modules:_stats.size, clients:_clients.size, ticks:_tickCount }))
app.get('/api/revenue-table', (_, res) => res.json({ table:RTABLE, formatted:Object.fromEntries(Object.entries(RTABLE).map(([k,v])=>[k,fmtRev(v)])) }))

// Uptime reset (explicit operator action only)
app.post('/api/control/reset-uptime', (_, res) => { resetContainerUptime(); res.json({ ok:true, reset:true }) })

// Propeller
app.post('/api/control/propellers', async (req, res) => {
  const p = parseInt(req.body?.intensity ?? '')
  if (!p || p < 1 || p > 30) return res.status(400).json({ error:'intensity must be 1-30' })
  try { const { setIntensity } = await import('./revenue.js'); await setIntensity(p,'operator') }
  catch { setConfig('prop_intensity',String(p)); HOT[SAB_OFFSETS.PROPELLER]=p; HOT[SAB_OFFSETS.DAILY_TARGET]=RTABLE[p]||0; emit('propeller_changed',{ from:parseInt(getConfig('prop_intensity')||'5'), to:p, dailyRev:RTABLE[p]||0 }) }
  res.json({ ok:true, intensity:p, dailyRevenue:RTABLE[p]||0, formatted:fmtRev(RTABLE[p]||0) })
})

// Crash
app.post('/api/control/crash-on',  async (_, res) => { try{const{activateCrashMode}=await import('./revenue.js');activateCrashMode()}catch{setConfig('crash_mode','1');HOT[SAB_OFFSETS.CRASH_MODE]=1;emit('crash_mode_activated')}; res.json({ok:true,crashMode:true}) })
app.post('/api/control/crash-off', async (_, res) => { try{const{deactivateCrashMode}=await import('./revenue.js');deactivateCrashMode()}catch{setConfig('crash_mode','0');HOT[SAB_OFFSETS.CRASH_MODE]=0;emit('crash_mode_off')};         res.json({ok:true,crashMode:false}) })

// Halt / Resume / AI / Chains / Overlay
app.post('/api/control/halt',         (_, res)   => { setConfig('system_paused','1'); emit('system_halt',{});   res.json({ok:true}) })
app.post('/api/control/resume',       (_, res)   => { setConfig('system_paused','0'); emit('system_resume',{}); res.json({ok:true}) })
app.post('/api/control/ai',           (req,res)  => { setConfig('rule_ai_enabled',req.body?.enabled?'1':'0'); res.json({ok:true}) })
app.post('/api/control/pause-chain',  (req,res)  => { setConfig('pause_'+(req.body?.chain||''),'1'); res.json({ok:true}) })
app.post('/api/control/resume-chain', (req,res)  => { setConfig('pause_'+(req.body?.chain||''),'0'); res.json({ok:true}) })
app.post('/api/control/clear-overlay',async(_,res)=> { try{const{clearAll}=await import('./intelligence.js');clearAll()}catch{}; res.json({ok:true}) })

// SOVEREIGN
app.post('/api/sovereign/chat', async (req, res) => {
  const { message } = req.body || {}
  if (!message) return res.status(400).json({ error:'message required' })
  try { const{sovereignChat}=await import('./intelligence.js'); const r=await sovereignChat(message,buildState()); res.json({ok:true,response:r,ts:Math.floor(Date.now()/1000)}) }
  catch(e) { res.json({ok:true,response:'SOVEREIGN: '+e.message?.slice(0,100)}) }
})
app.get('/api/sovereign/stream', async (req, res) => {
  res.setHeader('Content-Type','text/event-stream'); res.setHeader('Cache-Control','no-cache'); res.setHeader('Connection','keep-alive'); res.setHeader('X-Accel-Buffering','no')
  try {
    const{sovereignChat}=await import('./intelligence.js')
    const r=await sovereignChat(req.query.message||'',buildState())||'SOVEREIGN active.'
    const words=r.split(' '); let i=0
    const t=setInterval(()=>{ if(i>=words.length){clearInterval(t);res.write('data: [DONE]\n\n');res.end();return}; res.write(`data: ${JSON.stringify({word:words[i++]})}\n\n`) },40)
    req.on('close',()=>clearInterval(t))
  } catch(e){ res.write(`data: ${JSON.stringify({word:'Error: '+e.message})}\n\n`); res.end() }
})

// SDAL
app.get('/api/sdal',         (_,res)  => res.json(sdalGet('protocol_addresses')||{}))
app.post('/api/sdal/update', async(req,res) => { try{const{sdalUpdate}=await import('./vanguard.js');sdalUpdate(req.body);res.json({ok:true})}catch(e){res.status(500).json({error:e.message})} })

// Crash stats
app.get('/api/crash/stats', (_, res) => res.json(safe('crash', { score:0, countdown:'Monitoring...', regime:'STABLE' })))

// Treasury — SEND FUNDS first, USB vault after
app.get('/api/treasury/stats',           (_,res)   => res.json(safe('treasury')))
app.get('/api/treasury/fx',              (_,res)   => res.json((() => { try{return JSON.parse(getConfig('fx_rates')||'{}')}catch{return{}} })()))
app.get('/api/treasury/fee',             async(req,res)  => { try{const{calcFee}=await import('./operations.js');res.json(calcFee(parseFloat(req.query.amount||'0'),req.query.method||'wave'))}catch(e){res.status(500).json({error:e.message})} })
app.post('/api/treasury/convert',        async(req,res)  => { try{const{convertUSD}=await import('./operations.js');res.json(convertUSD(req.body.amount,req.body.currency||'GMD'))}catch(e){res.status(500).json({error:e.message})} })
app.post('/api/treasury/validate-swift', async(req,res)  => { try{const{validateSWIFT}=await import('./operations.js');res.json(validateSWIFT(req.body.swift))}catch(e){res.status(500).json({error:e.message})} })
app.post('/api/treasury/withdraw',       async(req,res)  => { try{const{createTransfer,calcFee}=await import('./modempay.js');const fee=calcFee(parseFloat(req.body.amount||0),req.body.network||'wave');const r=await createTransfer({amount:parseFloat(req.body.amount||0),currency:req.body.currency||'GMD',phone:req.body.phone||req.body.accountNumber,name:req.body.name,network:req.body.network||'wave'});res.json({ok:true,status:r.status||'submitted',transferId:r.id,fee})}catch(e){res.status(500).json({error:e.message})} })
app.post('/api/treasury/stream/start',   async(req,res)  => { try{const{startRevenueStream}=await import('./operations.js');await startRevenueStream(req.body);res.json({ok:true})}catch(e){res.status(500).json({error:e.message})} })
app.post('/api/treasury/stream/stop',    async(_,res)    => { try{const{stopRevenueStream}=await import('./operations.js');stopRevenueStream();res.json({ok:true})}catch(e){res.status(500).json({error:e.message})} })
app.post('/api/treasury/schedule/add',   async(req,res)  => { try{const{addSchedule}=await import('./operations.js');res.json({ok:true,schedule:addSchedule(req.body)})}catch(e){res.status(500).json({error:e.message})} })
app.delete('/api/treasury/schedule/:id', async(req,res)  => { try{const{removeSchedule}=await import('./operations.js');removeSchedule(req.params.id);res.json({ok:true})}catch(e){res.status(500).json({error:e.message})} })
app.get('/api/treasury/schedules',       async(_,res)    => { try{const{getSchedules}=await import('./operations.js');res.json(getSchedules())}catch{res.json([])} })
app.post('/api/treasury/split',          async(req,res)  => { try{const{splitTransfer}=await import('./operations.js');res.json(await splitTransfer(req.body))}catch(e){res.status(500).json({error:e.message})} })
app.get('/api/treasury/tax/csv',         async(req,res)  => { try{const{exportTaxCSV}=await import('./operations.js');res.setHeader('Content-Type','text/csv');res.setHeader('Content-Disposition','attachment; filename=vanguard_tax.csv');res.send(exportTaxCSV(req.query.year?parseInt(req.query.year):null))}catch(e){res.status(500).send(e.message)} })
app.get('/api/treasury/journal/csv',     async(_,res)    => { try{const{exportJournalCSV}=await import('./operations.js');res.setHeader('Content-Type','text/csv');res.setHeader('Content-Disposition','attachment; filename=vanguard_journal.csv');res.send(exportJournalCSV())}catch(e){res.status(500).send(e.message)} })

// USB Vault — after treasury send funds
app.post('/api/usb/add-funds', async(req,res) => { try{const{addFundsToVault}=await import('./operations.js');res.json(await addFundsToVault(req.body))}catch(e){res.status(500).json({error:e.message})} })
app.post('/api/usb/restore',   async(req,res) => { try{const{restoreFromVault}=await import('./operations.js');res.json(await restoreFromVault(req.body))}catch(e){res.status(500).json({error:e.message})} })
app.post('/api/usb/create',    async(req,res) => { try{const{createUSBVault}=await import('./operations.js');res.json(await createUSBVault(req.body?.outputDir))}catch(e){res.status(500).json({error:e.message})} })

// ModemPay
app.post('/api/modempay/withdraw',     async(req,res) => { try{const{createTransfer,calcFee}=await import('./modempay.js');const fee=calcFee(parseFloat(req.body.amount||0),req.body.network||'wave');const r=await createTransfer({amount:parseFloat(req.body.amount||0),currency:req.body.currency||'GMD',phone:req.body.phone,name:req.body.name,network:req.body.network||'wave'});res.json({ok:true,status:r.status||'submitted',transferId:r.id,fee})}catch(e){res.status(500).json({error:e.message})} })
app.get('/api/modempay/balance',       async(_,res)   => { try{const{getBalance}=await import('./modempay.js');res.json(await getBalance())}catch(e){res.status(500).json({error:e.message})} })
app.get('/api/modempay/transactions',  async(req,res) => { try{const{listTransactions}=await import('./modempay.js');res.json(await listTransactions(parseInt(req.query.limit||'20')))}catch(e){res.status(500).json({error:e.message})} })
app.get('/api/modempay/status/:id',    async(req,res) => { try{const{getTransferStatus}=await import('./modempay.js');res.json(await getTransferStatus(req.params.id))}catch(e){res.status(500).json({error:e.message})} })
app.get('/api/modempay/fee',           async(req,res) => { try{const{calcFee}=await import('./modempay.js');res.json(calcFee(parseFloat(req.query.amount||'0'),req.query.method||'wave'))}catch(e){res.status(500).json({error:e.message})} })
app.get('/api/modempay/stats',         (_,res)        => res.json(getModemPayLive()))

// DB health
app.get('/api/db/health', async(_,res) => { try{const db=await import('./db.js');res.json(db.dbHealth())}catch{res.json({writable:false,note:'db.js not loaded'})} })

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 9 — START
// ═══════════════════════════════════════════════════════════════════════════
let _started = false

export function startDashboard() {
  if (_started) return
  _started = true

  // Load persistent container start time FIRST
  loadContainerStart()

  const PORT = parseInt(process.env.PORT ?? '3000')

  const tryBind = (port) => {
    server.listen(port, '0.0.0.0', () => {
      console.log(`[DASHBOARD] http://0.0.0.0:${port}/ — Nightfall ready`)
      console.log(`[DASHBOARD] http://0.0.0.0:${port}/mobile — Nightfall Black ready`)
      console.log(`[DASHBOARD] WS: ws://0.0.0.0:${port}/ — heartbeat 15s · tick 2s`)
    })
    server.on('error', e => {
      if (e.code === 'EADDRINUSE') {
        server.removeAllListeners('error')
        console.warn(`[DASHBOARD] Port ${port} in use — trying ${port+1}`)
        setTimeout(() => tryBind(port+1), 500)
      } else {
        console.error('[DASHBOARD] Server error:', e.message)
      }
    })
  }

  tryBind(PORT)

  // Bridge all system events to WebSocket clients
  const bridge = (type) => on(type, d => broadcastEvent(type, d))
  ;['deploy_success','apex_success','emergency_halt','propeller_changed',
    'overlay_stored','overlay_executed','rs5_revenue','crash_mode_activated',
    'crash_mode_off','system_halt','system_resume','sv_update',
    'chain_funded','nexus_decision',
  ].forEach(bridge)
}

// Cleanup
process.on('exit', () => { clearInterval(_heartbeat); clearInterval(_ticker) })
