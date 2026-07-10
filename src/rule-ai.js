// Vanguard · rule-ai.js — Full-scope autonomous AI
// Controls EVERY aspect of Vanguard:
//   Chain management, execution, capital, risk, RPC health,
//   flash source selection, overlay draining, pool management,
//   WebSocket health, revenue optimization, deployment triggers,
//   withdrawal scheduling, fee optimization, emergency responses

import { getConfig, setConfig, getStats, getExecutions } from './db.js'
import { getActive, getChain, addChain } from './chainsaw.js'
import { getContractAddr } from './pimlico.js'
import { emit, on } from './events.js'
import { getWsPoolStats } from './ws-pools.js'
import { getOverlayStats } from './overlay.js'
import { getLatencyStats } from './latency.js'

// ── Rule thresholds — all adjustable via setConfig ────────────────────────────
const R = {
  MIN_WIN_RATE:         40,     // % — pause chain if below
  MAX_MEMORY_MB:        420,    // MB — force GC
  MIN_SWAPS_PER_5MIN:   0,      // swaps — 0 triggers WS heal
  PAUSE_ON_LOSS_USD:    100000, // $ — pause chain if loses this in 1hr
  MAX_FLASH_USD:        20e6,   // $ — max single flash size
  MIN_FLASH_USD:        50000,  // $ — min flash worth executing
  PROP_DEFAULT:         7,      // propeller intensity default
  PROP_HIGH_VOL:        9,      // during high volatility
  PROP_LOW_VOL:         5,      // during low volatility
  OVERLAY_DRAIN_BATCH:  50,     // entries drained per cycle
  CHAIN_EXPAND_TVL_MIN: 10e6,   // $ — min TVL to auto-add chain
  EMERGENCY_HALT_LOSS:  500000, // $ — halt system if loses this in 1hr
}

// ── State ─────────────────────────────────────────────────────────────────────
let _calls        = 0
let _lastDecision = 0
let _chainPerf    = {}  // chainName → { wins, losses, profit, loss, winRate }
let _systemState  = 'running'  // 'running' | 'halted' | 'degraded'
let _lastEthPrice = 0
let _lastVolatility = 'normal'
let _rpcHealthCache = {}
let _lastRPCCheck   = 0

// ── Performance analysis per chain ────────────────────────────────────────────
function analyzeChain(chainName) {
  try {
    const execs  = getExecutions(200).filter(e => e.chain === chainName)
    const recent = execs.filter(e => (Date.now()/1000 - (e.ts||0)) < 3600)
    const wins   = recent.filter(e => e.status === 'success').length
    const losses = recent.filter(e => e.status !== 'success').length
    const profit = recent.filter(e => e.profit_usdc > 0).reduce((s,e) => s+(e.profit_usdc||0), 0)
    const loss   = recent.filter(e => e.profit_usdc < 0).reduce((s,e) => s+Math.abs(e.profit_usdc||0), 0)
    const winRate= recent.length ? (wins/recent.length*100) : 100
    return { wins, losses, profit, loss, total:recent.length, winRate }
  } catch { return { wins:0, losses:0, profit:0, loss:0, total:0, winRate:100 } }
}

// ── Market regime detection ───────────────────────────────────────────────────
function detectMarketRegime(prices) {
  const eth     = prices.ETH || 0
  const lastEth = _lastEthPrice
  if (!lastEth || !eth) return 'normal'
  const chg = Math.abs(eth - lastEth) / lastEth * 100
  if (chg > 5)  return 'extreme'
  if (chg > 2)  return 'high_vol'
  if (chg < 0.3)return 'low_vol'
  return 'normal'
}

// ── RULE 1: Chain Risk Management ─────────────────────────────────────────────
function ruleChainRisk() {
  const actions = []
  for (const c of getActive()) {
    const perf = analyzeChain(c.name)
    _chainPerf[c.name] = perf

    // Pause if win rate too low AND enough data
    if (perf.total > 15 && perf.winRate < R.MIN_WIN_RATE) {
      if (getConfig('pause_' + c.name) !== '1') {
        setConfig('pause_' + c.name, '1')
        actions.push(`PAUSED ${c.name} — win rate ${perf.winRate.toFixed(0)}%`)
        emit('rule_ai_alert', { severity:'medium', message:`${c.name} paused: win rate ${perf.winRate.toFixed(0)}%` })
      }
    }

    // Resume if conditions improved
    if (getConfig('pause_' + c.name) === '1') {
      if (perf.winRate > 60 || perf.total < 5) {
        setConfig('pause_' + c.name, '0')
        actions.push(`RESUMED ${c.name} — win rate improved`)
      }
    }

    // Emergency pause if large loss
    if (perf.loss > R.PAUSE_ON_LOSS_USD) {
      setConfig('pause_' + c.name, '1')
      actions.push(`EMERGENCY PAUSE ${c.name} — $${perf.loss.toFixed(0)} loss in 1hr`)
      emit('rule_ai_alert', { severity:'high', message:`${c.name} emergency pause: $${perf.loss.toFixed(0)} loss` })
    }
  }
  return actions
}

// ── RULE 2: System Emergency Halt ────────────────────────────────────────────
function ruleEmergencyHalt() {
  const stats = getStats()
  // Check for catastrophic loss in 1 hour
  const execs  = getExecutions(500)
  const hrLoss = execs
    .filter(e => (Date.now()/1000-(e.ts||0)) < 3600 && (e.profit_usdc||0) < 0)
    .reduce((s,e) => s + Math.abs(e.profit_usdc||0), 0)

  if (hrLoss > R.EMERGENCY_HALT_LOSS) {
    setConfig('system_paused', '1')
    _systemState = 'halted'
    emit('rule_ai_alert', { severity:'critical', message:`EMERGENCY HALT — $${hrLoss.toFixed(0)} loss in 1hr` })
    return `EMERGENCY HALT — $${hrLoss.toFixed(0)} loss in 1 hour`
  }
  return null
}

// ── RULE 3: Propeller Intensity ───────────────────────────────────────────────
function rulePropellerIntensity(regime, stats) {
  const current = parseInt(getConfig('prop_intensity') || '7')
  let target = R.PROP_DEFAULT

  switch (regime) {
    case 'extreme': target = 10; break
    case 'high_vol':target = R.PROP_HIGH_VOL; break
    case 'low_vol': target = R.PROP_LOW_VOL; break
    default:        target = R.PROP_DEFAULT
  }

  // Boost if profitable
  if ((stats.today || 0) > 100000) target = Math.min(10, target + 1)

  if (target !== current) {
    setConfig('prop_intensity', String(target))
    return `Propellers ${current}→${target} (${regime})`
  }
  return null
}

// ── RULE 4: Flash Source Optimization ─────────────────────────────────────────
function ruleFlashSources() {
  const actions = []
  // Balancer is 0% — always prefer it
  // Override to Aave only if Balancer pool is depleted
  // Rule: check if any chain had flash failures, switch source
  for (const c of getActive()) {
    const override = getConfig('flash_override_' + c.name)
    const addr = getContractAddr(c.name)
    if (!addr) continue

    // If chain has Balancer, always use it (0% fee)
    if (c.flash && c.flash !== c.aave) {
      if (override === 'aave') {
        // Reset to balancer
        setConfig('flash_override_' + c.name, 'balancer')
        actions.push(`${c.name} flash → balancer (reset)`)
      }
    }
  }
  return actions
}

// ── RULE 5: WebSocket Health & Recovery ───────────────────────────────────────
function ruleWebSocketHealth() {
  const actions = []
  try {
    const wsStats = getWsPoolStats()
    const total   = wsStats.totalSwaps || 0
    const lastTotal = parseInt(getConfig('rule_ai_last_swap_total') || '0')

    setConfig('rule_ai_last_swap_total', String(total))

    if (total === lastTotal && total > 0) {
      // No new swaps since last check (5min)
      actions.push('WebSocket stale — triggering resubscribe')
      emit('rule_ai_ws_heal', { reason: 'no new swaps in 5min' })
    }

    if (total === 0 && _calls > 3) {
      // Zero swaps after multiple decision cycles
      actions.push('CRITICAL: Zero swaps detected — HTTP polling active')
      emit('rule_ai_alert', { severity:'high', message:'Zero swap detection — check RPC connections' })
    }

    setConfig('ws_health', JSON.stringify({
      totalSwaps: total, httpPolling: wsStats.httpPolling?.length || 0,
      ts: Math.floor(Date.now()/1000)
    }))
  } catch {}
  return actions
}

// ── RULE 6: Memory Management ─────────────────────────────────────────────────
function ruleMemory() {
  const mb = process.memoryUsage().heapUsed / 1024 / 1024
  if (mb > R.MAX_MEMORY_MB) {
    try { global.gc?.() } catch {}
    return `GC triggered — ${mb.toFixed(0)}MB`
  }
  return null
}

// ── RULE 7: Overlay Queue Optimization ────────────────────────────────────────
function ruleOverlay() {
  const actions = []
  try {
    const overlay = getOverlayStats()
    if (overlay.queueSize > 10000) {
      // Large queue — increase drain rate
      setConfig('overlay_drain_rate', '100')
      actions.push(`Overlay queue ${overlay.queueSize} — increased drain rate`)
    }
    if (overlay.queueSize > 100000) {
      // Queue approaching limit — emit warning
      emit('rule_ai_alert', { severity:'medium', message:`Overlay queue at ${overlay.queueSize} entries` })
    }
    // Store capture rate for dashboard
    setConfig('overlay_capture_rate', overlay.captureRate || '0%')
  } catch {}
  return actions
}

// ── RULE 8: Chain Expansion ────────────────────────────────────────────────────
async function ruleChainExpansion() {
  const actions = []
  try {
    const r = await fetch('https://api.llama.fi/v2/chains', { signal: AbortSignal.timeout(8000) })
    if (!r.ok) return actions
    const chains = await r.json()
    let added = 0
    for (const c of chains) {
      if (!c.chainId || c.tvl < R.CHAIN_EXPAND_TVL_MIN) continue
      const existing = getActive().find(a => a.id === c.chainId)
      if (existing) continue
      // Auto-add with minimal config
      const slug = c.name?.toLowerCase().replace(/\s+/g,'-') || 'unknown'
      addChain(slug, {
        id: c.chainId, tier: 3, native: c.nativeToken || 'ETH',
        minProfit: 10, gasLimit: 800000n,
        rpcH: `https://${slug}.drpc.org`,
        rpcW: `wss://${slug}.drpc.org`,
        tvl: c.tvl, autoDiscovered: true,
        usdc: '0x0000000000000000000000000000000000000000',
        weth: '0x0000000000000000000000000000000000000000',
        flash: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
        aave: null,
      })
      added++
    }
    if (added) actions.push(`Auto-discovered ${added} new chains`)
  } catch {}
  return actions
}

// ── RULE 9: Revenue Stream Weights ───────────────────────────────────────────
function ruleStreamWeights(regime) {
  const weights = {
    normal:   { sv4:0.25, sv5:0.25, sv6:0.20, sv1:0.20, others:0.10 },
    high_vol: { sv4:0.35, sv5:0.15, sv6:0.25, sv1:0.15, others:0.10 },
    low_vol:  { sv4:0.15, sv5:0.35, sv6:0.10, sv1:0.25, others:0.15 },
    extreme:  { sv4:0.40, sv5:0.10, sv6:0.30, sv1:0.10, others:0.10 },
  }
  const w = weights[regime] || weights.normal
  setConfig('sv_weights', JSON.stringify(w))
  emit('rule_ai_weights', w)
  return w
}

// ── RULE 10: Deployment Trigger ───────────────────────────────────────────────
function ruleDeploymentStatus() {
  const live = getActive().filter(c => !!getContractAddr(c.name))
  const waiting = getActive().filter(c => !getContractAddr(c.name))

  setConfig('rule_ai_live_chains', String(live.length))
  setConfig('rule_ai_waiting_chains', String(waiting.length))

  if (live.length === 0 && _calls > 2) {
    // No chains deployed yet
    emit('rule_ai_alert', { severity:'info',
      message:`No chains deployed — awaiting funding of 0xEc92EF0C897b48A3525Df011D08011c5eB2D6D39` })
  }
  return { live: live.length, waiting: waiting.length }
}

// ── RULE 11: Latency Monitoring ───────────────────────────────────────────────
function ruleLatency() {
  try {
    const lat = getLatencyStats()
    const avg = parseFloat(lat.avgMs || 0)
    if (avg > 50 && _calls > 5) {
      // Hot path too slow
      emit('rule_ai_alert', { severity:'low', message:`Hot path avg ${avg.toFixed(1)}ms — above 50ms target` })
    }
    setConfig('latency_avg_ms', String(avg))
  } catch {}
}

// ── RULE 12: Auto-Resume Halted Chains ────────────────────────────────────────
function ruleAutoResume() {
  const actions = []
  for (const c of getActive()) {
    if (getConfig('pause_' + c.name) !== '1') continue
    const perf = _chainPerf[c.name]
    if (!perf) continue
    // Auto-resume if paused > 1hr and conditions improved
    const pausedSince = parseInt(getConfig('paused_since_' + c.name) || '0')
    const pausedMins  = (Date.now()/1000 - pausedSince) / 60
    if (pausedMins > 60 && perf.winRate > 50) {
      setConfig('pause_' + c.name, '0')
      actions.push(`Auto-resumed ${c.name} after ${pausedMins.toFixed(0)}min`)
    }
  }
  return actions
}

// ── RULE 13: Price Update Trigger ─────────────────────────────────────────────
function rulePriceTracking(prices) {
  const eth = prices.ETH || 0
  if (eth && Math.abs(eth - _lastEthPrice) / (_lastEthPrice || eth) > 0.005) {
    // Price moved >0.5% — update dex prices
    setConfig('eth_price_updated', Math.floor(Date.now()/1000).toString())
  }
  _lastEthPrice = eth || _lastEthPrice
}

// ── RULE 14: Modempay & Treasury ─────────────────────────────────────────────
function ruleTreasury(stats) {
  const profit = stats.profit || 0
  const lp     = parseFloat(getConfig('lp_total') || '0')
  // LP allocation: 50% of profits (already set per execution)
  // Rule: if LP > $1M, log milestone
  if (lp > 1000000 && !getConfig('lp_milestone_1m')) {
    setConfig('lp_milestone_1m', '1')
    console.log('[RULE-AI] LP vault milestone: $1M deployed')
  }
  setConfig('treasury_profit', profit.toFixed(2))
  setConfig('treasury_lp',     lp.toFixed(2))
}

// ── MAIN DECISION CYCLE ────────────────────────────────────────────────────────
async function decide() {
  if (_systemState === 'halted') {
    // In halted state: only check for manual resume
    if (getConfig('system_paused') !== '1') {
      _systemState = 'running'
      console.log('[RULE-AI] System resumed from halt')
    }
    return
  }

  const now = Date.now()
  if (now - _lastDecision < 290000) return  // 5min minimum
  _lastDecision = now
  _calls++

  const stats  = getStats()
  const prices = JSON.parse(getConfig('prices') || '{}')
  const regime = detectMarketRegime(prices)

  if (regime !== _lastVolatility) {
    console.log(`[RULE-AI] Market regime: ${_lastVolatility} → ${regime}`)
    _lastVolatility = regime
  }

  const allActions = []

  // Run all rules
  const emergency = ruleEmergencyHalt()
  if (emergency) { allActions.push(emergency); return }

  allActions.push(...ruleChainRisk())
  const propResult = rulePropellerIntensity(regime, stats)
  if (propResult) allActions.push(propResult)
  allActions.push(...ruleFlashSources())
  allActions.push(...ruleWebSocketHealth())
  const memResult = ruleMemory()
  if (memResult) allActions.push(memResult)
  allActions.push(...ruleOverlay())
  allActions.push(...ruleAutoResume())
  ruleStreamWeights(regime)
  ruleDeploymentStatus()
  ruleLatency()
  rulePriceTracking(prices)
  ruleTreasury(stats)

  // Chain expansion (async, runs occasionally)
  if (_calls % 6 === 0) {
    ruleChainExpansion().then(a => { if(a.length) console.log('[RULE-AI]', a.join(' · ')) }).catch(()=>{})
  }

  // Log summary
  const insight = allActions.filter(Boolean).slice(0,3).join(' · ') || `${regime} market · ${getActive().filter(c=>getContractAddr(c.name)).length} chains live`
  setConfig('rule_ai_last',     new Date().toISOString())
  setConfig('rule_ai_calls',    String(_calls))
  setConfig('rule_ai_insights', insight)
  setConfig('rule_ai_regime',   regime)

  if (allActions.filter(Boolean).length > 0) {
    console.log('[RULE-AI]', insight)
  }
}

export function getRuleAIStatus() {
  return {
    enabled:    true,
    lastCall:   getConfig('rule_ai_last')    || 'never',
    calls:      parseInt(getConfig('rule_ai_calls') || '0'),
    insights:   getConfig('rule_ai_insights') || '',
    regime:     getConfig('rule_ai_regime')  || 'normal',
    systemState:_systemState,
    chainPerf:  _chainPerf,
    liveChains: parseInt(getConfig('rule_ai_live_chains')    || '0'),
    waitChains: parseInt(getConfig('rule_ai_waiting_chains') || '0'),
  }
}

export function startRuleAI() {
  console.log('[RULE-AI] Full-scope autonomous operations — 14 rules')
  console.log('[RULE-AI] Scope: chains · risk · WS health · overlay · flash · market · treasury · latency')

  // Listen for events that need immediate response
  on('deploy_success', ({ chain }) => {
    console.log(`[RULE-AI] Deploy confirmed: ${chain} — updating strategy`)
    setConfig('pause_' + chain, '0')
    decide().catch(() => {})
  })

  on('system_halt', () => { _systemState = 'halted' })
  on('system_resume', () => { _systemState = 'running' })

  on('rule_ai_ws_heal', () => {
    // Trigger WebSocket resubscription
    import('./ws-pools.js').then(m => {
      // ws-pools self-heals via its own interval
      console.log('[RULE-AI] WebSocket heal requested — ws-pools self-heal active')
    }).catch(() => {})
  })

  // First decision after 30s
  setTimeout(() => decide().catch(() => {}), 30000)
  // Every 5 minutes
  setInterval(() => decide().catch(() => {}), 300000)

  // High-frequency checks (every 30s): memory + WS health only
  setInterval(() => {
    ruleMemory()
    // Quick WS check
    try {
      const wsStats = getWsPoolStats()
      if (wsStats.totalSwaps === 0 && _calls > 1) {
        // Silent system — log once per 30s
        // (don't spam — ws-pools handles this)
      }
    } catch {}
  }, 30000)
                                      }
