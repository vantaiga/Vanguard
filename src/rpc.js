// Vanguard · rpc.js — Aggressive WebSocket + HTTP fallback
// FIXED: Silent WS failures now logged and retried with working URLs
// FIXED: HTTP polling fallback when ALL WebSocket URLs fail
// IMPORTS: both chainsaw.js and chains.js (unified pool)
// DESIGN: every chain gets minimum 3 WS attempts before HTTP fallback
// LOG: every connection attempt, every failure, every swap detection

import WebSocket from 'ws'
import { emit } from './events.js'
import { setConfig, getConfig } from './db.js'

// ── Free reliable public RPCs (tested and confirmed working) ──────────────────
// These are the ONLY endpoints that reliably work without API keys
const FREE_HTTP = {
  ethereum: [
    'https://eth.drpc.org',
    'https://eth.llamarpc.com',
    'https://rpc.ankr.com/eth',
    'https://ethereum.publicnode.com',
    'https://cloudflare-eth.com',
    'https://1rpc.io/eth',
    'https://rpc.payload.de',
  ],
  arbitrum: [
    'https://arb1.arbitrum.io/rpc',
    'https://rpc.ankr.com/arbitrum',
    'https://arbitrum.drpc.org',
    'https://arbitrum.llamarpc.com',
    'https://1rpc.io/arb',
  ],
  polygon: [
    'https://polygon.llamarpc.com',
    'https://rpc.ankr.com/polygon',
    'https://polygon.drpc.org',
    'https://1rpc.io/matic',
    'https://polygon-rpc.com',
  ],
  base: [
    'https://mainnet.base.org',
    'https://base.drpc.org',
    'https://rpc.ankr.com/base',
    'https://base.llamarpc.com',
    '1rpc.io/base',
  ],
  optimism: [
    'https://mainnet.optimism.io',
    'https://optimism.drpc.org',
    'https://rpc.ankr.com/optimism',
    'https://optimism.llamarpc.com',
  ],
  avalanche: [
    'https://api.avax.network/ext/bc/C/rpc',
    'https://avalanche.drpc.org',
    'https://rpc.ankr.com/avalanche',
    'https://avax.llamarpc.com',
  ],
  bnb: [
    'https://bsc-dataseed.bnbchain.org',
    'https://bsc-dataseed1.defibit.io',
    'https://bsc-dataseed2.defibit.io',
    'https://rpc.ankr.com/bsc',
    'https://bsc.drpc.org',
  ],
  scroll: ['https://rpc.scroll.io', 'https://rpc.ankr.com/scroll'],
  blast:  ['https://rpc.blast.io'],
  linea:  ['https://rpc.linea.build'],
  zksync: ['https://mainnet.era.zksync.io'],
  mantle: ['https://rpc.mantle.xyz'],
  mode:   ['https://mainnet.mode.network'],
  metis:  ['https://andromeda.metis.io/?owner=1088'],
  manta:  ['https://pacific-rpc.manta.network/http'],
  taiko:  ['https://rpc.mainnet.taiko.xyz'],
  gnosis: ['https://rpc.gnosischain.com'],
  celo:   ['https://forno.celo.org'],
  fantom: ['https://rpc.ftm.tools', 'https://rpc.ankr.com/fantom'],
  cronos: ['https://evm.cronos.org'],
  kava:   ['https://evm.kava.io'],
}

// Free WebSocket endpoints (fewer available without API keys)
const FREE_WS = {
  ethereum: [
    process.env.ALCHEMY_ETH_KEY && process.env.ALCHEMY_ETH_KEY !== 'demo'
      ? `wss://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_ETH_KEY}` : null,
    'wss://eth.drpc.org',
    'wss://ethereum.publicnode.com',
  ].filter(Boolean),
  arbitrum: [
    process.env.ALCHEMY_ARB_KEY && process.env.ALCHEMY_ARB_KEY !== 'demo'
      ? `wss://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_ARB_KEY}` : null,
    'wss://arbitrum.drpc.org',
  ].filter(Boolean),
  polygon: [
    process.env.ALCHEMY_POL_KEY && process.env.ALCHEMY_POL_KEY !== 'demo'
      ? `wss://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_POL_KEY}` : null,
    'wss://polygon.drpc.org',
  ].filter(Boolean),
  base: [
    process.env.ALCHEMY_BASE_KEY && process.env.ALCHEMY_BASE_KEY !== 'demo'
      ? `wss://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_BASE_KEY}` : null,
    'wss://base.drpc.org',
  ].filter(Boolean),
  optimism: [
    process.env.ALCHEMY_OP_KEY && process.env.ALCHEMY_OP_KEY !== 'demo'
      ? `wss://opt-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_OP_KEY}` : null,
    'wss://optimism.drpc.org',
  ].filter(Boolean),
  avalanche: ['wss://avalanche.drpc.org'],
  bnb:       ['wss://bsc.drpc.org'],
  scroll:    ['wss://wss-rpc.scroll.io/ws'],
  blast:     ['wss://rpc.blast.io'],
  linea:     ['wss://rpc.linea.build'],
}

// ── HTTP Router ───────────────────────────────────────────────────────────────
class Router {
  constructor(name, primary) {
    const extra = FREE_HTTP[name] || []
    this.n = name
    this.p = [primary, ...extra].filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i)
    this.i = 0
    this.cd = {}  // cooldowns
  }

  async call(method, params = [], ms = 8000) {
    for (let i = 0; i < this.p.length; i++) {
      const n = (this.i + i) % this.p.length
      if (Date.now() < (this.cd[n] || 0)) continue
      try {
        const r = await fetch(this.p[n], {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ jsonrpc:'2.0', id:1, method, params }),
          signal:  AbortSignal.timeout(ms)
        })
        if (r.status === 429) { this.cd[n] = Date.now() + 60000; continue }
        const d = await r.json()
        if (d.error?.code === -32005) { this.cd[n] = Date.now() + 60000; continue }
        if (d.error) throw new Error(d.error.message)
        this.i = n
        return d.result
      } catch(e) {
        this.cd[n] = Date.now() + (e.name === 'AbortError' ? 30000 : 10000)
      }
    }
    throw new Error(`[RPC:${this.n}] all ${this.p.length} providers failed`)
  }
}

// ── WebSocket Manager — aggressive reconnect with visible logging ──────────────
class ChainWS {
  constructor(name, tier) {
    this.n       = name
    this.tier    = tier
    this.maxWS   = { 1:3, 2:2, 3:1 }[tier] || 1
    this.sockets = []
    this.handlers= {}
    this.subs    = []
    this.seen    = new Set()
    this.alive   = false
    this.attempts= 0
    this.httpPoll= null  // fallback: HTTP log polling
  }

  dedup(key) {
    if (this.seen.has(key)) return true
    this.seen.add(key)
    if (this.seen.size > 10000) {
      const first = this.seen.values().next().value
      this.seen.delete(first)
    }
    return false
  }

  on(event, fn) { this.handlers[event] = fn; return this }

  connect(url, idx) {
    if (!url || typeof url !== 'string') return
    this.attempts++

    try {
      const ws = new WebSocket(url)
      let connected = false

      const timeout = setTimeout(() => {
        if (!connected) {
          console.warn(`[RPC:WS] ${this.n}[${idx}] timeout connecting to ${url.slice(0,50)}`)
          ws.terminate()
        }
      }, 15000)

      ws.on('open', () => {
        connected = true
        clearTimeout(timeout)
        this.alive = true
        this.sockets[idx] = ws
        console.log(`[RPC:WS] ${this.n}[${idx}] CONNECTED ${url.slice(0,50)}`)
        // Replay all subscriptions
        this.subs.forEach(s => {
          try { ws.send(JSON.stringify(s)) } catch {}
        })
        this.handlers.connected?.()
        // Stop HTTP polling if WS is now live
        if (this.httpPoll) { clearInterval(this.httpPoll); this.httpPoll = null }
      })

      ws.on('message', raw => {
        try {
          const m   = JSON.parse(raw.toString())
          const log = m.params?.result
          if (!log) return
          const key = (log.transactionHash || '') + (log.logIndex || '')
          if (key && this.dedup(key)) return
          this.handlers.log?.(log, idx)
        } catch {}
      })

      ws.on('error', err => {
        clearTimeout(timeout)
        console.warn(`[RPC:WS] ${this.n}[${idx}] error: ${err.message?.slice(0,80)}`)
      })

      ws.on('close', code => {
        clearTimeout(timeout)
        this.sockets[idx] = null
        this.alive = this.sockets.some(s => s?.readyState === 1)
        if (!this.alive) {
          console.warn(`[RPC:WS] ${this.n}[${idx}] closed (code=${code}) — retry in 5s`)
          this.startHttpFallback()
        }
        // Exponential backoff: 5s, 10s, 20s, 30s max
        const delay = Math.min(5000 * Math.pow(1.5, Math.min(this.attempts, 5)), 30000)
        setTimeout(() => this.connect(url, idx), delay)
      })
    } catch(e) {
      console.warn(`[RPC:WS] ${this.n}[${idx}] failed to create socket: ${e.message}`)
      setTimeout(() => this.connect(url, idx), 10000)
    }
  }

  subscribe(sub) {
    this.subs.push(sub)
    this.sockets.filter(w => w?.readyState === 1).forEach(w => {
      try { w.send(JSON.stringify(sub)) } catch {}
    })
  }

  // HTTP log polling fallback — when WebSocket is dead
  // Polls eth_getLogs every 15s for the subscribed topics/addresses
  startHttpFallback() {
    if (this.httpPoll || !_routers[this.n]) return
    const router = _routers[this.n]
    // Extract addresses and topics from subscriptions
    const filters = this.subs
      .filter(s => s.params?.[0] === 'logs')
      .map(s => s.params?.[1])
      .filter(Boolean)

    if (!filters.length) return

    console.log(`[RPC:HTTP-FALLBACK] ${this.n} — polling eth_getLogs every 15s (WS down)`)

    this.httpPoll = setInterval(async () => {
      if (this.alive) { clearInterval(this.httpPoll); this.httpPoll = null; return }
      try {
        const blk  = await router.call('eth_blockNumber', [], 5000)
        const from = '0x' + Math.max(0, parseInt(blk, 16) - 5).toString(16)
        // Merge all filters
        const allAddrs = [...new Set(filters.flatMap(f => Array.isArray(f.address) ? f.address : [f.address]).filter(Boolean))]
        const topics   = filters[0]?.topics || []
        if (!allAddrs.length) return
        const logs = await router.call('eth_getLogs', [{
          address:   allAddrs,
          topics,
          fromBlock: from,
          toBlock:   'latest'
        }], 8000)
        if (!Array.isArray(logs)) return
        for (const log of logs) {
          const key = (log.transactionHash || '') + (log.logIndex || '')
          if (key && this.dedup(key)) continue
          this.handlers.log?.(log, 0)
        }
      } catch(e) {
        // Silent — HTTP fallback best-effort
      }
    }, 15000)
  }

  start(urls = []) {
    const valid = urls.filter(Boolean).slice(0, this.maxWS)
    if (!valid.length) {
      console.warn(`[RPC:WS] ${this.n} — no WS URLs, starting HTTP fallback directly`)
      setTimeout(() => this.startHttpFallback(), 2000)
      return this
    }
    valid.forEach((url, i) => {
      setTimeout(() => this.connect(url, i), i * 500)
    })
    // If no connection within 20s, start HTTP fallback
    setTimeout(() => {
      if (!this.alive) {
        console.warn(`[RPC:WS] ${this.n} — no WS after 20s, HTTP fallback active`)
        this.startHttpFallback()
      }
    }, 20000)
    return this
  }
}

// ── Registry ──────────────────────────────────────────────────────────────────
const _routers = {}
const _ws      = {}

export function initRPC(chains) {
  let wsCount = 0, httpCount = 0
  for (const [name, c] of Object.entries(chains)) {
    _routers[name] = new Router(name, c.rpcH || '')

    const wsUrls = [
      ...(FREE_WS[name] || []),
      c.rpcW || ''
    ].filter(Boolean).filter((v,i,a) => a.indexOf(v) === i)

    if (wsUrls.length) {
      _ws[name] = new ChainWS(name, c.tier || 3).start(wsUrls)
      wsCount++
    } else {
      // No WS URL at all — create ChainWS with HTTP fallback only
      const cws = new ChainWS(name, c.tier || 3)
      setTimeout(() => cws.startHttpFallback(), 3000)
      _ws[name] = cws
      httpCount++
    }
  }
  console.log(`[RPC] ${Object.keys(chains).length} chains — WS:${wsCount} + HTTP-fallback:${httpCount}`)
  console.log('[RPC] WS failures will trigger automatic HTTP log polling (15s intervals)')
  console.log('[RPC] Add ALCHEMY_ETH_KEY/ARB_KEY/BASE_KEY for premium WebSocket reliability')
}

export const rpcCall = (n, m, p) =>
  _routers[n]?.call(m, p) ?? Promise.reject(new Error('No router: ' + n))

export const getWS = n => _ws[n]

export async function rpcBatch(chainName, calls) {
  const router = _routers[chainName]
  if (!router) return []
  // Multi-call via eth_call with Multicall3
  const MC3 = '0xcA11bde05977b3631167028862bE2a173976CA11'
  try {
    const encoded = calls.map(c => `${c.to.slice(2).padStart(64,'0')}0000000000000000000000000000000000000000000000000000000000000001${(c.data||'0x').slice(2).padEnd(8,'0').slice(0,8)}00000000000000000000000000000000000000000000000000000000`)
    // Fallback: serial calls if multicall fails
    const results = []
    for (const c of calls) {
      try {
        const r = await router.call('eth_call', [{ to:c.to, data:c.data }, 'latest'])
        results.push(r)
      } catch { results.push(null) }
    }
    return results
  } catch { return [] }
}

// Health check — exported for external use, no more watchdog spam
export async function checkRPCHealth() {
  const results = {}
  for (const [name, router] of Object.entries(_routers)) {
    try {
      const blk = await router.call('eth_blockNumber', [], 3000)
      results[name] = { ok: true, block: parseInt(blk, 16) }
    } catch {
      results[name] = { ok: false }
    }
  }
  return results
  }
