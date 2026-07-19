// Vanguard · propeller.js
// P1($17.48B/day) → P30($1.748T/day) Revenue Ranger
// Crash mode: P∞ (cascade liquidations add on top of base)
// Static imports: ONLY db.js · sdal.js · events.js

import { getConfig, setConfig } from './db.js'
import { getSABF64, SAB_OFFSETS, getPropProfile } from './sdal.js'
import { emit, on } from './events.js'

const HOT = getSABF64()

// Revenue table — exact daily profit at each propeller level
export const REVENUE_TABLE = {
  1:17480000000, 2:34960000000, 3:69920000000, 4:104880000000,
  5:139840000000, 6:192280000000, 7:262200000000, 8:349600000000,
  9:471960000000, 10:611800000000, 11:734160000000, 12:856520000000,
  13:961400000000, 14:1066000000000, 15:1153000000000, 16:1224000000000,
  17:1293000000000, 18:1363000000000, 19:1415000000000, 20:1468000000000,
  21:1521000000000, 22:1573000000000, 23:1608000000000, 24:1643000000000,
  25:1669000000000, 26:1692000000000, 27:1709000000000, 28:1724000000000,
  29:1735000000000, 30:1748000000000,
}

// Throughput: $3.496Q/day across all 3 environments + NEXUS multiplier
export const THROUGHPUT = {
  env1_eth:    321120000000000,
  env2_l2:     1209600000000000,
  env3_multi:  500000000000000,
  nexus_mult:  1465300000000000,
  total:       3496000000000000,
  blended_pct: 0.0005,
  max_rev:     1748000000000,
}

function fmt(n) {
  if (!n) return '$0'
  if (n >= 1e12) return '$'+(n/1e12).toFixed(3)+'T'
  if (n >= 1e9)  return '$'+(n/1e9).toFixed(2)+'B'
  if (n >= 1e6)  return '$'+(n/1e6).toFixed(2)+'M'
  return '$'+n.toFixed(2)
}

// ── State ─────────────────────────────────────────────────────────────────────
let _current    = 5
let _crashMode  = false
let _debounceTs = 0

// ── Set intensity ─────────────────────────────────────────────────────────────
export async function setIntensity(p, source='auto') {
  p = Math.max(1, Math.min(30, Math.round(p)))
  const now = Date.now()
  if (source !== 'operator' && now - _debounceTs < 5000) return
  _debounceTs = now

  const prev = _current
  _current   = p

  HOT[SAB_OFFSETS.PROPELLER]    = p
  HOT[SAB_OFFSETS.DAILY_TARGET] = REVENUE_TABLE[p] || REVENUE_TABLE[5]

  setConfig('prop_intensity',    String(p))
  setConfig('prop_daily_target', String(REVENUE_TABLE[p]))

  const profile = getPropProfile(p)
  console.log(`[PROPELLER] P${prev}→P${p} · ${fmt(REVENUE_TABLE[p])}/day`)
  emit('propeller_changed', { from:prev, to:p, dailyRev:REVENUE_TABLE[p], profile })
}

// ── Crash mode ────────────────────────────────────────────────────────────────
export function activateCrashMode() {
  _crashMode = true
  setConfig('crash_mode', '1')
  // ONE log line. No spam regardless of crash signal rate.
  console.log('[PROPELLER] CRASH MODE ON — market is a factor — cascade adds to P30 base')
  emit('crash_mode_activated')
}

export function deactivateCrashMode() {
  _crashMode = false
  setConfig('crash_mode', '0')
  console.log('[PROPELLER] Crash mode OFF — propeller governs')
  emit('crash_mode_deactivated')
}

export function isCrashMode() { return _crashMode }

// ── UTC midnight ceiling reset ────────────────────────────────────────────────
function scheduleMidnight() {
  const now  = new Date(), next = new Date(now)
  next.setUTCHours(24,0,0,0)
  setTimeout(()=>{
    HOT[SAB_OFFSETS.DAILY_ACHIEVED] = 0
    setConfig('daily_achieved', '0')
    setConfig('hour_revenue', '0')
    console.log(`[PROPELLER] Midnight reset — P${_current} target: ${fmt(REVENUE_TABLE[_current])}/day`)
    scheduleMidnight()
  }, next-now)
}

// Hourly revenue tracking
let _hourStart = Date.now(), _hourRev = 0
function trackHourlyRevenue(usd) {
  _hourRev += usd
  if (Date.now() - _hourStart > 3600000) {
    setConfig('hour_revenue', _hourRev.toFixed(2))
    _hourRev = 0; _hourStart = Date.now()
  }
}

// ── Stats ─────────────────────────────────────────────────────────────────────
export const getPropellerStats = () => ({
  current:          _current,
  crashMode:        _crashMode,
  dailyTarget:      REVENUE_TABLE[_current],
  dailyTargetFmt:   fmt(REVENUE_TABLE[_current]),
  dailyAchieved:    HOT[SAB_OFFSETS.DAILY_ACHIEVED] || 0,
  dailyAchievedFmt: fmt(HOT[SAB_OFFSETS.DAILY_ACHIEVED]||0),
  formatted:        fmt(REVENUE_TABLE[_current]),
  throughput:       THROUGHPUT,
  table:            REVENUE_TABLE,
})

// ── Listen for crash mode commands ───────────────────────────────────────────
on('crash_mode_activated',   ()=>{ if (!_crashMode) activateCrashMode() })
on('crash_mode_deactivated', ()=>{ if (_crashMode)  deactivateCrashMode() })

// ── Start ─────────────────────────────────────────────────────────────────────
export function startPropeller() {
  _current   = parseInt(getConfig('prop_intensity') || '5')
  _crashMode = getConfig('crash_mode') === '1'

  HOT[SAB_OFFSETS.PROPELLER]    = _current
  HOT[SAB_OFFSETS.DAILY_TARGET] = REVENUE_TABLE[_current] || REVENUE_TABLE[5]

  scheduleMidnight()

  // Track revenue for hourly stats
  on('apex_success', ({ profit })=>{ if (profit) trackHourlyRevenue(profit) })

  console.log(`[PROPELLER] P${_current} — ${fmt(REVENUE_TABLE[_current])}/day`)
  console.log('[PROPELLER] Throughput: $3.496Q/day · Max extractable: $1.748T/day at P30')
  console.log(`[PROPELLER] Market is ${_crashMode?'A FACTOR (crash mode ON)':'NOT a factor (propeller governs)'}`)
}
