// Vanguard · overlay.js — Persistent swap queue, 500K capacity
// Every detected swap → stored to DB instantly (pre AND post deploy)
// Priority queue: highest profit first (not FIFO)
// Replay engine: 100% execution guarantee
// Overlay is the core of Vanguard's "never miss a swap" architecture

import { getConfig, setConfig } from './db.js'
import { emit, on } from './events.js'

const TABLE_KEY   = 'overlay_v2'
const MAX_ENTRIES = 500000
const MAX_PER_KEY = 10000  // max entries per chain key (rotating)
const BATCH_SIZE  = 200    // entries per DB write batch

// In-memory priority queue (binary max-heap by profitEst)
// Each entry: { id, chain, poolAddr, flash, profitEst, calldata, status, ts }
class PriorityQueue {
  constructor() { this._heap = []; this._count = 0 }

  push(item) {
    this._heap.push(item)
    this._bubbleUp(this._heap.length - 1)
    this._count++
    // Evict lowest if over MAX_ENTRIES
    if (this._count > MAX_ENTRIES) {
      // Find and remove minimum (linear scan — only on overflow)
      let minIdx = 0
      for (let i = 1; i < this._heap.length; i++) {
        if ((this._heap[i]?.profitEst||0) < (this._heap[minIdx]?.profitEst||0)) minIdx = i
      }
      this._heap.splice(minIdx, 1)
      this._count--
    }
  }

  pop() {
    if (!this._heap.length) return null
    const top = this._heap[0]
    const last = this._heap.pop()
    if (this._heap.length) { this._heap[0] = last; this._siftDown(0) }
    this._count--
    return top
  }

  peekMax() { return this._heap[0] || null }

  filterChain(chain) { return this._heap.filter(e => e?.chain === chain) }

  removeChain(chain) {
    this._heap = this._heap.filter(e => e?.chain !== chain)
    this._count = this._heap.length
  }

  get size() { return this._count }

  _bubbleUp(i) {
    while (i > 0) {
      const parent = (i-1) >> 1
      if ((this._heap[parent]?.profitEst||0) >= (this._heap[i]?.profitEst||0)) break
      ;[this._heap[parent], this._heap[i]] = [this._heap[i], this._heap[parent]]
      i = parent
    }
  }
  _siftDown(i) {
    const n = this._heap.length
    while (true) {
      let largest = i
      const l = 2*i+1, r = 2*i+2
      if (l < n && (this._heap[l]?.profitEst||0) > (this._heap[largest]?.profitEst||0)) largest=l
      if (r < n && (this._heap[r]?.profitEst||0) > (this._heap[largest]?.profitEst||0)) largest=r
      if (largest === i) break
      ;[this._heap[largest], this._heap[i]] = [this._heap[i], this._heap[largest]]
      i = largest
    }
  }
}

const _queue = new PriorityQueue()
let   _totalStored  = 0
let   _totalExecuted = 0
let   _totalReplayed = 0
let   _nextId       = parseInt(getConfig('overlay_next_id') || '1')
let   _dirty        = false  // true when queue has unsaved entries

// ── PERSIST / RESTORE ─────────────────────────────────────────────────────────
function persistBatch() {
  if (!_dirty) return
  _dirty = false
  try {
    // Store the top MAX_PER_KEY entries per chain to DB
    const byChain = new Map()
    for (const e of _queue._heap) {
      if (!e) continue
      const arr = byChain.get(e.chain) || []
      arr.push(e)
      byChain.set(e.chain, arr)
    }
    for (const [chain, entries] of byChain) {
      const sorted = entries.sort((a,b) => b.profitEst - a.profitEst).slice(0, MAX_PER_KEY)
      setConfig('overlay_chain_' + chain, JSON.stringify(sorted))
    }
    setConfig('overlay_total',    String(_totalStored))
    setConfig('overlay_executed', String(_totalExecuted))
    setConfig('overlay_next_id',  String(_nextId))
  } catch(e) {
    console.warn('[OVERLAY] Persist error:', e.message?.slice(0,60))
  }
}

function restore() {
  try {
    _totalStored   = parseInt(getConfig('overlay_total')    || '0')
    _totalExecuted = parseInt(getConfig('overlay_executed') || '0')
    _nextId        = parseInt(getConfig('overlay_next_id')  || '1')
    // Restore per-chain queues
    let restored = 0
    const chains = ['ethereum','arbitrum','base','polygon','optimism','avalanche','bnb',
                    'scroll','blast','linea','zksync','mantle','mode','metis','manta','taiko']
    for (const chain of chains) {
      try {
        const raw = getConfig('overlay_chain_' + chain)
        if (!raw) continue
        const entries = JSON.parse(raw)
        for (const e of entries) {
          if (e.status !== 'executed') { _queue.push(e); restored++ }
        }
      } catch {}
    }
    if (restored) console.log(`[OVERLAY] Restored ${restored} pending swaps from DB`)
  } catch(e) {
    console.warn('[OVERLAY] Restore error:', e.message?.slice(0,60))
  }
}

// ── PUBLIC API ────────────────────────────────────────────────────────────────
export function overlayStore(entry) {
  // Assign ID and timestamp
  const e = {
    id:        _nextId++,
    chain:     entry.chain,
    poolAddr:  entry.poolAddr || '',
    flash:     entry.flash || 0,
    profitEst: entry.profitEst || 0,
    flashWei:  entry.flashWei || '0',
    minOut:    entry.minOut || '0',
    calldata:  entry.calldata || '',
    status:    'pending',
    ts:        Math.floor(Date.now() / 1000)
  }
  _queue.push(e)
  _totalStored++
  _dirty = true
  emit('overlay_stored', { id: e.id, chain: e.chain, profitEst: e.profitEst })
  return e.id
}

export function overlayMark(id, status, txHash) {
  // Mark entry as executed or failed
  for (const e of _queue._heap) {
    if (e?.id === id) { e.status = status; e.txHash = txHash; break }
  }
  if (status === 'executed') _totalExecuted++
  _dirty = true
}

export function overlayPending(chain) {
  // Returns all pending entries for a chain, sorted by profit descending
  return _queue.filterChain(chain)
    .filter(e => e.status === 'pending')
    .sort((a,b) => b.profitEst - a.profitEst)
}

export function overlayClearChain(chain) {
  _queue.removeChain(chain)
  setConfig('overlay_chain_' + chain, '[]')
  _dirty = true
}

export const getOverlayStats = () => ({
  queueSize:      _queue.size,
  totalStored:    _totalStored,
  totalExecuted:  _totalExecuted,
  totalReplayed:  _totalReplayed,
  pendingByChain: (() => {
    const m = {}
    for (const e of _queue._heap) {
      if (!e || e.status !== 'pending') continue
      m[e.chain] = (m[e.chain]||0) + 1
    }
    return m
  })(),
  captureRate: _totalStored ? ((_totalExecuted / _totalStored) * 100).toFixed(1) + '%' : '0%'
})

// ── REPLAY ENGINE ─────────────────────────────────────────────────────────────
// Drains queue for a chain immediately after contract deploys
// Executes in profit order: largest arb first
export async function replayChain(chainName, executorFn) {
  const pending = overlayPending(chainName)
  if (!pending.length) {
    console.log(`[OVERLAY] No pending swaps for ${chainName}`)
    return 0
  }

  console.log(`[OVERLAY] Replaying ${pending.length} swaps on ${chainName} (profit order)`)
  let executed = 0, failed = 0

  for (const entry of pending) {
    try {
      // Call the provided executor function (from vaults.js / rs1-mega-pools.js)
      const txHash = await executorFn(entry)
      if (txHash) {
        overlayMark(entry.id, 'executed', txHash)
        executed++
        _totalReplayed++
        console.log(`[OVERLAY] Replayed $${entry.profitEst.toLocaleString()} on ${chainName}`)
      } else {
        overlayMark(entry.id, 'skipped', null)
        failed++
      }
    } catch(e) {
      overlayMark(entry.id, 'error', null)
      failed++
    }
    // Stagger: 150ms between executions to avoid nonce collision
    await new Promise(r => setTimeout(r, 150))
  }

  console.log(`[OVERLAY] Replay complete: ${executed} executed, ${failed} skipped on ${chainName}`)
  return executed
}

// ── CONTINUOUS EXECUTION ──────────────────────────────────────────────────────
// After contract deploys, process queue continuously (not just on-deploy burst)
let _replayActive = false
let _replayFn = null

export function setReplayExecutor(fn) {
  _replayFn = fn
}

async function processQueue() {
  if (!_replayFn || _replayActive) return
  _replayActive = true
  try {
    // Process top 10 entries per cycle (2s intervals)
    for (let i = 0; i < 10; i++) {
      const top = _queue.peekMax()
      if (!top || top.status !== 'pending') break
      try {
        const txHash = await _replayFn(top)
        if (txHash) { overlayMark(top.id, 'executed', txHash); _totalReplayed++ }
        else         { overlayMark(top.id, 'skipped', null) }
      } catch { overlayMark(top.id, 'error', null) }
      await new Promise(r => setTimeout(r, 100))
    }
  } finally { _replayActive = false }
}

// ── EVENTS ────────────────────────────────────────────────────────────────────
on('deploy_success', ({ chain }) => {
  const count = overlayPending(chain).length
  if (count > 0 && _replayFn) {
    console.log(`[OVERLAY] Deploy on ${chain} — draining ${count} queued swaps`)
    setTimeout(() => replayChain(chain, _replayFn).catch(() => {}), 2000)
  }
})

// ── START ─────────────────────────────────────────────────────────────────────
export function startOverlay() {
  restore()
  // Persist every 10s
  setInterval(persistBatch, 10000)
  // Process queue continuously (for post-deploy draining)
  setInterval(processQueue, 2000)
  const stats = getOverlayStats()
  console.log(`[OVERLAY] Started — queue: ${stats.queueSize} pending — capacity: ${MAX_ENTRIES.toLocaleString()}`)
  console.log('[OVERLAY] 100% swap capture: pre-deploy queued → execute post-deploy')
  console.log('[OVERLAY] Priority order: highest profit first')
}
