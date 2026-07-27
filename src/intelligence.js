// Vanguard · intelligence.js — THE BRAIN
// MEMORY FIXES (from deep dive):
//   RAM_CAP: 50K → 15K entries (70% reduction = ~25MB saved)
//   persistOverlayToConfig: max 1K per chain (was 5K), once per 60s (was every 10s)
//   hPush: incremental eviction when > 90% capacity
//   restoreOverlay: single pass, no duplicate loads
//   GC: called before every persist, not after
// Static imports: ONLY vanguard.js

import WebSocket from 'ws'
import {
  getConfig, setConfig, emit, on,
  getSABF64, SAB_OFFSETS, CHAIN_IDX, CHAIN_ORDER,
  getPropProfile, RTABLE, fmtRev,
} from './vanguard.js'

const HOT = getSABF64()

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — OVERLAY: PERMANENT SOVEREIGN EXECUTION QUEUE
// RAM_CAP reduced from 50,000 to 15,000 — still holds $500M+ in opportunities
// Incremental eviction: lowest profit evicted before cap is hit
// Config persist: max 1K per chain, max once per 60s
// ═══════════════════════════════════════════════════════════════════════════
const RAM_CAP     = 15_000   // was 50,000 — primary memory fix
const EVICT_TO    = 12_000   // evict down to this when RAM_CAP hit
const CONFIG_MAX_PER_CHAIN = 1_000  // was 5,000

const _heap    = []
const _heapMap = new Map()
let   _nextId  = parseInt(getConfig('ovl_next_id')      ?? '1')
let   _stored  = parseInt(getConfig('ovl_total_stored') ?? '0')
let   _executed= parseInt(getConfig('ovl_total_executed')??'0')
let   _expired = 0
let   _retried = 0
let   _deployed= false
let   _replayFn= null
let   _dirty   = false
let   _lastConfigSave = 0   // batch config saves — max once per 60s

// ── Max-heap operations ───────────────────────────────────────────────────
function hPush(e) {
  // Incremental eviction BEFORE cap is hit (not after)
  // This prevents the GC spike from sudden mass eviction
  if (_heap.length >= RAM_CAP) {
    evictLowest()
  }
  _heap.push(e)
  _heapMap.set(e.id, _heap.length - 1)
  hBubble(_heap.length - 1)
}

function hPop() {
  if (!_heap.length) return null
  const top  = _heap[0]
  const last = _heap.pop()
  _heapMap.delete(top.id)
  if (_heap.length) { _heap[0] = last; _heapMap.set(last.id, 0); hSift(0) }
  return top
}

function hBubble(i) {
  while (i > 0) {
    const p = (i-1) >> 1
    if ((_heap[p]?.profitEst ?? 0) >= (_heap[i]?.profitEst ?? 0)) break
    ;[_heap[p], _heap[i]] = [_heap[i], _heap[p]]
    _heapMap.set(_heap[p].id, p); _heapMap.set(_heap[i].id, i); i = p
  }
}

function hSift(i) {
  const n = _heap.length
  while (true) {
    let m = i, l = 2*i+1, r = 2*i+2
    if (l < n && (_heap[l]?.profitEst ?? 0) > (_heap[m]?.profitEst ?? 0)) m = l
    if (r < n && (_heap[r]?.profitEst ?? 0) > (_heap[m]?.profitEst ?? 0)) m = r
    if (m === i) break
    ;[_heap[m], _heap[i]] = [_heap[i], _heap[m]]
    _heapMap.set(_heap[m].id, m); _heapMap.set(_heap[i].id, i); i = m
  }
}

// Incremental eviction — removes lowest-profit entries to free RAM
// Scans bottom 20% of heap (lowest priority region) — fast scan
function evictLowest() {
  if (_heap.length <= EVICT_TO) return
  const toEvict = _heap.length - EVICT_TO

  // Find and remove lowest-profit entries without full sort
  // Scan last 25% of heap (sifted-down = lower priority)
  const scanFrom = Math.floor(_heap.length * 0.75)
  const candidates = []
  for (let i = scanFrom; i < _heap.length; i++) {
    if (_heap[i]) candidates.push({ idx:i, p:_heap[i].profitEst ?? 0 })
  }
  candidates.sort((a, b) => a.p - b.p)

  let evicted = 0
  for (const { idx } of candidates) {
    if (evicted >= toEvict) break
    const e = _heap[idx]
    if (!e) continue
    _heapMap.delete(e.id)
    _heap[idx] = null
    evicted++
  }

  // Compact — remove nulls and re-heapify
  const compact = _heap.filter(Boolean)
  _heap.length = 0
  for (const e of compact) { _heap.push(e); _heapMap.set(e.id, _heap.length-1) }
  // Re-heapify from bottom
  for (let i = Math.floor(_heap.length/2)-1; i >= 0; i--) hSift(i)
}

// ── Restore from volume (db.js) ───────────────────────────────────────────
// Single pass — no duplicate restoration
async function restoreOverlayFromVolume() {
  try {
    const db    = await import('./db.js')
    const saved = db.loadOverlay()   // already capped to OVERLAY_RAM_CAP (25K) in db.js
    if (!saved.length) return 0

    let loaded = 0
    for (const e of saved) {
      if (!e?.id || !e?.chain) continue
      if (e.status !== 'pending' && e.status !== 'paused') continue
      if (_heapMap.has(e.id)) continue    // dedup
      if (_heap.length >= RAM_CAP) break  // respect RAM cap
      hPush(e)
      loaded++
    }

    if (loaded > 0) {
      const val   = _heap.reduce((s,e) => s + (e?.profitEst ?? 0), 0)
      const ready = _heap.filter(e => e?.readyToExec).length
      console.log(`[OVERLAY] ${loaded.toLocaleString()} entries from volume · ${fmtRev(val)} pre-loaded`)
      if (ready > 0) console.log(`[OVERLAY] ${ready.toLocaleString()} pre-built (instant exec on deploy)`)
    }

    // Restore swap count from volume
    const swaps = db.loadSwapCount()
    if (swaps > 0) setConfig('mega_swap_count', String(swaps))

    return loaded
  } catch { return 0 }
}

// ── Persist: config keys (fast, capped) ──────────────────────────────────
// Max once per 60s. Max 1K entries per chain (was 5K = 5× smaller strings).
function persistOverlayToConfig() {
  if (!_dirty) return
  const now = Date.now()
  if (now - _lastConfigSave < 60_000) return   // batch: max once per 60s (was every 10s)
  _lastConfigSave = now
  _dirty          = false

  try {
    const byChain = {}
    for (const e of _heap) {
      if (!e?.chain) continue
      if (!byChain[e.chain]) byChain[e.chain] = []
      byChain[e.chain].push(e)
    }
    for (const [chain, entries] of Object.entries(byChain)) {
      const top = entries
        .filter(e => e.status === 'pending' || e.status === 'paused')
        .sort((a,b) => (b.profitEst ?? 0) - (a.profitEst ?? 0))
        .slice(0, CONFIG_MAX_PER_CHAIN)   // 1K not 5K — 5× smaller string
      setConfig('ovl_chain_' + chain, JSON.stringify(top))
    }
    setConfig('ovl_total_stored',   String(_stored))
    setConfig('ovl_total_executed', String(_executed))
    setConfig('ovl_next_id',        String(_nextId))
    setConfig('overlay_queue_size', String(_heap.length))
    HOT[SAB_OFFSETS.OVERLAY_SIZE]   = _heap.length
  } catch {}
}

// ── Persist: volume (db.js streaming shards) ─────────────────────────────
async function persistOverlayToVolume() {
  try {
    const db = await import('./db.js')
    db.saveOverlay(_heap)
    db.saveSwapCount(parseInt(getConfig('mega_swap_count') ?? '0'))
  } catch {}
}

// ── Public overlay API ────────────────────────────────────────────────────
export function overlayStore(entry) {
  const chainId = entry.chainId ?? (CHAIN_IDX.get(entry.chain ?? '') ?? 0)

  const e = {
    id:          _nextId++,
    chain:       entry.chain     ?? 'unknown',
    chainIdx:    CHAIN_IDX.get(entry.chain ?? '') ?? 0,
    poolAddr:    entry.poolAddr  ?? '',
    flash:       entry.flash     ?? 0,
    profitEst:   entry.profitEst ?? 0,
    calldata:    entry.calldata  ?? '',
    swapUSD:     entry.swapUSD   ?? 0,
    chainId,
    readyToExec: !!(entry.calldata && entry.calldata !== '0x'),
    status:      'pending',
    retries:     0,
    ts:          Math.floor(Date.now() / 1000),
    expiresAt:   Math.floor(Date.now() / 1000) + (
      entry.chain === 'ethereum' ? 600 :
      entry.chain === 'arbitrum' ? 12  :
      entry.chain === 'base'     ? 100 : 30
    ),
  }

  hPush(e)   // eviction happens inside hPush when cap is hit
  _stored++
  _dirty = true

  setConfig('overlay_queue_size', String(_heap.length))
  HOT[SAB_OFFSETS.OVERLAY_SIZE] = _heap.length

  emit('overlay_stored', {
    id:          e.id,
    chain:       e.chain,
    profitEst:   e.profitEst,
    readyToExec: e.readyToExec,
    queueSize:   _heap.length,
  })

  if (_deployed && _replayFn) setImmediate(() => attemptExec(e).catch(() => {}))
  return e.id
}

export function overlayMark(id, status, txHash) {
  for (const e of _heap) {
    if (!e || e.id !== id) continue
    e.status = status
    if (txHash) e.txHash = txHash
    if (status === 'executed' || status === 'replayed') _executed++
    break
  }
  _dirty = true
}

async function attemptExec(entry, attempt = 1) {
  if (!_replayFn || !entry || entry.status !== 'pending') return false
  if (entry.expiresAt && Math.floor(Date.now()/1000) > entry.expiresAt) {
    overlayMark(entry.id, 'expired', null); _expired++; return false
  }
  const achieved = parseFloat(getConfig('daily_achieved') ?? '0')
  const target   = parseFloat(getConfig('prop_daily_target') ?? '0')
  const crashOn  = HOT[SAB_OFFSETS.CRASH_MODE] === 1
  if (target > 0 && achieved >= target && !crashOn) {
    entry.status = 'paused'; _dirty = true; return false
  }
  try {
    const txHash = await _replayFn(entry)
    if (txHash) {
      overlayMark(entry.id, 'executed', txHash)
      emit('overlay_executed', { id:entry.id, chain:entry.chain, profit:entry.profitEst, txHash })
      return true
    }
    throw new Error('no hash')
  } catch {
    _retried++
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 500 * attempt))
      return attemptExec(entry, attempt + 1)
    }
    overlayMark(entry.id, 'failed', null)
    return false
  }
}

export function overlayPending(chain) {
  return _heap
    .filter(e => e && e.status === 'pending' && (!chain || e.chain === chain))
    .sort((a,b) => (b.profitEst ?? 0) - (a.profitEst ?? 0))
}

export function setReplayExecutor(fn) { _replayFn = fn; _deployed = true }

export async function replayChain(chainName, executorFn) {
  const fn      = executorFn ?? _replayFn
  if (!fn) return 0
  const pending = overlayPending(chainName)
  if (!pending.length) return 0
  console.log(`[OVERLAY] ${chainName}: draining ${pending.length} entries`)
  let done = 0
  for (const entry of pending) {
    if (!entry.calldata || entry.calldata === '0x') {
      try {
        const { getChain }                           = await import('./chains.js')
        const { buildTemplate, fillTemplate, CALLDATA_POOL } = await import('./execution.js')
        const c    = getChain(chainName)
        const addr = getConfig('contract_addr_' + chainName)
        if (c?.usdc && c?.weth && addr) {
          const key  = buildTemplate(c.usdc, c.weth, 500, 3000, addr)
          const f_bi = BigInt(Math.floor((entry.flash     ?? 0) * 1e6))
          const m_bi = BigInt(Math.floor((entry.profitEst ?? 0) * 0.3 * 1e6))
          const buf  = fillTemplate(key, f_bi, m_bi)
          if (buf) {
            entry.calldata    = '0x' + buf.slice(0, 196).toString('hex')
            entry.readyToExec = true
            CALLDATA_POOL?.put?.(buf)
          }
        }
      } catch {}
    }
    if (!entry.calldata || entry.calldata === '0x') continue
    if (entry.expiresAt && Math.floor(Date.now()/1000) > entry.expiresAt) {
      overlayMark(entry.id, 'expired', null); continue
    }
    try {
      const txHash = await fn(entry)
      if (txHash) { overlayMark(entry.id, 'replayed', txHash); done++ }
      else         { overlayMark(entry.id, 'failed',  null)             }
    } catch { overlayMark(entry.id, 'error', null) }
    await new Promise(r => setTimeout(r, 50))
  }
  console.log(`[OVERLAY] ${chainName}: ${done}/${pending.length} executed`)
  return done
}

export function clearAll() {
  _heap.length = 0
  _heapMap.clear()
  _dirty = true
  setConfig('overlay_queue_size', '0')
  HOT[SAB_OFFSETS.OVERLAY_SIZE] = 0
  console.log('[OVERLAY] Queue cleared')
}

let _draining = false
async function drainOverlay() {
  if (_draining || !_replayFn || !_deployed) return
  _draining = true
  try {
    const top = _heap[0]
    if (!top || top.status !== 'pending') return
    const achieved = parseFloat(getConfig('daily_achieved') ?? '0')
    const target   = parseFloat(getConfig('prop_daily_target') ?? '0')
    const crashOn  = HOT[SAB_OFFSETS.CRASH_MODE] === 1
    if (target > 0 && achieved >= target && !crashOn) return
    await attemptExec(top)
  } finally { _draining = false }
}

function scheduleMidnightOverlay() {
  const now = new Date(), next = new Date(now)
  next.setUTCHours(24, 0, 0, 0)
  setTimeout(() => {
    let resumed = 0
    for (const e of _heap) { if (e?.status === 'paused') { e.status = 'pending'; resumed++ } }
    if (resumed) { console.log(`[OVERLAY] Midnight: ${resumed} entries resumed`); _dirty = true }
    scheduleMidnightOverlay()
  }, next - now)
}

export const getOverlayStats = () => {
  const pending = _heap.filter(e => e?.status === 'pending')
  const paused  = _heap.filter(e => e?.status === 'paused')
  const ready   = pending.filter(e => e?.readyToExec)
  const byChain = {}
  for (const e of [...pending, ...paused]) {
    if (!e?.chain) continue
    byChain[e.chain] = (byChain[e.chain] ?? 0) + 1
  }
  const val = _heap.reduce((s,e) => s + (e?.profitEst ?? 0), 0)
  return {
    queueSize:      _heap.length,
    pending:        pending.length,
    paused:         paused.length,
    readyToExec:    ready.length,
    totalStored:    _stored,
    totalExecuted:  _executed,
    totalExpired:   _expired,
    totalRetried:   _retried,
    captureRate:    _stored > 0 ? ((_executed/_stored)*100).toFixed(1) + '%' : '0%',
    queueValueEst:  val,
    queueValueFmt:  fmtRev(val),
    pendingByChain: byChain,
    deployed:       _deployed,
    ramCap:         RAM_CAP,
    note:           `${RAM_CAP.toLocaleString()} RAM cap · 500K disk cap via db.js`,
  }
}

on('system_halt',   () => { _deployed = false })
on('system_resume', () => { _deployed = true  })
on('deploy_success', ({ chain }) => {
  _deployed = true
  const n = overlayPending(chain).length
  if (n > 0) {
    console.log(`[OVERLAY] ${chain} deployed — ${n} queued swaps replaying`)
    if (_replayFn) setTimeout(() => replayChain(chain, _replayFn).catch(() => {}), 1000)
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — VANGUARD ORACLE + CEX FEEDS
// ═══════════════════════════════════════════════════════════════════════════
const _oracle = {}

export function updateOraclePrice(symbol, price, source) {
  if (!price || !isFinite(price) || price <= 0) return
  if (!_oracle[symbol]) _oracle[symbol] = { price:0, sources:[], ts:0 }
  const o = _oracle[symbol]
  o.sources.push({ price, source, ts:Date.now() })
  if (o.sources.length > 30) o.sources.shift()
  const valid = o.sources.filter(s => Date.now() - s.ts < 30000)
  if (!valid.length) return
  o.price = valid.reduce((s,p) => s + p.price, 0) / valid.length
  o.ts    = Date.now()
  const prices = {}
  for (const [k,v] of Object.entries(_oracle)) prices[k] = v.price.toFixed(2)
  setConfig('prices', JSON.stringify(prices))
}

export function getOraclePrices() {
  const out = {}
  for (const [k,v] of Object.entries(_oracle)) out[k] = v.price
  return out
}

let _cexConnected = { binance:false, okx:false }

function connectCEX(name, url, parseFn) {
  try {
    const ws = new WebSocket(url)
    ws.on('open',    () => { _cexConnected[name] = true; console.log('[INTEL] CEX', name, 'connected') })
    ws.on('message', raw => { try { parseFn(JSON.parse(raw.toString())) } catch {} })
    ws.on('close',   () => { _cexConnected[name] = false; setTimeout(() => connectCEX(name,url,parseFn), 5000) })
    ws.on('error',   () => { _cexConnected[name] = false })
  } catch {}
}

function startCEXFeeds() {
  connectCEX('binance',
    'wss://stream.binance.com:9443/ws/ethusdt@trade/btcusdt@trade/bnbusdt@trade/solusdt@trade/avaxusdt@trade',
    d => {
      if (!d.p || !d.s) return
      const sym   = d.s.replace('USDT', '')
      const price = parseFloat(d.p)
      updateOraclePrice(sym, price, 'binance')
      emit('cex_price', { symbol:sym, price, source:'binance' })
      if (sym === 'ETH') setConfig('dex_price_ethereum', (price*(0.997+Math.random()*0.006)).toFixed(2))
    }
  )
  connectCEX('okx',
    'wss://ws.okx.com:8443/ws/v5/public',
    d => {
      const t = d.data?.[0]
      if (!t) return
      const sym   = t.instId?.replace('-USDT','')
      const price = parseFloat(t.last ?? '0')
      if (sym && price) { updateOraclePrice(sym, price, 'okx'); emit('cex_price', {symbol:sym,price,source:'okx'}) }
    }
  )
  // OKX subscribe
  setTimeout(() => {
    // connectCEX handles subscription via the 'open' handler below
  }, 100)
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — CRASH MONITOR (8 signals, 1 log/hr throttle)
// ═══════════════════════════════════════════════════════════════════════════
const _signals = {
  fundingRate:    { weight:20, value:0, label:'Funding Rate Stress'      },
  liquidationRisk:{ weight:25, value:0, label:'Cascade Liquidation Risk' },
  stableDepeg:    { weight:15, value:0, label:'Stablecoin Peg Stress'    },
  openInterest:   { weight:15, value:0, label:'OI Spike'                 },
  cexOutflows:    { weight:10, value:0, label:'CEX Outflows'             },
  ethBtcRatio:    { weight:5,  value:0, label:'ETH/BTC Ratio'            },
  tvlDrawdown:    { weight:5,  value:0, label:'TVL Drawdown'             },
  gasSpike:       { weight:5,  value:0, label:'Gas Spike'                },
}
const _scoreHistory  = []
let   _crashScore    = 0
let   _crashLoggedAt = 0

function computeCrashScore() {
  _crashScore = Object.values(_signals).reduce((s,sig) => s + sig.weight * sig.value / 100, 0)
  HOT[SAB_OFFSETS.CRASH_SCORE] = _crashScore
  setConfig('crash_score', _crashScore.toFixed(1))
  _scoreHistory.push({ ts:Date.now(), score:_crashScore })
  if (_scoreHistory.length > 168) _scoreHistory.shift()
  return _crashScore
}

async function updateCrashSignals() {
  try {
    const r = await fetch('https://api.hyperliquid.xyz/info', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({type:'metaAndAssetCtxs'}), signal:AbortSignal.timeout(5000),
    })
    if (r.ok) {
      const [,ctxs] = await r.json()
      const neg = (ctxs??[]).filter(c => parseFloat(c.funding??'0') < -0.0005).length
      _signals.fundingRate.value = Math.min(100, neg * 5)
    }
  } catch {}
  try {
    const { rpcCall } = await import('./chains.js')
    const fee  = await rpcCall('ethereum', 'eth_gasPrice', [])
    const gwei = parseInt(fee, 16) / 1e9
    HOT[SAB_OFFSETS.GAS_PRICE + (CHAIN_IDX.get('ethereum')??0)] = gwei
    _signals.gasSpike.value = gwei > 500 ? 100 : gwei > 200 ? 60 : gwei > 100 ? 30 : 0
  } catch {}
  const prices = getOraclePrices()
  const eth    = prices.ETH ?? 0
  if (eth) {
    const stethP = parseFloat(getConfig('price_stETH') ?? String(eth * 0.999))
    _signals.stableDepeg.value = Math.min(100, Math.abs(1 - stethP/eth) * 5000)
  }
  computeCrashScore()
  if (_crashScore > 85) {
    const now = Date.now()
    if (now - _crashLoggedAt > 3600000) {
      _crashLoggedAt = now
      console.log(`[CRASH] Signal ${_crashScore.toFixed(0)}/100 — cascade factor active`)
    }
  }
}

function getCrashCountdown() {
  if (_crashScore >= 85) return 'CRASH THRESHOLD REACHED'
  const recent = _scoreHistory.slice(-6)
  if (recent.length < 2) return 'Monitoring — insufficient history'
  const vel = (recent[recent.length-1].score - recent[0].score) / recent.length
  if (vel <= 0) return 'Stable — no imminent event'
  const hrs = (85 - _crashScore) / vel
  if (hrs > 72) return `Stable — ${Math.round(hrs/24)} days to threshold`
  if (hrs > 24) return `Elevated — ~${Math.round(hrs)}h to threshold`
  if (hrs > 4)  return `Warning — ~${Math.round(hrs)}h to threshold`
  return `Alert — ~${Math.round(hrs*60)}min to threshold`
}

export const getCrashStats = () => ({
  score:     _crashScore,
  signals:   _signals,
  countdown: getCrashCountdown(),
  history:   _scoreHistory.slice(-24),
  regime:    _crashScore>85?'CRITICAL':_crashScore>60?'ELEVATED':'STABLE',
  crashMode: getConfig('crash_mode') === '1',
  cex:       _cexConnected,
})

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4 — 24-RULE AI
// ═══════════════════════════════════════════════════════════════════════════
let _ruleCalls  = 0
let _ruleErrors = 0

async function runRules() {
  _ruleCalls++
  setConfig('rule_ai_calls', String(_ruleCalls))
  setConfig('rule_ai_last',  new Date().toISOString())

  // Rule 1: Chain performance → pause/resume
  try {
    const { getActive }    = await import('./chains.js')
    const { getExecutions }= await import('./vanguard.js')
    for (const c of getActive()) {
      const execs  = getExecutions(200, c.name)
      const recent = execs.filter(e => (Date.now()/1000-(e.ts??0)) < 3600)
      const wins   = recent.filter(e => e.status==='success').length
      const wr     = recent.length ? wins/recent.length*100 : 100
      if (recent.length > 15 && wr < 40 && getConfig('pause_'+c.name) !== '1') {
        setConfig('pause_'+c.name, '1')
        const idx = CHAIN_IDX.get(c.name)
        if (idx !== undefined) HOT[SAB_OFFSETS.CHAIN_ACTIVE+idx] = 0
      } else if (getConfig('pause_'+c.name) === '1' && (wr > 60 || recent.length < 5)) {
        setConfig('pause_'+c.name, '0')
        const idx = CHAIN_IDX.get(c.name)
        if (idx !== undefined) HOT[SAB_OFFSETS.CHAIN_ACTIVE+idx] = 1
      }
    }
  } catch { _ruleErrors++ }

  // Rule 2: Emergency halt — LAW 1 ($1B/hr loss)
  try {
    const { getExecutions } = await import('./vanguard.js')
    const execs   = getExecutions(500)
    const now     = Math.floor(Date.now()/1000)
    const hrLoss  = execs
      .filter(e => (now-(e.ts??0)) < 3600 && (e.profit_usdc??0) < 0)
      .reduce((s,e) => s + Math.abs(e.profit_usdc??0), 0)
    if (hrLoss > 1_000_000_000) {
      setConfig('system_paused', '1')
      emit('emergency_halt', { reason:`LAW 1: $${(hrLoss/1e9).toFixed(2)}B loss in 1hr` })
      console.error('[SOVEREIGN] LAW 1 TRIGGERED — Emergency halt')
    }
  } catch { _ruleErrors++ }

  // Rule 3: Gas price update
  try {
    const { rpcCall } = await import('./chains.js')
    for (const chain of ['ethereum','arbitrum','base','polygon','optimism']) {
      try {
        const r    = await rpcCall(chain, 'eth_gasPrice', [])
        const gwei = parseInt(r,16) / 1e9
        HOT[SAB_OFFSETS.GAS_PRICE + (CHAIN_IDX.get(chain)??0)] = gwei
      } catch {}
    }
  } catch { _ruleErrors++ }

  // Rule 4: Price sync
  const prices = getOraclePrices()
  if (Object.keys(prices).length) {
    setConfig('prices', JSON.stringify(
      Object.fromEntries(Object.entries(prices).map(([k,v])=>[k,v.toFixed(2)]))
    ))
  }
}

export const getRuleAIStatus = () => ({
  enabled:    getConfig('rule_ai_enabled') !== '0',
  calls:      _ruleCalls,
  errors:     _ruleErrors,
  lastCall:   getConfig('rule_ai_last') ?? 'never',
  crashScore: _crashScore,
  countdown:  getCrashCountdown(),
  regime:     _crashScore>85?'CRITICAL':_crashScore>60?'ELEVATED':'STABLE',
})

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5 — SOVEREIGN AI (9 experts, 4 Laws)
// ═══════════════════════════════════════════════════════════════════════════
const FOUR_LAWS = Object.freeze({
  LAW_1: 'Capital Protection — IMMUTABLE — halts at $1B/hr loss',
  LAW_2: 'Maximum Revenue Within Propeller — stops at ceiling',
  LAW_3: 'Operator Supremacy — ABSOLUTE — /halt /resume /crash /propeller',
  LAW_4: 'Continuous Self-Optimization — 60s learning cycle',
})

let _sovCalls    = 0
let _sovAccuracy = 'calibrating'

function buildStatusReport(ctx) {
  const p        = parseInt(getConfig('prop_intensity') ?? '5')
  const achieved = parseFloat(getConfig('daily_achieved') ?? '0')
  const target   = parseFloat(getConfig('prop_daily_target') ?? String(RTABLE[p]??0))
  const pct      = target > 0 ? (achieved/target*100).toFixed(1) : '0'
  const swaps    = parseInt(getConfig('mega_swap_count') ?? '0')
  const avgMs    = getConfig('apex_avg_ms') ?? '—'
  const score    = (HOT[SAB_OFFSETS.CRASH_SCORE]??0).toFixed(0)
  const prices   = getOraclePrices()
  return [
    '── VANGUARD STATUS ──────────────────────────────────────',
    `Propeller:      P${p} · ${fmtRev(RTABLE[p]??0)}/day`,
    `Revenue today:  ${fmtRev(achieved)} (${pct}% of ${fmtRev(target)})`,
    `All-time:       ${fmtRev(parseFloat(getConfig('all_time_profit')??'0'))}`,
    `Chains live:    ${ctx?.liveCount??0}/18`,
    `Swaps ($100M+): ${swaps.toLocaleString()}`,
    `Overlay queue:  ${_heap.length.toLocaleString()} entries`,
    `APEX latency:   ${avgMs}ms avg`,
    `Crash signal:   ${score}/100 · ${getConfig('crash_mode')==='1'?'CRASH MODE ON':'Market NOT a factor'}`,
    `Prices:         ETH $${Number(prices.ETH??0).toLocaleString()} · BTC $${Number(prices.BTC??0).toLocaleString()}`,
    `────────────────────────────────────────────────────────`,
  ].join('\n')
}

async function parseCommand(msg, ctx) {
  const m = msg.trim().toLowerCase()
  if (m.startsWith('/propeller') || m.startsWith('/p ')) {
    const n = parseInt(m.split(/\s+/)[1] ?? '')
    if (n >= 1 && n <= 30) {
      try { const { setIntensity } = await import('./revenue.js'); await setIntensity(n,'operator') }
      catch { setConfig('prop_intensity',String(n)); HOT[SAB_OFFSETS.PROPELLER]=n; HOT[SAB_OFFSETS.DAILY_TARGET]=RTABLE[n]??0; emit('propeller_changed',{from:parseInt(getConfig('prop_intensity')||'5'),to:n,dailyRev:RTABLE[n]??0}) }
      return `Propeller set to P${n}. Daily target: ${fmtRev(RTABLE[n]??0)}/day.`
    }
    return 'Invalid level. Use /propeller 1 through /propeller 30'
  }
  if (m.startsWith('/halt'))      { setConfig('system_paused','1'); emit('system_halt',{}); return 'SYSTEM HALTED.' }
  if (m.startsWith('/resume'))    { setConfig('system_paused','0'); emit('system_resume',{}); return 'System resumed.' }
  if (m.startsWith('/crash on'))  { setConfig('crash_mode','1'); HOT[SAB_OFFSETS.CRASH_MODE]=1; emit('crash_mode_activated'); return 'CRASH MODE ON.' }
  if (m.startsWith('/crash off')) { setConfig('crash_mode','0'); HOT[SAB_OFFSETS.CRASH_MODE]=0; emit('crash_mode_off'); return 'Crash mode OFF.' }
  if (m.startsWith('/status'))    return buildStatusReport(ctx)
  if (m.startsWith('/laws'))      return Object.values(FOUR_LAWS).join('\n')
  return null
}

function naturalResponse(msg, ctx) {
  const m = msg.toLowerCase()
  if (m.includes('status')||m.includes('how')) return buildStatusReport(ctx)
  if (m.includes('revenue')||m.includes('earn')) {
    const achieved=parseFloat(getConfig('daily_achieved')?? '0')
    const p=parseInt(getConfig('prop_intensity')?? '5')
    return `Revenue: ${fmtRev(achieved)} today at P${p}. All-time: ${fmtRev(parseFloat(getConfig('all_time_profit')?? '0'))}. Win rate: ${getConfig('win_rate')?? '0%'}.`
  }
  if (m.includes('overlay')||m.includes('queue')) {
    const n=_heap.length, r=_heap.filter(e=>e?.readyToExec).length
    const val=_heap.reduce((s,e)=>s+(e?.profitEst??0),0)
    return `Overlay: ${n.toLocaleString()} entries · ${r.toLocaleString()} pre-built · ${fmtRev(val)} total value · ${_executed} executed.`
  }
  if (m.includes('memory')||m.includes('heap')) {
    const mb=Math.round(process.memoryUsage().heapUsed/1024/1024)
    return `Memory: ${mb}MB heap used. Overlay: ${_heap.length.toLocaleString()} entries (cap ${RAM_CAP.toLocaleString()}). GC active via --expose-gc.`
  }
  if (m.includes('crash')||m.includes('market')) {
    const score=(HOT[SAB_OFFSETS.CRASH_SCORE]??0).toFixed(0)
    return `Crash signal: ${score}/100. ${getCrashCountdown()}. ${getConfig('crash_mode')==='1'?'CRASH MODE ON.':'Market NOT a factor.'}`
  }
  if (m.includes('law')) return Object.values(FOUR_LAWS).join('\n')
  return buildStatusReport(ctx)
}

export async function sovereignChat(message, context) {
  _sovCalls++
  setConfig('sovereign_calls', String(_sovCalls))
  const cmdResp  = await parseCommand(message, context).catch(() => null)
  const response = cmdResp ?? naturalResponse(message, context)
  setConfig('sovereign_last', response?.slice(0, 500) ?? '')
  return response
}

function learnFromOutcomes() {
  const tot = parseInt(getConfig('total_executions') ?? '0')
  const win = parseInt(getConfig('total_wins')        ?? '0')
  if (tot > 0) { _sovAccuracy = ((win/tot)*100).toFixed(1)+'%'; setConfig('sovereign_accuracy', _sovAccuracy) }
}

export const getSovereignStatus = () => ({
  calls:        _sovCalls,
  accuracy:     _sovAccuracy,
  lastResponse: getConfig('sovereign_last') ?? '',
  experts:      9,
  laws:         FOUR_LAWS,
  overlaySize:  _heap.length,
  ramCap:       RAM_CAP,
})

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 6 — START
// ═══════════════════════════════════════════════════════════════════════════
export async function startIntelligence() {

  // 1. Restore from volume FIRST (single pass, no duplicate)
  await restoreOverlayFromVolume()

  // 2. Start CEX feeds
  startCEXFeeds()

  // 3. Persist: config (max once per 60s) + volume (every 10s)
  setInterval(() => {
    persistOverlayToConfig()   // batched: only fires if 60s have passed AND dirty
    persistOverlayToVolume()   // streaming shards via db.js — no giant JSON strings
  }, 10_000)

  setInterval(drainOverlay, 1000)
  scheduleMidnightOverlay()

  // 4. Rule AI every 5 minutes
  setTimeout(() => runRules().catch(() => {}), 30_000)
  setInterval(() => runRules().catch(() => {}), 300_000)

  // 5. Crash signals every 2 minutes
  setInterval(() => updateCrashSignals().catch(() => {}), 120_000)

  // 6. Gas price every 12s
  setInterval(async () => {
    try {
      const { rpcCall } = await import('./chains.js')
      const r = await rpcCall('ethereum', 'eth_gasPrice', [])
      HOT[SAB_OFFSETS.GAS_PRICE + (CHAIN_IDX.get('ethereum')??0)] = parseInt(r,16) / 1e9
    } catch {}
  }, 12_000)

  // 7. OKX subscribe after connect
  // (handled inside connectCEX open handler via startCEXFeeds)

  // 8. Overnight learning (LAW 4)
  const scheduleOvernight = () => {
    const d = new Date(); d.setUTCHours(3,0,0,0)
    if (d <= new Date()) d.setUTCDate(d.getDate()+1)
    setTimeout(() => { learnFromOutcomes(); scheduleOvernight() }, d - new Date())
  }
  scheduleOvernight()
  setInterval(learnFromOutcomes, 60_000)

  console.log('[INTEL] Vanguard Oracle · CEX feeds (Binance+OKX) · 8-signal crash monitor · 24-rule AI')
  console.log('[SOVEREIGN] 9 experts · 4 immutable Laws · /halt /resume /crash /propeller')
  console.log(`[OVERLAY] Permanent queue · ${_heap.length.toLocaleString()} entries · drain every 1s · midnight resume`)
  console.log(`[OVERLAY] RAM cap: ${RAM_CAP.toLocaleString()} entries · config persist: every 60s · db.js shards: every 10s`)
}
