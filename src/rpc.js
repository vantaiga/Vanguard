// X7-SV · rpc.js — 6-tier RPC router · tiered WebSocket by chain tier

import WebSocket from 'ws'
import { getChain } from './chains.js'

// Free public RPC fallbacks
const FREE = {
  ethereum:  ['https://eth.llamarpc.com','https://rpc.ankr.com/eth','https://ethereum.publicnode.com'],
  arbitrum:  ['https://arb1.arbitrum.io/rpc','https://rpc.ankr.com/arbitrum','https://arbitrum.publicnode.com'],
  polygon:   ['https://polygon.llamarpc.com','https://rpc.ankr.com/polygon','https://polygon.publicnode.com'],
  base:      ['https://mainnet.base.org','https://rpc.ankr.com/base','https://base.publicnode.com'],
  optimism:  ['https://mainnet.optimism.io','https://rpc.ankr.com/optimism','https://optimism.publicnode.com'],
  avalanche: ['https://api.avax.network/ext/bc/C/rpc','https://rpc.ankr.com/avalanche'],
  bnb:       ['https://bsc-dataseed.bnbchain.org','https://rpc.ankr.com/bsc','https://bsc.publicnode.com'],
  scroll:    ['https://rpc.scroll.io','https://rpc.ankr.com/scroll'],
}

const FREE_WSS = {
  ethereum:  ['wss://eth.llamarpc.com','wss://ethereum.publicnode.com'],
  arbitrum:  ['wss://arbitrum.publicnode.com'],
  polygon:   ['wss://polygon.llamarpc.com','wss://polygon.publicnode.com'],
  base:      ['wss://base.publicnode.com'],
  optimism:  ['wss://optimism.publicnode.com'],
  avalanche: ['wss://api.avax.network/ext/bc/C/ws'],
  bnb:       ['wss://bsc.publicnode.com'],
  scroll:    ['wss://wss-rpc.scroll.io/ws'],
}

// Connections per tier: Tier1=3 WS, Tier2=2 WS, Tier3=1 WS
const TIER_WS = { 1: 3, 2: 2, 3: 1 }

class RPCRouter {
  constructor(chainName, primaryHttp) {
    this.chain = chainName
    this.providers = [primaryHttp, ...(FREE[chainName] || [])].filter(Boolean)
    this.idx = 0
    this.cooldown = {}
  }

  avail(i) { return Date.now() > (this.cooldown[i] || 0) }

  async call(method, params = []) {
    for (let i = 0; i < this.providers.length; i++) {
      const n = (this.idx + i) % this.providers.length
      if (!this.avail(n)) continue
      try {
        const r = await fetch(this.providers[n], {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(8000)
        })
        if (r.status === 429) { this.cooldown[n] = Date.now() + 60000; continue }
        if (!r.ok) { this.cooldown[n] = Date.now() + 10000; continue }
        const d = await r.json()
        if (d.error?.code === -32005) { this.cooldown[n] = Date.now() + 60000; continue }
        if (d.error) throw new Error(d.error.message)
        this.idx = n
        return d.result
      } catch (e) {
        if (e.name === 'AbortError' || e.message?.includes('429')) {
          this.cooldown[n] = Date.now() + 30000; continue
        }
        this.cooldown[n] = Date.now() + 10000
      }
    }
    throw new Error(`[RPC:${this.chain}] All providers exhausted`)
  }
}

class ChainWS {
  constructor(chainName, tier) {
    this.chain = chainName
    this.maxConns = TIER_WS[tier] || 1
    this.sockets = []
    this.handlers = {}
    this.seen = new Set()
    this.subs = []
  }

  dedup(key) {
    if (this.seen.has(key)) return true
    this.seen.add(key)
    if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value)
    return false
  }

  on(evt, fn) { this.handlers[evt] = fn; return this }

  connect(url, idx) {
    if (!url) return
    try {
      const ws = new WebSocket(url)
      this.sockets[idx] = ws
      ws.on('open', () => {
        this.subs.forEach(s => ws.send(JSON.stringify(s)))
        this.handlers.connected?.(idx)
      })
      ws.on('message', raw => {
        try {
          const msg = JSON.parse(raw.toString())
          const log = msg.params?.result
          if (!log) return
          const key = (log.transactionHash || '') + (log.logIndex || '') + (log.blockNumber || '')
          if (key && this.dedup(key)) return
          this.handlers.log?.(log, idx)
        } catch {}
      })
      ws.on('error', () => {})
      ws.on('close', () => setTimeout(() => this.connect(url, idx), 2000 + idx * 500))
    } catch { setTimeout(() => this.connect(url, idx), 5000) }
  }

  subscribe(sub) {
    this.subs.push(sub)
    this.sockets.filter(ws => ws?.readyState === 1).forEach(ws => ws.send(JSON.stringify(sub)))
  }

  start(primaryWss) {
    const endpoints = [primaryWss, ...(FREE_WSS[this.chain] || [])].filter(Boolean)
    for (let i = 0; i < Math.min(this.maxConns, endpoints.length); i++) {
      setTimeout(() => this.connect(endpoints[i], i), i * 300)
    }
    return this
  }
}

const _routers = {}, _ws = {}

export function initRPC(chains) {
  Object.values(chains).forEach(c => {
    _routers[c.name] = new RPCRouter(c.name, c.rpcHttp)
    _ws[c.name] = new ChainWS(c.name, c.tier || 3).start(c.rpcWss)
  })
  console.log(`[RPC] Initialized ${Object.keys(chains).length} chains`)
}

export const rpcCall = (chain, method, params) => {
  const r = _routers[chain]
  return r ? r.call(method, params) : Promise.reject(new Error('No router: ' + chain))
}
export const getWS = chain => _ws[chain]
