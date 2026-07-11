// Vanguard · overlay.js — 500K queue, instant execution engine
// CRITICAL: every entry has PRE-BUILT calldata → replay = sign + submit only
// 120-SECOND TARGET: on deploy_success → drain all queued → execute all
// Priority: highest profit first (not FIFO)
// Persistence: survives Railway redeploys via /data/vanguard.db

import { getConfig, setConfig } from './db.js'
import { emit, on } from './events.js'

const MAX_ENTRIES  = 500000   // 500K entry capacity
const QUEUE_KEY    = 'overlay_v3'
const BATCH_DRAIN  = 200      // entries per drain cycle
const DRAIN_DELAY  = 100      // ms between batches (100ms × batches = ~10s for 100K)
const PERSIST_TICK = 10000    // persist every 10s

// ── Priority max-heap ─────────────────────────────────────────────────────────
class Heap {
  constructor() { this.h = []; this.n = 0 }

  push(item) {
    this.h.push(item); this.n++
    this._up(this.h.length - 1)
    // Evict lowest if over limit
    if (this.n > MAX_ENTRIES) {
      let mi = 0, mp = this.h[0]?.profitEst || 0
      // Scan 500 random entries for minimum (O(1) amortized)
      for (let i = 1; i < Math.min(this.h.length, 500); i++) {
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

  peek() { return this.h[0] || null }

  forChain(chain)    { return this.h.filter(e => e?.chain === chain && e.status === 'pending') }
  removeChain(chain) { this.h = this.h.filter(e => e?.chain !== chain); this.n = this.h.length }
  get size()         { return this.n }

  _up(i) {
    while (i > 0) {
      const p = (i-1) >> 1
      if ((this.h[p]?.profitEst||0) >= (this.h[i]?.profitEst||0)) break
      ;[this.h[p], this.h[i]] = [this.h[i], this.h[p]]
      i = p
    }
  }
  _down(i) {
    const n = this.h.length
    while (true) {
      let m = i, l = 2*i+1, r = 2*i+2
      if (l < n && (this.h[l]?.profitEst||0) > (this.h[m]?.profitEst||0)) m = l
      if (r < n && (this.h[r]?.profitEst||0) > (this.h[m]?.profitEst||0)) m = r
      if (m === i) break
      ;[this.h[m], this.h[i]] = [this.h[i], this.h[m]]
      i = m
    }
  }
}

const _queue = new Heap()

let _nextId       = 1
let _totalStored  = 0
let _totalExecuted= 0
let _totalReplayed= 0
let _dirty        = false
let _replayFn     = null  // set by rs1-mega-pools.js
let _draining     = false

// ── Restore from DB on boot ───────────────────────────────────────────────────
function restore() {
  try {
    _totalStored   = parseInt(getConfig('ovl_total_stored')   || '0')
    _totalExecuted = parseInt(getConfig('ovl_total_executed') || '0')
    _nextId        = parseInt(getConfig('ovl_next_id')        || '1')

    // Restore chain queues
    const chains = ['ethereum','arbitrum','base','polygon','optimism','avalanche','bnb',
                    'scroll','blast','linea','zksync','mantle','mode','metis','gnosis','fantom']
    let total = 0
    for (const chain of chains) {
      try {
        const raw = getConfig('ovl_chain_' + chain)
        if (!raw) continue
        const entries = JSON.parse(raw)
        for (const e of entries) {
          if (e && e.status === 'pending') { _queue.push(e); total++ }
        }
      } catch {}
    }
    if (total > 0) {
      console.log(`[OVERLAY] Restored ${total} pending swaps — ready to execute on deploy`)
      console.log(`[OVERLAY] Pre-built calldata: ${[...Array(total)].filter((_,i) => {
        const e = _queue.h[i]; return e?.readyToExec
      }).length} / ${total} ready for instant execution`)
    }
  } catch(e) {
    console.warn('[OVERLAY] Restore error:', e.message?.slice(0,60))
  }
}

function persist() {
  if (!_dirty) return
  _dirty = false
  try {
    // Group by chain for efficient storage
    const byChain = new Map()
    for (const e of _queue.h) {
      if (!e) continue
      const arr = byChain.get(e.chain) || []
      arr.push(e)
      byChain.set(e.chain, arr)
    }
    for (const [chain, entries] of byChain) {
      // Sort by profit desc, keep top 10K per chain
      const sorted = entries.sort((a,b) => (b.profitEst||0) - (a.profitEst||0)).slice(0, 10000)
      setConfig('ovl_chain_' + chain, JSON.stringify(sorted))
    }
    setConfig('ovl_total_stored',   String(_totalStored))
    setConfig('ovl_total_executed', String(_totalExecuted))
    setConfig('ovl_next_id',        String(_nextId))
  } catch {}
}

// ── Store — called on every qualifying swap ────────────────────────────────────
export function overlayStore(entry) {
  const e = {
    id:          _nextId++,
    chain:       entry.chain       || 'unknown',
    poolAddr:    entry.poolAddr    || '',
    flash:       entry.flash       || 0,
    profitEst:   entry.profitEst   || 0,
    calldata:    entry.calldata    || '',      // PRE-BUILT at detection
    flashWei:    entry.flashWei    || '0',
    minOut:      entry.minOut      || '0',
    swapUSD:     entry.swapUSD     || 0,
    readyToExec: !!entry.calldata,             // true = instant execution
    status:      'pending',
    ts:          Math.floor(Date.now() / 1000)
  }
  _queue.push(e)
  _totalStored++
  _dirty = true
  emit('overlay_stored', { id:e.id, chain:e.chain, profitEst:e.profitEst, readyToExec:e.readyToExec })
  return e.id
}

export function overlayMark(id, status, txHash) {
  for (const e of _queue.h) {
    if (e?.id === id) { e.status = status; if(txHash) e.txHash = txHash; break }
  }
  if (status === 'executed') _totalExecuted++
  _dirty = true
}

export function overlayPending(chain) {
  return (chain ? _queue.forChain(chain) : _queue.h.filter(e => e?.status==='pending'))
    .sort((a,b) => (b.profitEst||0) - (a.profitEst||0))
}

export function overlayClearChain(chain) {
  _queue.removeChain(chain)
  setConfig('ovl_chain_' + chain, '[]')
  _dirty = true
}

export const getOverlayStats = () => ({
  queueSize:     _queue.size,
  totalStored:   _totalStored,
  totalExecuted: _totalExecuted,
  totalReplayed: _totalReplayed,
  captureRate:   _totalStored ? ((_totalExecuted/_totalStored)*100).toFixed(1)+'%' : '0%',
  readyToExec:   _queue.h.filter(e => e?.readyToExec && e?.status==='pending').length,
  pendingByChain: (() => {
    const m = {}
    for (const e of _queue.h) {
      if (!e || e.status !== 'pending') continue
      m[e.chain] = (m[e.chain]||0)+1
    }
    return m
  })()
})

// ── Replay engine — 120-second execution target ───────────────────────────────
// Called immediately on deploy_success
// SPEED: pre-built calldata → only sign + submit → <2ms per tx
// 100K entries × 100ms stagger = 10,000 seconds → WRONG
// CORRECT: batch 200 per second → 100K / 200 = 500 seconds — still too slow
// SOLUTION: parallel execution per chain + 50ms stagger within chain
//           4 chains × 25K entries each × 50ms = 1,250s per chain
//           PARALLEL: 4 chains simultaneously = 1,250s / 4 = ~312s
// REAL CONSTRAINT: nonce must be sequential per chain
//   Nonce sequencing: 1 tx per block (2-12s blocks)
//   In 120s on Base (2s blocks) = 60 txs max per chain
//   On ARB (250ms blocks) = 480 txs in 120s
//   On ETH (12s blocks) = 10 txs in 120s
// CONCLUSION: 120s target on L2s (ARB/Base/POL) realistic
//   On ETH: 10-20 txs in 120s (but each is $50K+)
//   Priority: drain highest profit first → max revenue in 120s

export async function replayChain(chainName, executorFn) {
  const pending = overlayPending(chainName)
  if (!pending.length) return 0

  const readyNow = pending.filter(e => e.readyToExec)
  const notReady = pending.filter(e => !e.readyToExec)

  console.log(`[OVERLAY] Replay ${chainName}: ${pending.length} pending | ${readyNow.length} pre-built | ${notReady.length} need build`)

  let executed = 0, failed = 0
  const chain = (await import('./chainsaw.js')).getChain(chainName)

  for (const entry of pending) {
    try {
      // If calldata not pre-built, build it now (fallback)
      if (!entry.calldata && chain?.usdc && chain?.weth) {
        try {
          const { encodeFunctionData, parseAbi } = await import('viem')
          const ARB_ABI = parseAbi(['function dexArb(address,address,uint256,uint24,uint24,uint256) external'])
          entry.calldata = encodeFunctionData({
            abi: ARB_ABI, functionName: 'dexArb',
            args: [chain.usdc, chain.weth,
                   BigInt(Math.floor((entry.flash||0)*1e6)), 500, 3000,
                   BigInt(Math.floor((entry.profitEst||0)*0.3*1e6))]
          })
        } catch {}
      }

      if (!entry.calldata) { overlayMark(entry.id, 'skipped', null); failed++; continue }

      const txHash = await executorFn(entry)
      if (txHash) {
        overlayMark(entry.id, 'executed', txHash)
        executed++; _totalReplayed++
      } else {
        overlayMark(entry.id, 'failed', null); failed++
      }
    } catch(e) {
      overlayMark(entry.id, 'error', null); failed++
    }
    // Minimal stagger: 50ms (enough to avoid nonce collision on same chain)
    await new Promise(r => setTimeout(r, 50))
  }

  console.log(`[OVERLAY] ${chainName}: ${executed} executed, ${failed} failed (${pending.length} total)`)
  return executed
}

// ── Continuous drain — processes queue in background ──────────────────────────
export function setReplayExecutor(fn) { _replayFn = fn }

async function drainCycle() {
  if (_draining || !_replayFn) return
  const top = _queue.peek()
  if (!top || top.status !== 'pending') return

  _draining = true
  try {
    let count = 0
    while (count < BATCH_DRAIN) {
      const entry = _queue.peek()
      if (!entry || entry.status !== 'pending') break
      try {
        const txHash = await _replayFn(entry)
        if (txHash) { overlayMark(entry.id, 'executed', txHash); _totalReplayed++ }
        else          overlayMark(entry.id, 'skipped',  null)
      } catch { overlayMark(entry.id, 'error', null) }
      count++
      await new Promise(r => setTimeout(r, DRAIN_DELAY))
    }
  } finally { _draining = false }
}

// ── Events ─────────────────────────────────────────────────────────────────────
on('deploy_success', ({ chain }) => {
  const pending = overlayPending(chain)
  if (!pending.length) return
  console.log(`[OVERLAY] DEPLOY: ${chain} — executing ${pending.length} queued swaps NOW`)
  console.log(`[OVERLAY] ${pending.filter(e=>e.readyToExec).length} have pre-built calldata (instant)`)
  if (_replayFn) {
    // Execute with minimal delay — maximize revenue in 120s window
    setTimeout(() => replayChain(chain, _replayFn).catch(() => {}), 2000)
  }
})

// ── Start ──────────────────────────────────────────────────────────────────────
export function startOverlay() {
  restore()
  setInterval(persist,    PERSIST_TICK)
  setInterval(drainCycle, 2000)  // continuous background drain

  const stats = getOverlayStats()
  console.log(`[OVERLAY] Queue: ${stats.queueSize} pending | ${stats.readyToExec} pre-built (instant exec)`)
  console.log('[OVERLAY] 120s target: deploy_success → drain all queued → execute')
  console.log('[OVERLAY] Priority: highest profit first · pre-built calldata = sign+submit only')
      }
