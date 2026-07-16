// Vanguard · overlay.js — Permanent Sovereign Execution Queue
// Runs FOREVER — not just day 1. Pre-deploy AND post-deploy AND always.
// Pre-deploy:  stores 100K+ qualifying swaps with pre-built calldata
// On deploy:   drains entire queue via APEX (readyToExec = instant sign+submit)
// Post-deploy: EVERY new swap stored AND executed simultaneously
//              Failed executions retry 3× at 500ms intervals
//              Propeller ceiling hit → entries marked 'paused' → resume at midnight
//              100% of outcomes → SOVEREIGN learning feed
// Priority:    max-heap by profitEst (highest profit executed first)
// Capacity:    500K entries, rotating eviction of lowest-profit entries
// Persistence: survives Railway redeploys via SQLite /data/vanguard.db

import { getConfig, setConfig } from './db.js'
import { emit, on } from './events.js'

// ── Max-heap priority queue ───────────────────────────────────────────────────
class ProfitHeap {
  constructor() {
    this.h = []
    this.n = 0
  }

  push(item) {
    this.h.push(item)
    this.n++
    this._up(this.h.length - 1)
    // Evict lowest profit if over 500K cap
    if (this.n > 500000) {
      let mi = 0, mp = this.h[0]?.profitEst || 0
      const scan = Math.min(this.h.length, 512)
      for (let i = 1; i < scan; i++) {
        if ((this.h[i]?.profitEst || 0) < mp) { mp = this.h[i].profitEst; mi = i }
      }
      if ((this.h[mi]?.profitEst || 0) < (item.profitEst || 0)) {
        this.h.splice(mi, 1); this.n--
      }
    }
  }

  pop() {
    if (!this.h.length) return null
    const top  = this.h[0]
    const last = this.h.pop()
    this.n     = this.h.length
    if (this.h.length) { this.h[0] = last; this._down(0) }
    return top
  }

  peek()             { return this.h[0] || null }
  size()             { return this.n }
  forChain(chain)    { return this.h.filter(e => e?.chain === chain && e.status === 'pending') }
  forStatus(status)  { return this.h.filter(e => e?.status === status) }
  removeChain(chain) { this.h = this.h.filter(e => e?.chain !== chain); this.n = this.h.length }
  clearAll()         { this.h = []; this.n = 0 }

  _up(i) {
    while (i > 0) {
      const p = (i - 1) >> 1
      if ((this.h[p]?.profitEst || 0) >= (this.h[i]?.profitEst || 0)) break
      ;[this.h[p], this.h[i]] = [this.h[i], this.h[p]]; i = p
    }
  }

  _down(i) {
    const n = this.h.length
    while (true) {
      let m = i, l = 2*i+1, r = 2*i+2
      if (l < n && (this.h[l]?.profitEst||0) > (this.h[m]?.profitEst||0)) m = l
      if (r < n && (this.h[r]?.profitEst||0) > (this.h[m]?.profitEst||0)) m = r
      if (m === i) break
      ;[this.h[m], this.h[i]] = [this.h[i], this.h[m]]; i = m
    }
  }
}

// ── State ─────────────────────────────────────────────────────────────────────
const _queue        = new ProfitHeap()
let   _nextId       = 1
let   _totalStored  = 0
let   _totalExecuted= 0
let   _totalReplayed= 0
let   _totalExpired = 0
let   _totalRetried = 0
let   _dirty        = false
let   _replayFn     = null  // set by vanguard_vaults.js
let   _draining     = false
let   _deployed     = false  // flips on first deploy_success

const PERSIST_TICK   = 10000   // persist every 10s
const BATCH_DRAIN    = 200     // entries per drain cycle
const DRAIN_DELAY_MS = 50      // ms between drain batches (nonce safety)
const RETRY_ATTEMPTS = 3
const RETRY_DELAY_MS = 500

// ── Restore from DB on boot ───────────────────────────────────────────────────
function restore() {
  try {
    _totalStored   = parseInt(getConfig('ovl_total_stored')   || '0')
    _totalExecuted = parseInt(getConfig('ovl_total_executed') || '0')
    _totalReplayed = parseInt(getConfig('ovl_total_replayed') || '0')
    _nextId        = parseInt(getConfig('ovl_next_id')        || '1')

    const CHAIN_NAMES = [
      'ethereum','arbitrum','base','polygon','optimism',
      'avalanche','bnb','blast','linea','scroll',
      'zksync','gnosis','mantle','sonic','berachain',
      'sei','unichain','worldchain','metis','mode'
    ]

    let restored = 0
    for (const chain of CHAIN_NAMES) {
      try {
        const raw = getConfig('ovl_chain_' + chain)
        if (!raw) continue
        const entries = JSON.parse(raw)
        for (const e of entries) {
          if (e && e.status === 'pending') {
            _queue.push(e)
            restored++
          }
        }
      } catch {}
    }

    if (restored > 0) {
      const ready = _queue.h.filter(e => e?.readyToExec).length
      console.log(`[OVERLAY] Restored ${restored} pending entries`)
      console.log(`[OVERLAY] Pre-built calldata: ${ready}/${restored} ready for instant execution`)
      console.log(`[OVERLAY] Total overlay value: $${(_estimateQueueValue()/1e9).toFixed(2)}B`)
    }
  } catch(e) {
    console.warn('[OVERLAY] Restore error:', e.message?.slice(0,60))
  }
}

function _estimateQueueValue() {
  return _queue.h.filter(e=>e?.profitEst>0).reduce((s,e)=>s+(e.profitEst||0),0)
}

function persist() {
  if (!_dirty) return
  _dirty = false
  try {
    const byChain = new Map()
    for (const e of _queue.h) {
      if (!e) continue
      const arr = byChain.get(e.chain) || []
      arr.push(e)
      byChain.set(e.chain, arr)
    }
    for (const [chain, entries] of byChain) {
      const sorted = entries
        .filter(e => e.status === 'pending' || e.status === 'paused')
        .sort((a,b) => (b.profitEst||0) - (a.profitEst||0))
        .slice(0, 10000)
      setConfig('ovl_chain_' + chain, JSON.stringify(sorted))
    }
    setConfig('ovl_total_stored',   String(_totalStored))
    setConfig('ovl_total_executed', String(_totalExecuted))
    setConfig('ovl_total_replayed', String(_totalReplayed))
    setConfig('ovl_next_id',        String(_nextId))
  } catch {}
}

// ── Store — called on every qualifying swap ────────────────────────────────────
// Pre-deploy: ALL swaps stored (builds the 100K pre-load queue)
// Post-deploy: stored AND NEXUS routes simultaneously
export function overlayStore(entry) {
  const e = {
    id:          _nextId++,
    chain:       entry.chain       || 'unknown',
    poolAddr:    entry.poolAddr    || '',
    flash:       entry.flash       || 0,
    profitEst:   entry.profitEst   || 0,
    calldata:    entry.calldata    || '',
    flashWei:    entry.flashWei    || '0',
    minOut:      entry.minOut      || '0',
    swapUSD:     entry.swapUSD     || 0,
    readyToExec: !!entry.calldata,   // true = instant execution (sign+submit only)
    status:      'pending',
    retries:     0,
    ts:          Math.floor(Date.now() / 1000),
    // Expiry: 50 blocks after detection
    // ETH: ~10min · ARB: ~12s · BASE: ~100s
    expiresAt:   Math.floor(Date.now()/1000) + (
      entry.chain === 'ethereum'  ? 600  :
      entry.chain === 'arbitrum'  ? 12   :
      entry.chain === 'base'      ? 100  : 30
    ),
  }

  _queue.push(e)
  _totalStored++
  _dirty = true

  // Post-deploy: if already live, try to execute immediately
  // (overlay acts as guaranteed backup — NEXUS already tried, this is the catch)
  if (_deployed && _replayFn) {
    setImmediate(() => attemptExecution(e).catch(() => {}))
  }

  emit('overlay_stored', {
    id:          e.id,
    chain:       e.chain,
    profitEst:   e.profitEst,
    readyToExec: e.readyToExec,
    queueSize:   _queue.size(),
  })

  return e.id
}

// ── Mark entry result ─────────────────────────────────────────────────────────
export function overlayMark(id, status, txHash) {
  for (const e of _queue.h) {
    if (!e || e.id !== id) continue
    e.status = status
    if (txHash) e.txHash = txHash
    if (status === 'executed' || status === 'replayed') _totalExecuted++
    break
  }
  _dirty = true

  // Feed outcome to SOVEREIGN for learning
  emit('overlay_outcome', { id, status, txHash })
}

// ── Attempt execution with retry ──────────────────────────────────────────────
async function attemptExecution(entry, attempt=1) {
  if (!_replayFn) return false
  if (!entry || entry.status !== 'pending') return false

  // Check expiry
  if (entry.expiresAt && Math.floor(Date.now()/1000) > entry.expiresAt) {
    overlayMark(entry.id, 'expired', null)
    _totalExpired++
    emit('overlay_expired', { id:entry.id, chain:entry.chain })
    return false
  }

  // Check propeller ceiling
  const achieved = parseFloat(getConfig('daily_achieved') || '0')
  const target   = parseFloat(getConfig('prop_daily_target') || '0')
  if (target > 0 && achieved >= target) {
    entry.status = 'paused'  // resume at midnight
    _dirty = true
    return false
  }

  try {
    const txHash = await _replayFn(entry)
    if (txHash) {
      overlayMark(entry.id, 'executed', txHash)
      emit('overlay_executed', { id:entry.id, chain:entry.chain, profit:entry.profitEst, txHash })
      return true
    } else {
      throw new Error('No txHash returned')
    }
  } catch(e) {
    if (attempt < RETRY_ATTEMPTS) {
      _totalRetried++
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt))
      return attemptExecution(entry, attempt + 1)
    }
    overlayMark(entry.id, 'failed', null)
    emit('overlay_failed', { id:entry.id, chain:entry.chain, reason:e.message?.slice(0,60) })
    return false
  }
}

// ── Pending + paused accessors ────────────────────────────────────────────────
export function overlayPending(chain) {
  const entries = chain ? _queue.forChain(chain) : _queue.forStatus('pending')
  return entries.sort((a,b) => (b.profitEst||0) - (a.profitEst||0))
}

export function overlayClearChain(chain) {
  _queue.removeChain(chain)
  setConfig('ovl_chain_' + chain, '[]')
  _dirty = true
}

export function clearAll() {
  _queue.clearAll()
  _dirty = true
  console.log('[OVERLAY] Queue cleared')
}

// ── Replay entire chain queue ─────────────────────────────────────────────────
// Called on deploy_success for each chain
// readyToExec entries = 0.8ms each (sign + submit only, calldata pre-built)
// Not-ready entries = build calldata first (5ms), then sign + submit
export async function replayChain(chainName, executorFn) {
  const fn      = executorFn || _replayFn
  if (!fn) return 0
  const pending = overlayPending(chainName)
  if (!pending.length) {
    console.log(`[OVERLAY] ${chainName}: no queued swaps`)
    return 0
  }

  const ready    = pending.filter(e => e.readyToExec).length
  const notReady = pending.length - ready
  console.log(`[OVERLAY] ${chainName}: ${pending.length} pending | ${ready} pre-built (instant) | ${notReady} need build`)

  let executed = 0, failed = 0, skipped = 0

  for (const entry of pending) {
    // Check if entry expired
    if (entry.expiresAt && Math.floor(Date.now()/1000) > entry.expiresAt) {
      overlayMark(entry.id, 'expired', null)
      _totalExpired++
      skipped++
      continue
    }

    // Build calldata if not pre-built
    if (!entry.calldata || entry.calldata === '0x' || entry.calldata === '') {
      try {
        const { encodeFunctionData, parseAbi } = await import('viem')
        const { getChain } = await import('./chains1.js')
        const chain = getChain(chainName)
        if (chain?.usdc && chain?.weth) {
          const ARB_ABI = parseAbi(['function dexArb(address,address,uint256,uint24,uint24,uint256) external'])
          entry.calldata = encodeFunctionData({
            abi: ARB_ABI, functionName: 'dexArb',
            args: [
              chain.usdc, chain.weth,
              BigInt(Math.floor((entry.flash||0)*1e6)),
              500, 3000,
              BigInt(Math.floor((entry.profitEst||0)*0.3*1e6))
            ]
          })
          entry.readyToExec = true
        }
      } catch {}
    }

    if (!entry.calldata) { skipped++; continue }

    try {
      const txHash = await fn(entry)
      if (txHash) {
        overlayMark(entry.id, 'replayed', txHash)
        _totalReplayed++
        executed++
      } else {
        overlayMark(entry.id, 'failed', null)
        failed++
      }
    } catch(e) {
      overlayMark(entry.id, 'error', null)
      failed++
    }

    // 50ms stagger per chain (nonce safety within same chain)
    await new Promise(r => setTimeout(r, DRAIN_DELAY_MS))
  }

  console.log(`[OVERLAY] ${chainName}: ${executed} executed · ${failed} failed · ${skipped} skipped`)
  return executed
}

// ── Continuous drain — post-deploy permanent operation ────────────────────────
// Processes remaining queue in background after deploy drain completes
// Runs forever. Catches any missed executions. Propeller-ceiling aware.
async function drainCycle() {
  if (_draining || !_replayFn || !_deployed) return

  const top = _queue.peek()
  if (!top || (top.status !== 'pending')) return

  _draining = true
  let count = 0

  try {
    while (count < BATCH_DRAIN) {
      // Find next pending (top of heap)
      let entry = _queue.peek()
      if (!entry || entry.status !== 'pending') break

      // Check propeller ceiling
      const achieved = parseFloat(getConfig('daily_achieved') || '0')
      const target   = parseFloat(getConfig('prop_daily_target') || '0')
      if (target > 0 && achieved >= target) break  // ceiling hit — stop draining

      const success = await attemptExecution(entry)
      if (!success && entry.status === 'pending') {
        // Entry failed permanently — skip
        entry.status = 'error'
        _dirty = true
      }
      count++

      await new Promise(r => setTimeout(r, DRAIN_DELAY_MS))
    }
  } finally {
    _draining = false
  }
}

// ── UTC midnight reset — resumes paused entries ───────────────────────────────
function scheduleMidnightResume() {
  const now  = new Date()
  const next = new Date(now)
  next.setUTCHours(24, 0, 0, 0)
  setTimeout(() => {
    let resumed = 0
    for (const e of _queue.h) {
      if (e?.status === 'paused') { e.status = 'pending'; resumed++ }
    }
    if (resumed > 0) {
      console.log(`[OVERLAY] UTC midnight: ${resumed} paused entries resumed`)
      _dirty = true
    }
    scheduleMidnightResume()
  }, next - now)
}

// ── Stats ─────────────────────────────────────────────────────────────────────
export function getOverlayStats() {
  const pending = _queue.forStatus('pending')
  const paused  = _queue.forStatus('paused')

  const pendingByChain = {}
  for (const e of [...pending, ...paused]) {
    if (!e?.chain) continue
    pendingByChain[e.chain] = (pendingByChain[e.chain] || 0) + 1
  }

  const readyCount = _queue.h.filter(e => e?.readyToExec && e?.status === 'pending').length

  return {
    queueSize:      _queue.size(),
    pending:        pending.length,
    paused:         paused.length,
    totalStored:    _totalStored,
    totalExecuted:  _totalExecuted,
    totalReplayed:  _totalReplayed,
    totalExpired:   _totalExpired,
    totalRetried:   _totalRetried,
    readyToExec:    readyCount,
    captureRate:    _totalStored > 0
      ? ((_totalExecuted / _totalStored) * 100).toFixed(1) + '%'
      : '0%',
    queueValueEst:  _estimateQueueValue(),
    pendingByChain,
    deployed:       _deployed,
    drainActive:    _draining,
  }
}

// ── Set replay executor (called by vanguard_vaults.js) ─────────────────────
export function setReplayExecutor(fn) {
  _replayFn = fn
  console.log('[OVERLAY] Replay executor registered')
}

// ── Events ────────────────────────────────────────────────────────────────────
on('deploy_success', ({ chain }) => {
  _deployed = true
  const pending = overlayPending(chain)
  if (!pending.length) return

  console.log(`[OVERLAY] DEPLOY: ${chain} — ${pending.length} queued swaps ready`)
  console.log(`[OVERLAY] Pre-built: ${pending.filter(e=>e.readyToExec).length} (instant) | needs build: ${pending.filter(e=>!e.readyToExec).length}`)

  // Fire replay immediately — 120-second execution window starts now
  if (_replayFn) {
    setTimeout(() => replayChain(chain, _replayFn).catch(() => {}), 1000)
  }
})

on('system_halt', () => {
  _draining = false
  console.log('[OVERLAY] Drain paused — system halted')
})

on('system_resume', () => {
  _deployed = true
  console.log('[OVERLAY] Drain resumed — system active')
})

// ── Start ─────────────────────────────────────────────────────────────────────
export function startOverlay() {
  restore()

  setInterval(persist,    PERSIST_TICK)
  setInterval(drainCycle, 1000)   // continuous drain every 1s post-deploy
  scheduleMidnightResume()

  const stats = getOverlayStats()
  console.log(`[OVERLAY] Permanent queue active — ${stats.queueSize} entries restored`)
  console.log(`[OVERLAY] Ready to execute: ${stats.readyToExec} (pre-built calldata)`)
  console.log(`[OVERLAY] 120s window: deploy_success → drain all → revenue flows`)
  console.log('[OVERLAY] Runs FOREVER: pre-deploy + post-deploy + retry + midnight reset')

  // Stats every 5min
  setInterval(() => {
    const s = getOverlayStats()
    setConfig('overlay_stats', JSON.stringify(s))
    if (s.queueSize > 0) {
      console.log(`[OVERLAY] ${s.pending} pending · ${s.paused} paused · capture: ${s.captureRate}`)
    }
  }, 300000)
}
