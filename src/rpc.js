// Vanguard · rpc.js — Zero red logs. Perfect runtime.
//
// FAILURE CLASSIFICATION (from logs):
//   PERMANENT — log once as [warn], blacklist, HTTP fallback, NEVER retry:
//     ENOTFOUND/EAI_AGAIN     → DNS dead (cronos, metis, klaytn)
//     HTTP 200/401/403/404/405/501 → wrong URL or auth required
//     Immediate close (<3s after open) → drpc.org closes free WS instantly
//     3+ consecutive timeouts → dead endpoint
//   TRANSIENT — silent retry with backoff:
//     code 1006 after >30s connected → normal keepalive drop, retry
//
// DRPC.ORG BEHAVIOR (confirmed from logs):
//   eth.drpc.org / arbitrum.drpc.org — stay connected ✓
//   base.drpc.org / bsc.drpc.org / optimism.drpc.org — connect then
//     immediately close (code 1006 in same log line) — treat as permanent
//     and fall through to HTTP polling silently.

import WebSocket from 'ws'
import { getConfig } from './db.js'

// Chains that need WS per rpc.js itself (supplementing chainsaw.js)
const ALCHEMY = k => {
  const v = process.env[k]
  return (v && v.length > 20 && v !== 'demo') ? v : null
}

// Free WS — ONLY endpoints confirmed working from logs
// drpc.org that immediately 1006: base, bsc, optimism, polygon → HTTP fallback
const FREE_WS = {
  ethereum:  [ALCHEMY('ALCHEMY_ETH_KEY') && `wss://eth-mainnet.g.alchemy.com/v2/${ALCHEMY('ALCHEMY_ETH_KEY')}`, 'wss://eth.drpc.org'].filter(Boolean),
  arbitrum:  [ALCHEMY('ALCHEMY_ARB_KEY') && `wss://arb-mainnet.g.alchemy.com/v2/${ALCHEMY('ALCHEMY_ARB_KEY')}`, 'wss://arbitrum.drpc.org'].filter(Boolean),
  polygon:   [ALCHEMY('ALCHEMY_POL_KEY') && `wss://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY('ALCHEMY_POL_KEY')}`].filter(Boolean),
  base:      [ALCHEMY('ALCHEMY_BASE_KEY') && `wss://base-mainnet.g.alchemy.com/v2/${ALCHEMY('ALCHEMY_BASE_KEY')}`].filter(Boolean),
  optimism:  [ALCHEMY('ALCHEMY_OP_KEY')  && `wss://opt-mainnet.g.alchemy.com/v2/${ALCHEMY('ALCHEMY_OP_KEY')}`].filter(Boolean),
  gnosis:    ['wss://rpc.gnosischain.com/wss'],
  celo:      ['wss://forno.celo.org/ws'],
  fuse:      ['wss://rpc.fuse.io/ws'],
  // Everything else: HTTP polling only (dead WS or no reliable free WS)
}

// Free HTTP RPCs — tested working without API keys
const FREE_HTTP = {
  ethereum:  ['https://eth.drpc.org','https://eth.llamarpc.com','https://rpc.ankr.com/eth','https://ethereum.publicnode.com','https://cloudflare-eth.com','https://1rpc.io/eth'],
  arbitrum:  ['https://arb1.arbitrum.io/rpc','https://rpc.ankr.com/arbitrum','https://arbitrum.drpc.org','https://arbitrum.llamarpc.com','https://1rpc.io/arb'],
  polygon:   ['https://polygon.llamarpc.com','https://rpc.ankr.com/polygon','https://polygon.drpc.org','https://1rpc.io/matic','https://polygon-rpc.com'],
  base:      ['https://mainnet.base.org','https://base.drpc.org','https://rpc.ankr.com/base','https://base.llamarpc.com','https://1rpc.io/base'],
  optimism:  ['https://mainnet.optimism.io','https://optimism.drpc.org','https://rpc.ankr.com/optimism','https://optimism.llamarpc.com'],
  avalanche: ['https://api.avax.network/ext/bc/C/rpc','https://avalanche.drpc.org','https://rpc.ankr.com/avalanche'],
  bnb:       ['https://bsc-dataseed.bnbchain.org','https://bsc-dataseed1.defibit.io','https://rpc.ankr.com/bsc','https://bsc.drpc.org'],
  scroll:    ['https://rpc.scroll.io','https://rpc.ankr.com/scroll'],
  blast:     ['https://rpc.blast.io'],
  linea:     ['https://rpc.linea.build'],
  zksync:    ['https://mainnet.era.zksync.io'],
  mantle:    ['https://rpc.mantle.xyz'],
  mode:      ['https://mainnet.mode.network'],
  metis:     ['https://andromeda.metis.io/?owner=1088'],
  taiko:     ['https://rpc.mainnet.taiko.xyz'],
  gnosis:    ['https://rpc.gnosischain.com'],
  celo:      ['https://forno.celo.org'],
  fantom:    ['https://rpc.ftm.tools','https://rpc.ankr.com/fantom'],
  cronos:    ['https://evm.cronos.org'],
  kava:      ['https://evm.kava.io'],
  aurora:    ['https://mainnet.aurora.dev'],
  fuse:      ['https://rpc.fuse.io'],
  rootstock: ['https://public-node.rsk.co'],
  fraxtal:   ['https://rpc.frax.com'],
  conflux:   ['https://evm.confluxrpc.com'],
  unichain:  ['https://unichain-rpc.publicnode.com'],
  ink:       ['https://rpc-gel.inkonchain.com'],
  berachain: ['https://rpc.berachain.com'],
  evmos:     ['https://eth.bd.evmos.org:8545'],
  okc:       ['https://exchainrpc.okex.org'],
  telos:     ['https://mainnet.telos.net/evm'],
  klaytn:    ['https://public-en.node.kaia.io'],
  manta:     ['https://pacific-rpc.manta.network/http'],
}

// Session-scoped blacklist — never cleared, never written to disk
const _bl = new Set()

// ── HTTP Router ────────────────────────────────────────────────────────────────
class Router {
  constructor(name, primary) {
    const extra = FREE_HTTP[name] || []
    this.n  = name
    this.p  = [primary, ...extra].filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i)
    this.i  = 0
    this.cd = {}
  }
  async call(method, params=[], ms=8000) {
    for (let i=0; i<this.p.length; i++) {
      const n=(this.i+i)%this.p.length
      if (Date.now()<(this.cd[n]||0)) continue
      try {
        const r=await fetch(this.p[n],{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),
          signal:AbortSignal.timeout(ms)
        })
        if(r.status===429){this.cd[n]=Date.now()+60000;continue}
        const d=await r.json()
        if(d.error?.code===-32005){this.cd[n]=Date.now()+60000;continue}
        if(d.error)throw new Error(d.error.message)
        this.i=n;return d.result
      } catch(e){this.cd[n]=Date.now()+(e.name==='AbortError'?30000:10000)}
    }
    throw new Error(`[RPC:${this.n}] all providers failed`)
  }
}

// ── WebSocket — blacklist on permanent failure, HTTP fallback silently ─────────
class ChainWS {
  constructor(name, tier) {
    this.n        = name
    this.tier     = tier
    this.sockets  = []
    this.handlers = {}
    this.subs     = []
    this.seen     = new Set()
    this.alive    = false
    this._poll    = null
    this._pingers = {}
    this._tc      = {}  // timeout counter per url
    this._openTs  = {}  // timestamp of last open per url
  }

  dedup(key) {
    if(this.seen.has(key))return true
    this.seen.add(key)
    if(this.seen.size>10000)this.seen.delete(this.seen.values().next().value)
    return false
  }
  on(e,fn){this.handlers[e]=fn;return this}

  _ping(ws, idx) {
    this._stopPing(idx)
    let missed=0
    const id=setInterval(()=>{
      if(!ws||ws.readyState!==1){this._stopPing(idx);return}
      try{ws.ping()}catch{}
      missed++
      if(missed>=3){this._stopPing(idx);try{ws.terminate()}catch{}}
    },20000)
    ws.on('pong',()=>{missed=0})
    this._pingers[idx]=id
  }
  _stopPing(idx){if(this._pingers[idx]){clearInterval(this._pingers[idx]);delete this._pingers[idx]}}

  connect(url, idx) {
    const bk=`${this.n}:${url}`
    if(_bl.has(bk))return

    let ws, connected=false

    // Classify: did we connect and then immediately close?
    const connectedAt = {ts:0}

    const timer=setTimeout(()=>{
      if(!connected){
        this._tc[url]=(this._tc[url]||0)+1
        if(this._tc[url]>=2){  // 2 timeouts = permanent
          _bl.add(bk)
          console.warn(`[RPC:WS] ${this.n} BLACKLISTED (timeout×${this._tc[url]})`)
          this._startHTTP()
        }
        try{ws?.terminate()}catch{}
      }
    },15000)

    try { ws=new WebSocket(url) }
    catch(e){
      clearTimeout(timer)
      _bl.add(bk)
      console.warn(`[RPC:WS] ${this.n} BLACKLISTED (${e.message?.slice(0,40)})`)
      this._startHTTP()
      return
    }

    ws.on('open',()=>{
      connected=true
      clearTimeout(timer)
      this._tc[url]=0
      connectedAt.ts=Date.now()
      this.alive=true
      this.sockets[idx]=ws
      // Note: only log connection for chains that actually STAY connected
      // (drpc.org immediate-close chains would spam connect/close)
    })

    ws.on('message',raw=>{
      try{
        const m=JSON.parse(raw.toString())
        const log=m.params?.result
        if(!log)return
        const key=(log.transactionHash||'')+(log.logIndex||'')
        if(key&&this.dedup(key))return
        this.handlers.log?.(log,idx)
      }catch{}
    })

    ws.on('error',err=>{
      clearTimeout(timer)
      const msg=err.message||''
      const statusMatch=msg.match(/Unexpected server response: (\d+)/)
      const status=statusMatch?parseInt(statusMatch[1]):null

      // Permanent: DNS failure or auth/method error
      if(/ENOTFOUND|EAI_AGAIN|ESERVFAIL/.test(msg)||[200,401,403,404,405,501].includes(status)){
        _bl.add(bk)
        console.warn(`[RPC:WS] ${this.n} BLACKLISTED (${status||msg.slice(0,30)})`)
        this._startHTTP()
      }
      // Transient: no log, close handler will retry
    })

    ws.on('close',code=>{
      clearTimeout(timer)
      this._stopPing(idx)
      this.sockets[idx]=null
      this.alive=this.sockets.some(s=>s?.readyState===1)

      if(_bl.has(bk))return  // already blacklisted

      // Detect immediate close (drpc.org free WS pattern)
      // connected but closed in <3s = drpc.org rejects eth_subscribe
      const openDuration=connected?(Date.now()-connectedAt.ts):0
      if(connected && openDuration<3000){
        this._tc[url]=(this._tc[url]||0)+1
        if(this._tc[url]>=2){
          _bl.add(bk)
          // Silently blacklist — no warning needed, just use HTTP
          this._startHTTP()
          return
        }
      }

      if(!this.alive)this._startHTTP()

      // Exponential backoff
      const delay=Math.min(5000*Math.pow(1.5,Math.min(this._tc[url]||0,5)),30000)
      setTimeout(()=>this.connect(url,idx),delay)
    })

    ws.on('open',()=>{
      // Subscribe after open
      this.subs.forEach(s=>{try{ws.send(JSON.stringify(s))}catch{}})
      this.handlers.connected?.()
      this._ping(ws,idx)
      if(this._poll){clearInterval(this._poll);this._poll=null}
      console.log(`[RPC:WS] ${this.n}[${idx}] connected`)
    })
  }

  subscribe(sub){
    this.subs.push(sub)
    this.sockets.filter(w=>w?.readyState===1).forEach(w=>{try{w.send(JSON.stringify(sub))}catch{}})
  }

  _startHTTP(){
    if(this._poll||!_routers[this.n])return
    const router=_routers[this.n]
    const filters=this.subs.filter(s=>s.params?.[0]==='logs').map(s=>s.params?.[1]).filter(Boolean)
    const addrs=[...new Set(filters.flatMap(f=>Array.isArray(f.address)?f.address:[f.address]).filter(Boolean))]
    if(!addrs.length)return

    const ms={1:12000,2:5000,3:15000}[this.tier]||12000

    this._poll=setInterval(async()=>{
      if(this.alive){clearInterval(this._poll);this._poll=null;return}
      try{
        const blk=await router.call('eth_blockNumber',[],5000)
        const from='0x'+Math.max(0,parseInt(blk,16)-5).toString(16)
        for(let i=0;i<addrs.length;i+=20){
          const batch=addrs.slice(i,i+20)
          try{
            const logs=await router.call('eth_getLogs',[{address:batch,topics:filters[0]?.topics||[],fromBlock:from,toBlock:'latest'}],8000)
            if(!Array.isArray(logs))continue
            for(const log of logs){
              const key=(log.transactionHash||'')+(log.logIndex||'')
              if(key&&this.dedup(key))continue
              this.handlers.log?.(log,0)
            }
          }catch{}
          await new Promise(r=>setTimeout(r,150))
        }
      }catch{}
    },ms)
  }

  start(urls=[]){
    const valid=urls.filter(u=>u&&!_bl.has(`${this.n}:${u}`)).slice(0,2)
    if(!valid.length){setTimeout(()=>this._startHTTP(),1000);return this}
    valid.forEach((url,i)=>setTimeout(()=>this.connect(url,i),i*300))
    setTimeout(()=>{if(!this.alive)this._startHTTP()},20000)
    return this
  }
}

// ── Registry ───────────────────────────────────────────────────────────────────
const _routers={}
const _ws={}

export function initRPC(chains){
  let ws=0,http=0
  for(const [name,c] of Object.entries(chains)){
    _routers[name]=new Router(name,c.rpcH||'')
    const wsUrls=[...(FREE_WS[name]||[]),(c.rpcW&&!['cronos','metis','klaytn','rootstock','fraxtal','linea','conflux','unichain','ink','berachain','evmos','okc','telos','mantle','scroll','canto','taiko'].includes(name)?c.rpcW:'')].filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i)
    _ws[name]=new ChainWS(name,c.tier||3).start(wsUrls)
    wsUrls.length?ws++:http++
  }
  console.log(`[RPC] ${Object.keys(chains).length} chains — WS attempted:${ws} HTTP-only:${http}`)
  console.log('[RPC] Dead WS → blacklisted once → silent HTTP polling forever')
  console.log('[RPC] Ping/pong keepalive every 20s on live connections')
}

export const rpcCall=(n,m,p)=>_routers[n]?.call(m,p)??Promise.reject(new Error('No router:'+n))
export const getWS=n=>_ws[n]

export async function checkRPCHealth(){
  const out={}
  for(const [n,r] of Object.entries(_routers)){
    try{const b=await r.call('eth_blockNumber',[],3000);out[n]={ok:true,block:parseInt(b,16)}}
    catch{out[n]={ok:false}}
  }
  return out
    }
