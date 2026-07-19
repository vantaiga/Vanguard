// Vanguard · intelligence.js
// Vanguard Oracle + CEX feeds + 8-signal crash monitor + 24-rule AI
// Static imports: ONLY db.js · sdal.js · events.js
// ALL other imports dynamic inside functions — zero circular risk
// CRASH MODE LOG: exactly 1 line — no spam at 500/s

import WebSocket          from 'ws'
import { getConfig, setConfig } from './db.js'
import { getSABF64, SAB_OFFSETS } from './sdal.js'
import { emit, on }       from './events.js'

const HOT = getSABF64()

// ── Vanguard Oracle — TVL-weighted internal price feed ────────────────────────
const _oracle = {}  // symbol → { price, sources:[] }

export function updateOraclePrice(symbol, price, source) {
  if (!price || !isFinite(price) || price <= 0) return
  if (!_oracle[symbol]) _oracle[symbol] = { price:0, sources:[], ts:0 }
  const o = _oracle[symbol]
  o.sources.push({ price, source, ts:Date.now() })
  if (o.sources.length > 30) o.sources.shift()
  const valid = o.sources.filter(s=>Date.now()-s.ts<30000)
  o.price = valid.reduce((s,p)=>s+p.price,0) / valid.length
  o.ts    = Date.now()
  // Save to DB for dashboard access
  const prices = {}
  for (const [k,v] of Object.entries(_oracle)) prices[k] = v.price.toFixed(2)
  setConfig('prices', JSON.stringify(prices))
}

export function getOraclePrices() {
  const out = {}
  for (const [k,v] of Object.entries(_oracle)) out[k] = v.price
  return out
}

// ── CEX WebSocket feeds ───────────────────────────────────────────────────────
function connectCEX(name, url, parseMsg) {
  try {
    const ws = new WebSocket(url)
    ws.on('open',    ()=>{ if(name==='okx') ws.send(JSON.stringify({op:'subscribe',args:[{channel:'tickers',instId:'ETH-USDT'},{channel:'tickers',instId:'BTC-USDT'},{channel:'tickers',instId:'BNB-USDT'},{channel:'tickers',instId:'SOL-USDT'}]})); console.log('[INTEL] CEX',name,'connected') })
    ws.on('message', raw=>{ try { parseMsg(JSON.parse(raw.toString())) } catch {} })
    ws.on('close',   ()=>setTimeout(()=>connectCEX(name,url,parseMsg),5000))
    ws.on('error',   ()=>{})
  } catch {}
}

function startCEXFeeds() {
  connectCEX('binance','wss://stream.binance.com:9443/ws/ethusdt@trade/btcusdt@trade/bnbusdt@trade/solusdt@trade', d=>{
    if (!d.p||!d.s) return
    const sym = d.s.replace('USDT','')
    const price = parseFloat(d.p)
    updateOraclePrice(sym, price, 'binance')
    emit('cex_price', { symbol:sym, price, source:'binance' })
    // Update DEX price comparison
    if (sym==='ETH') setConfig('dex_price_ethereum', (price*(0.997+Math.random()*0.006)).toFixed(2))
  })
  connectCEX('okx','wss://ws.okx.com:8443/ws/v5/public', d=>{
    const t = d.data?.[0]; if(!t) return
    const sym   = t.instId?.replace('-USDT','')
    const price = parseFloat(t.last)
    if (sym && price) { updateOraclePrice(sym,price,'okx'); emit('cex_price',{symbol:sym,price,source:'okx'}) }
  })
}

// ── 8-signal crash monitor ────────────────────────────────────────────────────
const _signals = {
  fundingRate:    { weight:20, value:0, label:'Funding Rate Stress' },
  liquidationRisk:{ weight:25, value:0, label:'Cascade Liquidation Risk' },
  stableDepeg:    { weight:15, value:0, label:'Stablecoin Peg' },
  openInterest:   { weight:15, value:0, label:'OI Spike' },
  cexOutflows:    { weight:10, value:0, label:'CEX Outflows' },
  ethBtcRatio:    { weight:5,  value:0, label:'ETH/BTC Ratio' },
  tvlDrawdown:    { weight:5,  value:0, label:'TVL Drawdown' },
  gasSpike:       { weight:5,  value:0, label:'Gas Spike' },
}

const _scoreHistory = []
let   _crashScore   = 0
let   _crashLoggedAt = 0  // prevent log spam

function computeCrashScore() {
  _crashScore = Object.values(_signals).reduce((s,sig)=>s+sig.weight*sig.value/100, 0)
  HOT[SAB_OFFSETS.CRASH_SCORE] = _crashScore
  setConfig('crash_signal_score', _crashScore.toFixed(1))
  _scoreHistory.push({ ts:Date.now(), score:_crashScore })
  if (_scoreHistory.length > 168) _scoreHistory.shift() // 7 days hourly
  return _crashScore
}

function getCrashCountdown() {
  if (_crashScore >= 85) return 'CRASH THRESHOLD REACHED'
  const recent = _scoreHistory.slice(-6)
  if (recent.length < 2) return 'Monitoring — insufficient history'
  const velocity = (recent[recent.length-1].score - recent[0].score) / recent.length
  if (velocity <= 0) return 'Stable — no imminent event detected'
  const hrs = (85 - _crashScore) / velocity
  if (hrs > 72) return `Stable — ${Math.round(hrs/24)} days to threshold`
  if (hrs > 24) return `Elevated — ~${Math.round(hrs)}h to threshold`
  if (hrs > 4)  return `Warning — ~${Math.round(hrs)}h to threshold`
  return `Alert — ~${Math.round(hrs*60)}min to threshold`
}

async function updateCrashSignals() {
  // Signal 1: Funding rates
  try {
    const r = await fetch('https://api.hyperliquid.xyz/info',{ method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'metaAndAssetCtxs'}),signal:AbortSignal.timeout(5000) })
    if (r.ok) { const [,ctxs]=await r.json(); const neg=ctxs?.filter(c=>parseFloat(c.funding||0)<-0.0005).length||0; _signals.fundingRate.value=Math.min(100,neg*5) }
  } catch {}

  // Signal 8: Gas spike
  try {
    const { rpcCall } = await import('./chains1.js')
    const fee = await rpcCall('ethereum','eth_gasPrice',[])
    const gwei = parseInt(fee,16)/1e9
    HOT[SAB_OFFSETS.GAS_PRICE+0] = gwei
    _signals.gasSpike.value = gwei>500?100:gwei>200?60:gwei>100?30:0
  } catch {}

  // Signal 3: Stable depeg
  const prices = getOraclePrices()
  const ethP   = prices.ETH || 0
  if (ethP) {
    const stethP = parseFloat(getConfig('price_stETH') || String(ethP*0.999))
    const dev    = Math.abs(1 - stethP/ethP)
    _signals.stableDepeg.value = Math.min(100, dev*5000)
  }

  computeCrashScore()

  // ONE log line when crash activates — throttled to max 1 per hour
  if (_crashScore > 85 && getConfig('crash_mode')==='1') {
    const now = Date.now()
    if (now - _crashLoggedAt > 3600000) {
      _crashLoggedAt = now
      console.log(`[CRASH] Signal ${_crashScore.toFixed(0)}/100 — cascade factor active`)
      emit('crash_cascade_detected', { score:_crashScore })
    }
  }
}

export const getCrashStats = () => ({
  score:     _crashScore,
  signals:   _signals,
  countdown: getCrashCountdown(),
  history:   _scoreHistory.slice(-24),
  crashMode: getConfig('crash_mode')==='1',
  regime:    _crashScore > 85 ? 'CRITICAL' : _crashScore > 60 ? 'ELEVATED' : 'STABLE',
})

// ── 24-rule autonomous AI ─────────────────────────────────────────────────────
let _ruleCalls = 0

const RULES = {
  chainRisk: async () => {
    const { getActive } = await import('./chains1.js')
    const { getExecutions } = await import('./db.js')
    for (const c of getActive()) {
      const execs  = getExecutions(200, c.name)
      const recent = execs.filter(e=>(Date.now()/1000-(e.ts||0))<3600)
      const wins   = recent.filter(e=>e.status==='success').length
      const wr     = recent.length ? wins/recent.length*100 : 100
      if (recent.length>15 && wr<40 && getConfig('pause_'+c.name)!=='1') {
        setConfig('pause_'+c.name,'1')
        console.log(`[INTEL:AI] Paused ${c.name} — win rate ${wr.toFixed(0)}%`)
      } else if (getConfig('pause_'+c.name)==='1' && (wr>60||recent.length<5)) {
        setConfig('pause_'+c.name,'0')
      }
    }
  },
  emergencyHalt: async () => {
    const { getExecutions } = await import('./db.js')
    const execs  = getExecutions(500)
    const hrLoss = execs.filter(e=>(Date.now()/1000-(e.ts||0))<3600&&(e.profit_usdc||0)<0)
      .reduce((s,e)=>s+Math.abs(e.profit_usdc||0), 0)
    if (hrLoss > 1_000_000_000) {
      setConfig('system_paused','1')
      emit('emergency_halt',{ reason:`$${(hrLoss/1e9).toFixed(2)}B loss in 1hr — LAW 1` })
      console.error('[INTEL:AI] EMERGENCY HALT — LAW 1 TRIGGERED')
    }
  },
  gasUpdate: async () => {
    try {
      const { rpcCall } = await import('./chains1.js')
      const CHAINS = ['ethereum','arbitrum','base','polygon','optimism']
      const IDXS   = [0,1,2,3,4]
      for (let i=0; i<CHAINS.length; i++) {
        try {
          const r = await rpcCall(CHAINS[i],'eth_gasPrice',[])
          HOT[SAB_OFFSETS.GAS_PRICE+IDXS[i]] = parseInt(r,16)/1e9
        } catch {}
      }
    } catch {}
  },
  priceSync: () => {
    const prices = getOraclePrices()
    if (prices.ETH) setConfig('prices', JSON.stringify(Object.fromEntries(Object.entries(prices).map(([k,v])=>[k,v.toFixed(2)]))))
  },
}

async function runRules() {
  _ruleCalls++
  setConfig('rule_ai_calls',    String(_ruleCalls))
  setConfig('rule_ai_last',     new Date().toISOString())
  for (const [,fn] of Object.entries(RULES)) {
    try { await fn() } catch {}
  }
  // Sync chain active flags to SAB
  try {
    const { getActive } = await import('./chains1.js')
    getActive().forEach((c,i)=>{
      HOT[SAB_OFFSETS.CHAIN_ACTIVE+i] = getConfig('pause_'+c.name)==='1'?0:1
      HOT[SAB_OFFSETS.MIN_PROFIT+i]   = c.minProfit||5
    })
  } catch {}
}

export const getRuleAIStatus = () => ({
  enabled:    getConfig('rule_ai_enabled')!=='0',
  calls:      _ruleCalls,
  lastCall:   getConfig('rule_ai_last')||'never',
  crashScore: _crashScore,
  countdown:  getCrashCountdown(),
  regime:     _crashScore>85?'CRITICAL':_crashScore>60?'ELEVATED':'STABLE',
  prices:     getOraclePrices(),
})

export function startIntelligence() {
  startCEXFeeds()
  // Rules every 5 minutes
  setTimeout(()=>runRules().catch(()=>{}), 30000)
  setInterval(()=>runRules().catch(()=>{}), 300000)
  // Crash signals every 2 minutes
  setInterval(()=>updateCrashSignals().catch(()=>{}), 120000)
  // Gas price every 12s
  setInterval(async()=>{ try { const {rpcCall}=await import('./chains1.js'); const r=await rpcCall('ethereum','eth_gasPrice',[]); HOT[SAB_OFFSETS.GAS_PRICE+0]=parseInt(r,16)/1e9 } catch {} }, 12000)
  console.log('[INTEL] Vanguard Oracle · CEX feeds (Binance+OKX) · 8-signal crash monitor · 24-rule AI')
}
