import WebSocket from 'ws'

// Free fallback RPCs per chain
const FREE = {
  ethereum: ['https://eth.drpc.org','https://eth.llamarpc.com','https://rpc.ankr.com/eth','https://ethereum.publicnode.com'],
  arbitrum: ['https://arb1.arbitrum.io/rpc','https://rpc.ankr.com/arbitrum'],
  polygon:  ['https://polygon.llamarpc.com','https://rpc.ankr.com/polygon'],
  base:     ['https://mainnet.base.org','https://rpc.ankr.com/base'],
  optimism: ['https://mainnet.optimism.io','https://rpc.ankr.com/optimism'],
  avalanche:['https://api.avax.network/ext/bc/C/rpc','https://rpc.ankr.com/avalanche'],
  bnb:      ['https://bsc-dataseed.bnbchain.org','https://rpc.ankr.com/bsc'],
}

class Router {
  constructor(name,primary){
    this.n=name
    this.p=[primary,...(FREE[name]||[])].filter(Boolean)
    this.i=0; this.cd={}
  }
  async call(m,a=[]){
    for(let i=0;i<this.p.length;i++){
      const n=(this.i+i)%this.p.length
      if(Date.now()<(this.cd[n]||0))continue
      try{
        const r=await fetch(this.p[n],{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:a}),signal:AbortSignal.timeout(6000)})
        if(r.status===429){this.cd[n]=Date.now()+60000;continue}
        const d=await r.json()
        if(d.error?.code===-32005){this.cd[n]=Date.now()+60000;continue}
        if(d.error)throw new Error(d.error.message)
        this.i=n; return d.result
      }catch(e){this.cd[n]=Date.now()+(e.name==='AbortError'?30000:10000)}
    }
    throw new Error(`[RPC:${this.n}] all providers failed`)
  }
}

class ChainWS {
  constructor(name,tier){ this.n=name; this.maxWS={1:2,2:1,3:1}[tier]||1; this.sockets=[]; this.handlers={}; this.subs=[]; this.seen=new Set() }
  dedup(k){ if(this.seen.has(k))return true; this.seen.add(k); if(this.seen.size>5000)this.seen.delete(this.seen.values().next().value); return false }
  on(e,f){ this.handlers[e]=f; return this }
  connect(url,i){
    if(!url)return
    try{
      const ws=new WebSocket(url)
      this.sockets[i]=ws
      ws.on('open',()=>{ this.subs.forEach(s=>ws.send(JSON.stringify(s))); this.handlers.connected?.() })
      ws.on('message',raw=>{
        try{
          const m=JSON.parse(raw.toString()), log=m.params?.result
          if(!log)return
          const k=(log.transactionHash||'')+(log.logIndex||'')
          if(k&&this.dedup(k))return
          this.handlers.log?.(log,i)
        }catch{}
      })
      ws.on('error',()=>{})
      ws.on('close',()=>setTimeout(()=>this.connect(url,i),2000+i*500))
    }catch{ setTimeout(()=>this.connect(url,i),5000) }
  }
  subscribe(s){ this.subs.push(s); this.sockets.filter(w=>w?.readyState===1).forEach(w=>w.send(JSON.stringify(s))) }
  start(urls=[]){ urls.slice(0,this.maxWS).forEach((u,i)=>setTimeout(()=>this.connect(u,i),i*200)); return this }
}

const _r={}, _ws={}
export function initRPC(chains){
  Object.values(chains).forEach(c=>{
    _r[c.name]=new Router(c.name,c.rpcH)
    _ws[c.name]=new ChainWS(c.name,c.tier||3).start([c.rpcW,...(FREE[c.name]?.map(u=>u.replace('https://','wss://').replace('http://','ws://'))||[])])
  })
  console.log(`[RPC] ${Object.keys(chains).length} chains · WebSocket + HTTP fallback`)
}
export const rpcCall = (n,m,p) => _r[n]?.call(m,p) ?? Promise.reject(new Error('No router: '+n))
export const getWS   = n => _ws[n]
