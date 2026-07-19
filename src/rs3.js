// Vanguard · rs3.js — Flash LP Yield + RS5 Broadcast
// Static imports: ONLY db.js · events.js

import { getConfig, setConfig } from './db.js'
import { emit, on }             from './events.js'

const _rs3 = {
  byProtocol: {},
  fromRS5:    parseFloat(getConfig('rs3_from_rs5')||'0'),
  total:      parseFloat(getConfig('rs3_total')||'0'),
}

const PROTOCOLS = {
  curve_3pool:    { chain:'ethereum', apy:12, tvl:500e6 },
  curve_steth:    { chain:'ethereum', apy:8,  tvl:200e6 },
  balancer_steth: { chain:'ethereum', apy:6,  tvl:300e6 },
  aero_usdc:      { chain:'base',     apy:15, tvl:80e6  },
  pcs_bnb:        { chain:'bnb',      apy:20, tvl:180e6 },
}

// RS5 broadcasts to RS3 tab
on('rs3_update', ({ source, amount }) => {
  if (source==='rs5'&&amount>0) {
    _rs3.fromRS5 += amount
    _rs3.total   += amount
    setConfig('rs3_from_rs5', _rs3.fromRS5.toFixed(2))
    setConfig('rs3_total',    _rs3.total.toFixed(2))
    emit('rs3_revenue', { source:'rs5_broadcast', amount })
  }
})

function recordYield(protocol, usd) {
  _rs3.byProtocol[protocol] = (_rs3.byProtocol[protocol]||0)+usd
  _rs3.total += usd
  setConfig('rs3_'+protocol, _rs3.byProtocol[protocol].toFixed(2))
  setConfig('rs3_total',     _rs3.total.toFixed(2))
  emit('rs3_revenue', { protocol, amount:usd })
}

async function harvestProtocol(key, proto) {
  if (getConfig('system_paused')==='1') return
  try {
    const { getContractAddr } = await import('./builders.js')
    if (!getContractAddr(proto.chain)) return
    const { getSABF64, SAB_OFFSETS, getPropProfile } = await import('./sdal.js')
    const HOT  = getSABF64()
    const p    = parseInt(HOT[SAB_OFFSETS.PROPELLER]||5)
    const prof = getPropProfile(p)
    const cap  = parseFloat(prof?.flashCap||'0')
    const flash= Math.min(proto.tvl*0.01, cap*0.1, 5e6)
    const profit=Math.floor(flash*(proto.apy/100)/365/7200*0.85)
    if (profit<10) return
    const { nexusRoute } = await import('./nexus.js')
    nexusRoute({ chain:proto.chain, type:'protocol_auction', profitEst:profit, flashRequired:flash, protocol:key, chainId:proto.chain==='ethereum'?1:proto.chain==='base'?8453:proto.chain==='bnb'?56:1 })
  } catch {}
}

async function refreshAPYs() {
  try {
    const r = await fetch('https://yields.llama.fi/pools',{signal:AbortSignal.timeout(8000)})
    if (!r.ok) return
    const {data}=await r.json()
    if (!Array.isArray(data)) return
    for (const p of data) {
      if (p.project==='curve-dex'&&p.symbol==='3Crv'&&p.apy) PROTOCOLS.curve_3pool.apy=Math.min(50,Math.max(0.1,p.apy))
      if (p.project==='curve-dex'&&p.symbol?.includes('stETH')&&p.apy) PROTOCOLS.curve_steth.apy=Math.min(50,Math.max(0.1,p.apy))
    }
  } catch {}
}

export const getRS3Stats = () => ({
  total:      _rs3.total,
  fromRS5:    _rs3.fromRS5,
  byProtocol: { ..._rs3.byProtocol },
  totalFmt:   _rs3.total>=1e9?'$'+(_rs3.total/1e9).toFixed(2)+'B':'$'+(_rs3.total/1e6).toFixed(2)+'M',
  protocols:  Object.entries(PROTOCOLS).map(([k,p])=>({key:k,chain:p.chain,apy:p.apy,tvl:p.tvl})),
})

export function startRS3Yield() {
  _rs3.fromRS5 = parseFloat(getConfig('rs3_from_rs5')||'0')
  _rs3.total   = parseFloat(getConfig('rs3_total')||'0')
  for (const key of Object.keys(PROTOCOLS)) _rs3.byProtocol[key]=parseFloat(getConfig('rs3_'+key)||'0')
  setInterval(async()=>{ for(const [k,p] of Object.entries(PROTOCOLS)) await harvestProtocol(k,p).catch(()=>{}) },12000)
  setInterval(()=>refreshAPYs().catch(()=>{}),3600000)
  setInterval(()=>setConfig('rs3_stats',JSON.stringify(getRS3Stats())),30000)
  refreshAPYs().catch(()=>{})
  console.log('[RS3] Flash LP yield: Curve + Balancer + Aerodrome + PancakeSwap · RS5 broadcast active')
}
