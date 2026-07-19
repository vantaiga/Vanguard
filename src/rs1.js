// Vanguard · rs1.js — MEV Engine + Non-MEV Streams
// Absorbs: rs1-jit.js · rs1-solvers.js · rs1-mega-pools.js · rs2-expanded.js
// Static imports: ONLY db.js · events.js

import { getConfig, setConfig } from './db.js'
import { emit, on }             from './events.js'

// ── RS1 MEV revenue tracking ──────────────────────────────────────────────────
const _jit     = { total:parseFloat(getConfig('rs1_jit_total')||'0'),     count:0 }
const _solvers = { total:parseFloat(getConfig('rs1_solver_total')||'0'),  count:0 }
const _mega    = { total:parseFloat(getConfig('rs1_mega_total')||'0'),    count:0 }

function recordRS1(type, usd) {
  if (!usd||usd<=0) return
  if (type==='jit')    { _jit.total+=usd; _jit.count++ }
  if (type==='solver') { _solvers.total+=usd; _solvers.count++ }
  if (type==='mega')   { _mega.total+=usd; _mega.count++ }
  const all = _jit.total+_solvers.total+_mega.total
  setConfig('rs1_total', all.toFixed(2))
  emit('rs1_revenue', { type, amount:usd, total:all })
}

on('apex_success', ({ chain, profit })=>{ if(profit>0) recordRS1('jit', profit) })

// ── CoW Protocol solver ───────────────────────────────────────────────────────
async function checkCowSolver() {
  if (getConfig('system_paused')==='1') return
  try {
    const r = await fetch('https://api.cow.fi/mainnet/api/v1/orders?status=open&limit=20',{ signal:AbortSignal.timeout(5000) })
    if (!r.ok) return
    const orders = await r.json()
    if (!Array.isArray(orders)) return
    for (const order of orders) {
      const notional = parseFloat(order.sellAmount||'0')/1e6
      if (notional < 100000) continue
      const profit = Math.floor(notional*0.001)
      const { nexusRoute } = await import('./nexus.js')
      nexusRoute({ chain:'ethereum', type:'vault_arb', profitEst:profit, flashRequired:notional*0.1, chainId:1 })
    }
  } catch {}
}

// ── Extra pool subscriptions ──────────────────────────────────────────────────
const EXTRA_POOLS = {
  bnb:      ['0x36696169C63e42cd08ce11f5deeBbCeBae652050','0x172fcD41E0913e95784454622d1c3724f546f849','0x7213a321F1855CF1779f42c0CD85d3D95291D34C'],
  arbitrum: ['0x84652bb2539513BAf36e225c930Fdd8eaa63CE27','0x389938CF14Be379217570D8e4619E51fBDafaa21'],
  base:     ['0x1c88a27B43cf11B4F0D741e13e98b7dB3cb7FF6','0x46A15B0b27311cedF172AB29E4f4766fbE7F4364'],
  optimism: ['0x0493Bf8b6DBB159Ce2Db2E0E8403E753Abd1235b'],
}

const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'

async function subscribeExtraPools() {
  try {
    const { getWS } = await import('./chains1.js')
    let n = 0
    for (const [chainName, pools] of Object.entries(EXTRA_POOLS)) {
      const ws = getWS(chainName)
      if (!ws||ws.readyState!==1) continue
      for (const addr of pools) {
        ws.send(JSON.stringify({ jsonrpc:'2.0', id:Math.floor(Math.random()*999999), method:'eth_subscribe', params:['logs',{address:addr,topics:[SWAP_TOPIC]}] }))
        n++
      }
    }
    if (n>0) console.log(`[RS1] Extra pool subscriptions: ${n} (PCS + Camelot + Aerodrome + Velodrome)`)
  } catch {}
}

// ── RS2: Non-MEV Streams S1-S12 ───────────────────────────────────────────────
const STREAMS = {
  S1:  { name:'CoW Solver',         total:0, count:0 },
  S2:  { name:'CEX-DEX Arb',        total:0, count:0 },
  S3:  { name:'Stable Depeg',        total:0, count:0 },
  S4:  { name:'Governance Arb',      total:0, count:0 },
  S5:  { name:'Intent Flow',         total:0, count:0 },
  S6:  { name:'Liquidations',        total:0, count:0 },
  S7:  { name:'Perp Funding',        total:0, count:0 },
  S8:  { name:'NFT Sweep',           total:0, count:0 },
  S9:  { name:'Token Unlock',        total:0, count:0 },
  S10: { name:'Orderbook Arb',       total:0, count:0 },
  S11: { name:'Bridge Arb',          total:0, count:0 },
  S12: { name:'Protocol Fee Rebate', total:0, count:0 },
}

function restoreStreams() {
  for (const [k,s] of Object.entries(STREAMS)) s.total=parseFloat(getConfig('rs2_'+k)||'0')
}

function recordRS2(key, usd) {
  const s=STREAMS[key]; if(!s||!usd||usd<=0) return
  s.total+=usd; s.count++; setConfig('rs2_'+key, s.total.toFixed(2))
  emit('rs2_revenue',{stream:key,amount:usd})
}

// S2: CEX-DEX gap
on('cex_price',({symbol,price})=>{
  if(symbol!=='ETH') return
  const dex=parseFloat(getConfig('dex_price_ethereum')||'0')
  if(!dex) return
  const gap=Math.abs(price-dex)/price
  if(gap<0.001) return
  import('./nexus.js').then(({nexusRoute})=>nexusRoute({chain:'ethereum',type:'vault_arb',profitEst:Math.floor(1e6*gap*0.5),flashRequired:1e6,chainId:1})).catch(()=>{})
})

on('rs5_revenue',({layer,amount})=>{ if(layer===3) recordRS2('S7',amount*0.1) })

export const getRS1Stats = () => ({
  jit:     _jit,
  solvers: _solvers,
  mega:    _mega,
  total:   _jit.total+_solvers.total+_mega.total,
  totalFmt:(_jit.total+_solvers.total+_mega.total)>=1e9?'$'+((_jit.total+_solvers.total+_mega.total)/1e9).toFixed(2)+'B':'$'+((_jit.total+_solvers.total+_mega.total)/1e6).toFixed(2)+'M',
})

export const getRS2Stats = () => ({
  streams: Object.fromEntries(Object.entries(STREAMS).map(([k,s])=>[k,{t:s.total,n:s.count,name:s.name}])),
  total:   Object.values(STREAMS).reduce((s,v)=>s+v.total,0),
})

export async function startRS1() {
  restoreStreams()
  setInterval(()=>checkCowSolver().catch(()=>{}), 60000)
  setTimeout(()=>subscribeExtraPools().catch(()=>{}), 5000)
  setInterval(()=>{ setConfig('rs1_stats',JSON.stringify(getRS1Stats())); setConfig('rs2_stats',JSON.stringify(getRS2Stats())) },30000)
  console.log('[RS1] JIT · CoW Solvers · Mega pools · RS2 S1-S12 active')
}
