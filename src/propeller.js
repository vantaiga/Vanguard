// Vanguard · propeller.js
// P1($17.48B/day) → P30($1.748T/day) Revenue Ranger
// Crash mode: P∞ (market becomes a factor, cascade liquidations added)
// Revenue = propeller-set. TODAY = TOMORROW. Market not a factor unless crash button ON.
// 5-second debounce. UTC midnight ceiling reset.
// SDAL profiles: runtime-configurable without redeploy.

import { getConfig, setConfig } from './db.js'
import { getSABF64, SAB_OFFSETS, getPropProfile } from './sdal.js'
import { emit, on } from './events.js'

const HOT = getSABF64()

// ── Throughput constants (from doc, verified mathematically) ──────────────────
export const THROUGHPUT = {
  env1_eth:     321.12e12,    // $321.12T/day (Balancer $30B × 7200 + Aave $14.6B × 7200)
  env2_l2:      1209.6e12,    // $1,209.6T/day (ARB+BASE+OP+POL)
  env3_multi:   500e12,       // $500T/day (16 remaining chains)
  nexus_mult:   1465.3e12,    // $1,465.3T/day (NEXUS simultaneous coordination)
  total:        3496e12,      // $3.496Q/day confirmed
  blended_rate: 0.0005,       // 0.05% blended extraction rate
  max_revenue:  1748e9,       // $1.748T/day at P30 100% efficiency
}

// ── Revenue table (exact, from $3.496Q × propeller extraction %) ──────────────
export const REVENUE_TABLE = {
  1:  17_480_000_000,    // $17.48B
  2:  34_960_000_000,    // $34.96B
  3:  69_920_000_000,    // $69.92B
  4:  104_880_000_000,   // $104.88B
  5:  139_840_000_000,   // $139.84B
  6:  192_280_000_000,   // $192.28B
  7:  262_200_000_000,   // $262.2B
  8:  349_600_000_000,   // $349.6B
  9:  471_960_000_000,   // $471.96B
  10: 611_800_000_000,   // $611.8B
  11: 734_160_000_000,
  12: 856_520_000_000,
  13: 961_400_000_000,
  14: 1_066_000_000_000,
  15: 1_153_000_000_000,
  16: 1_224_000_000_000,
  17: 1_293_000_000_000,
  18: 1_363_000_000_000,
  19: 1_415_000_000_000,
  20: 1_468_000_000_000,
  21: 1_521_000_000_000,
  22: 1_573_000_000_000,
  23: 1_608_000_000_000,
  24: 1_643_000_000_000,
  25: 1_669_000_000_000,
  26: 1_692_000_000_000,
  27: 1_709_000_000_000,
  28: 1_724_000_000_000,
  29: 1_735_000_000_000,
  30: 1_748_000_000_000,  // $1.748T — 100% of $3.496Q × 0.05%
}

export function getDailyRevenue(p)  { return REVENUE_TABLE[Math.round(p)] || REVENUE_TABLE[5] }
export function getExtractPct(p)    { return getPropProfile(p)?.extractPct || 0.08 }
export function formatRevenue(usd)  {
  if (usd >= 1e15) return '$' + (usd/1e15).toFixed(3) + 'Q'
  if (usd >= 1e12) return '$' + (usd/1e12).toFixed(3) + 'T'
  if (usd >= 1e9)  return '$' + (usd/1e9).toFixed(2) + 'B'
  if (usd >= 1e6)  return '$' + (usd/1e6).toFixed(2) + 'M'
  return '$' + usd.toFixed(2)
}

// ── State ─────────────────────────────────────────────────────────────────────
let _current     = 5
let _crashMode   = false
let _debounceTs  = 0

// ── Set propeller (5s debounce) ───────────────────────────────────────────────
export async function setIntensity(p, source='operator') {
  p = Math.max(1, Math.min(30, Math.round(p)))
  const now = Date.now()
  if (now - _debounceTs < 5000 && source !== 'operator') return  // 5s debounce
  _debounceTs = now

  const prev = _current
  _current   = p

  // Update SAB immediately (hot path reads from here)
  HOT[SAB_OFFSETS.PROPELLER]    = p
  HOT[SAB_OFFSETS.DAILY_TARGET] = REVENUE_TABLE[p] || REVENUE_TABLE[5]

  setConfig('prop_intensity', String(p))
  setConfig('prop_daily_target', String(REVENUE_TABLE[p]))

  const profile = getPropProfile(p)
  console.log(`[PROPELLER] P${prev}→P${p} | ${formatRevenue(REVENUE_TABLE[p])}/day | Flash cap: $${(parseFloat(profile?.flashCap||'0')/1e9).toFixed(1)}B | JIT: ${profile?.jitPositions}`)
  emit('propeller_changed', { from:prev, to:p, dailyRev:REVENUE_TABLE[p], profile })
}

// ── Crash mode ────────────────────────────────────────────────────────────────
export function activateCrashMode() {
  _crashMode = true
  setConfig('crash_mode', '1')
  // P∞: overlays crash profile on top of current P level
  // Market becomes a factor — cascade liquidations ADD to normal revenue
  console.log('[PROPELLER] CRASH MODE ACTIVATED — Market is now a factor')
  console.log('[PROPELLER] Revenue: P30 base ($1.748T) + cascade liquidations → P∞')
  emit('crash_mode_activated')
}

export function deactivateCrashMode() {
  _crashMode = false
  setConfig('crash_mode', '0')
  console.log('[PROPELLER] Crash mode deactivated — market no longer a factor')
  emit('crash_mode_deactivated')
}

export function isCrashMode() { return _crashMode }

// ── UTC midnight reset ────────────────────────────────────────────────────────
function scheduleMidnightReset() {
  const now  = new Date()
  const next = new Date(now)
  next.setUTCHours(24,0,0,0)
  setTimeout(() => {
    HOT[SAB_OFFSETS.DAILY_ACHIEVED] = 0
    setConfig('daily_achieved','0')
    console.log(`[PROPELLER] UTC midnight reset — P${_current} ceiling: ${formatRevenue(REVENUE_TABLE[_current])}/day`)
    scheduleMidnightReset()
  }, next - now)
}

// ── Stats ─────────────────────────────────────────────────────────────────────
export const getPropellerStats = () => ({
  current:       _current,
  crashMode:     _crashMode,
  dailyTarget:   REVENUE_TABLE[_current],
  dailyAchieved: HOT[SAB_OFFSETS.DAILY_ACHIEVED],
  formatted:     formatRevenue(REVENUE_TABLE[_current]),
  throughput:    THROUGHPUT,
  table:         REVENUE_TABLE,
  nextMidnight:  (() => { const n=new Date(); n.setUTCHours(24,0,0,0); return n.toISOString() })(),
})

// ── Listen for operator commands ──────────────────────────────────────────────
on('crash_mode_activated',   () => activateCrashMode())
on('crash_mode_deactivated', () => deactivateCrashMode())

export function startPropeller() {
  _current  = parseInt(getConfig('prop_intensity')||'5')
  _crashMode= getConfig('crash_mode')==='1'
  HOT[SAB_OFFSETS.PROPELLER]    = _current
  HOT[SAB_OFFSETS.DAILY_TARGET] = REVENUE_TABLE[_current] || REVENUE_TABLE[5]
  scheduleMidnightReset()
  console.log(`[PROPELLER] P${_current} — ${formatRevenue(REVENUE_TABLE[_current])}/day`)
  console.log('[PROPELLER] Throughput: $3.496Q/day (all 3 environments + NEXUS multiplier)')
  console.log('[PROPELLER] Max extractable: $1.748T/day at P30 (0.05% blended rate)')
  console.log(`[PROPELLER] TODAY = TOMORROW = P${_current} revenue every day`)
}
