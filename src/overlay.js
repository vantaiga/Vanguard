// Vanguard · overlay.js
// Permanent Sovereign Execution Queue — runs FOREVER
// Pre-deploy: stores 100K+ qualifying swaps with pre-built calldata
// Post-deploy: drains at 66.67 txs/sec, retries failures, midnight resume
// Static imports: ONLY db.js · events.js

import { getConfig, setConfig } from './db.js'
import { emit, on }             from './events.js'

// ── Max-heap priority queue by profitEst ──────────────────────────────────────
const _heap    = []
const _heapMap = new Map()  // id → heap index
let   _nextId  = parseInt(getConfig('ovl_next_id') || '1')

function heapPush(entry) {
  _heap.push(entry)
  _heapMap.set(entry.id, _heap.length - 1)
  _bubbleUp(_heap.length - 1)
}

function heapPop() {
  if (!_heap.length) return null
  const top  = _heap[0]
  const last = _heap.pop()
  _heapMap.delete(top.id)
  if (_heap.length) { _heap[0] = last; _heapMap.set(last.id, 0); _siftDown(0) }
  return top
}

function _bubbleUp(i) {
  while (i > 0) {
    const p = (i-1)>>1
    if ((_heap[p]?.profitEst||0) >= (_heap[i]?.profitEst||0)) break
    ;[_heap[p], _heap[i]] = [_heap[i], _heap[p]]
    _heapMap.set(_heap[p].id, p); _heapMap.set(_heap[i].id, i)
    i = p
  }
}

function _siftDown(i) {
  const n = _heap.length
  while (true) {
    let m = i, l = 2*i+1, r = 2*i+2
    if (l<n && (_heap[l]?.profitEst||0)>(_heap[m]?.profitEst||0)) m=l
    if (r<n && (_heap[r]?.profitEst||0)>(_heap[m]?.profitEst||0)) m=r
    if (m===i) break
    ;[_heap[m], _heap[i]] = [_heap[i], _heap[m]]
    _heapMap.set(_heap[m].id, m); _heapMap.set(_heap[i].id, i)
    i = m
  }
}

// ── Counters ──────────────────────────────────────────────────────────────────
let _totalStored   = parseInt(getConfig('ovl_total_stored')   || '0')
let _totalExecuted = parseInt(getConfig('ovl_total_executed') || '0')
let _totalExpired  = 0
let _totalRetried  = 0
let _deployed      = false
let _draining      = false
let _replayFn      = null
let _dirty         = false

// ── Restore from DB on boot ───────────────────────────────────────────────────
function restore() {
  const CHAINS = ['ethereum','arbitrum','base','polygon','optimism','avalanche','bnb','blast','linea','scroll','zksync','gnosis','mantle','sonic','berachain','sei','unichain','worldchain']
  let n = 0
  for (const chain of CHAINS) {
    try {
      const raw = getConfig('ovl_chain_'+chain)
      if (!raw) continue
      const entries = JSON.parse(raw)
      for (const e of entries) {
        if (e?.status === 'pending' || e?.status === 'paused') {
          _heap.push(e); _heapMap.set(e.id, _heap.length-1); n++
        }
      }
    } catch {}
  }
  if (n > 0) {
    // Re-heapify after bulk insert
    for (let i = Math.floor(_heap.length/2)-1; i >= 0; i--) _siftDown(i)
    const ready = _heap.filter(e=>e?.readyToExec).length
    console.log(`[OVERLAY] Restored ${n} entries — ${ready} pre-built (instant exec)`)
    const val = _heap.reduce((s,e)=>s+(e?.profitEst||0),0)
    if (val > 0) console.log(`[OVERLAY] Pre-loaded value: ${val>=1e9?'$'+(val/1e9).toFixed(2)+'B':'$'+(val/1e6).toFixed(0)+'M'}`)
  }
}

// ── Persist ───────────────────────────────────────────────────────────────────
function persist() {
  if (!_dirty) return
  _dirty = false
  try {
    const byChain = {}
    for (const e of _heap) {
      if (!e) continue
      if (!byChain[e.chain]) byChain[e.chain] = []
      byChain[e.chain].push(e)
    }
    for (const [chain, entries] of Object.entries(byChain)) {
      const top = entries.filter(e=>e.status==='pending'||e.status==='paused')
        .sort((a,b)=>(b.profitEst||0)-(a.profitEst||0)).slice(0,10000)
      setConfig('ovl_chain_'+chain, JSON.stringify(top))
    }
    setConfig('ovl_total_stored',   String(_totalStored))
    setConfig('ovl_total_executed', String(_totalExecuted))
    setConfig('ovl_next_id',        String(_nextId))
    setConfig('overlay_queue_size', String(_heap.length))
  } catch {}
}

// ── Store — called on every qualifying swap ───────────────────────────────────
export function overlayStore(entry) {
  const chainId = entry.chain === 'ethereum' ? 1
                : entry.chain === 'arbitrum'  ? 42161
                : entry.chain === 'base'      ? 8453
                : entry.chain === 'polygon'   ? 137  : 1

  const e = {
    id:          _nextId++,
    chain:       entry.chain    || 'unknown',
    poolAddr:    entry.poolAddr || '',
    flash:       entry.flash    || 0,
    profitEst:   entry.profitEst|| 0,
    calldata:    entry.calldata || '',
    flashWei:    entry.flashWei || '0',
    minOut:      entry.minOut   || '0',
    swapUSD:     entry.swapUSD  || 0,
    chainId,
    readyToExec: !!(entry.calldata && entry.calldata !== '0x'),
    status:      'pending',
    retries:     0,
    ts:          Math.floor(Date.now()/1000),
    expiresAt:   Math.floor(Date.now()/1000) + (
      entry.chain === 'ethereum' ? 600
    : entry.chain === 'arbitrum' ? 12
    : entry.chain === 'base'     ? 100 : 30
    ),
  }

  // Cap at 500K entries — evict lowest profit
  if (_heap.length >= 500000) {
    let minP = Infinity, minI = 0
    const scan = Math.min(_heap.length, 256)
    for (let i = 0; i < scan; i++) {
      if ((_heap[i]?.profitEst||0) < minP) { minP=_heap[i].profitEst; minI=i }
    }
    if (minP >= (e.profitEst||0)) return e.id
    _heap.splice(minI, 1)
    for (let i = Math.floor(_heap.length/2)-1; i>=0; i--) _siftDown(i)
  }

  heapPush(e)
  _totalStored++
  _dirty = true

  setConfig('overlay_queue_size', String(_heap.length))

  emit('overlay_stored', { id:e.id, chain:e.chain, profitEst:e.profitEst, readyToExec:e.readyToExec, queueSize:_heap.length })

  // Post-deploy: try immediate execution
  if (_deployed && _replayFn) {
    setImmediate(() => attemptExec(e).catch(()=>{}))
  }

  return e.id
}

// ── Mark result ───────────────────────────────────────────────────────────────
export function overlayMark(id, status, txHash) {
  for (const e of _heap) {
    if (!e || e.id !== id) continue
    e.status = status
    if (txHash) e.txHash = txHash
    if (status === 'executed' || status === 'replayed') _totalExecuted++
    break
  }
  _dirty = true
  emit('overlay_outcome', { id, status, txHash })
}

// ── Attempt execution with retry ──────────────────────────────────────────────
async function attemptExec(entry, attempt=1) {
  if (!_replayFn || !entry || entry.status !== 'pending') return false
  // Check expiry
  if (entry.expiresAt && Math.floor(Date.now()/1000) > entry.expiresAt) {
    overlayMark(entry.id, 'expired', null)
    _totalExpired++
    return false
  }
  // Check propeller ceiling
  const achieved = parseFloat(getConfig('daily_achieved') || '0')
  const target   = parseFloat(getConfig('prop_daily_target') || '0')
  if (target > 0 && achieved >= target) { entry.status = 'paused'; _dirty = true; return false }

  try {
    const txHash = await _replayFn(entry)
    if (txHash) { overlayMark(entry.id, 'executed', txHash); emit('overlay_executed', { id:entry.id, chain:entry.chain, profit:entry.profitEst, txHash }); return true }
    throw new Error('no txHash')
  } catch {
    if (attempt < 3) {
      _totalRetried++
      await new Promise(r=>setTimeout(r, 500*attempt))
      return attemptExec(entry, attempt+1)
    }
    overlayMark(entry.id, 'failed', null)
    emit('overlay_failed', { id:entry.id, chain:entry.chain })
    return false
  }
}

// ── Accessors ─────────────────────────────────────────────────────────────────
export function overlayPending(chain) {
  return _heap.filter(e=>e&&e.status==='pending'&&(!chain||e.chain===chain))
    .sort((a,b)=>(b.profitEst||0)-(a.profitEst||0))
}

export function setReplayExecutor(fn) { _replayFn = fn }

export function clearAll() {
  _heap.length = 0
  _heapMap.clear()
  _dirty = true
  setConfig('overlay_queue_size', '0')
  console.log('[OVERLAY] Queue cleared')
}

// ── Replay chain queue ────────────────────────────────────────────────────────
export async function replayChain(chainName, executorFn) {
  const fn      = executorFn || _replayFn
  if (!fn) return 0
  const pending = overlayPending(chainName)
  if (!pending.length) return 0

  console.log(`[OVERLAY] ${chainName}: draining ${pending.length} entries`)
  let executed = 0, failed = 0, skipped = 0

  for (const entry of pending) {
    if (!entry.calldata || entry.calldata === '0x') {
      // Build calldata on the fly
      try {
        const { getChain } = await import('./chains1.js')
        const { buildTemplate, fillTemplate, CALLDATA_POOL } = await import('./apex.js')
        const c = getChain(chainName)
        if (c?.usdc && c?.weth) {
          const key = buildTemplate(c.usdc, c.weth, 500, 3000, getConfig('contract_addr_'+chainName)||'0x0')
          const buf = fillTemplate(key, BigInt(Math.floor((entry.flash||0)*1e6)), BigInt(Math.floor((entry.profitEst||0)*0.3*1e6)))
          if (buf) { entry.calldata = '0x'+buf.slice(0,196).toString('hex'); entry.readyToExec = true; CALLDATA_POOL?.put?.(buf) }
        }
      } catch {}
    }

    if (!entry.calldata) { skipped++; continue }
    if (entry.expiresAt && Math.floor(Date.now()/1000) > entry.expiresAt) { overlayMark(entry.id,'expired',null); skipped++; continue }

    try {
      const txHash = await fn(entry)
      if (txHash) { overlayMark(entry.id,'replayed',txHash); executed++ }
      else { overlayMark(entry.id,'failed',null); failed++ }
    } catch { overlayMark(entry.id,'error',null); failed++ }

    // 50ms stagger per chain (nonce safety), parallel across chains
    await new Promise(r=>setTimeout(r,50))
  }

  console.log(`[OVERLAY] ${chainName}: ${executed} executed · ${failed} failed · ${skipped} skipped`)
  return executed
}

// ── Continuous drain (post-deploy permanent) ──────────────────────────────────
async function drain() {
  if (_draining || !_replayFn || !_deployed) return
  _draining = true
  try {
    const top = _heap[0]
    if (!top || top.status !== 'pending') return
    // Ceiling check
    const achieved = parseFloat(getConfig('daily_achieved')||'0')
    const target   = parseFloat(getConfig('prop_daily_target')||'0')
    if (target > 0 && achieved >= target) return
    await attemptExec(top)
  } finally { _draining = false }
}

// ── Midnight resume ───────────────────────────────────────────────────────────
function scheduleMidnight() {
  const now = new Date(), next = new Date(now)
  next.setUTCHours(24,0,0,0)
  setTimeout(()=>{
    let resumed = 0
    for (const e of _heap) { if (e?.status==='paused') { e.status='pending'; resumed++ } }
    if (resumed) { console.log(`[OVERLAY] Midnight: ${resumed} entries resumed`); _dirty=true }
    scheduleMidnight()
  }, next-now)
}

// ── Stats ─────────────────────────────────────────────────────────────────────
export function getOverlayStats() {
  const pending = _heap.filter(e=>e?.status==='pending')
  const paused  = _heap.filter(e=>e?.status==='paused')
  const ready   = pending.filter(e=>e?.readyToExec)
  const byChain = {}
  for (const e of [...pending,...paused]) {
    if (!e?.chain) continue
    byChain[e.chain] = (byChain[e.chain]||0)+1
  }
  const valueEst = _heap.reduce((s,e)=>s+(e?.profitEst||0),0)
  return {
    queueSize:       _heap.length,
    pending:         pending.length,
    paused:          paused.length,
    readyToExec:     ready.length,
    totalStored:     _totalStored,
    totalExecuted:   _totalExecuted,
    totalExpired:    _totalExpired,
    totalRetried:    _totalRetried,
    captureRate:     _totalStored > 0 ? ((_totalExecuted/_totalStored)*100).toFixed(1)+'%' : '0%',
    queueValueEst:   valueEst,
    pendingByChain:  byChain,
    deployed:        _deployed,
    drainActive:     _draining,
  }
}

// ── Events ────────────────────────────────────────────────────────────────────
on('deploy_success', ({ chain }) => {
  _deployed = true
  const pending = overlayPending(chain)
  if (pending.length) {
    console.log(`[OVERLAY] ${chain} deployed — ${pending.length} queued swaps ready`)
    if (_replayFn) setTimeout(()=>replayChain(chain, _replayFn).catch(()=>{}), 1000)
  }
})
on('system_halt',   ()=>{ _draining = false })
on('system_resume', ()=>{ _deployed = true })

// ── Start ─────────────────────────────────────────────────────────────────────
export function startOverlay() {
  restore()
  setInterval(persist,  10000)
  setInterval(drain,    1000)
  scheduleMidnight()
  console.log(`[OVERLAY] Permanent queue — ${_heap.length} entries restored`)
  console.log('[OVERLAY] Runs forever: pre-deploy + post-deploy + retry + midnight reset')
}
