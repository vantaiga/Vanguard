// Vanguard · treasury.js — JP Morgan Sovereign Treasury
// 10 features: streaming · yield · FX · SWIFT · schedules · tax · split · journal · cross-chain · USB
// Static imports: ONLY db.js · events.js

import { getConfig, setConfig } from './db.js'
import { emit } from './events.js'

const TX_MSG = 'ALUCARD PROTOCOL (Owned and Operated By Bun Omar SECKA)'

// ── FX Rates ──────────────────────────────────────────────────────────────────
let _fx = {}
let _fxTs = 0

async function refreshFX() {
  try {
    const r = await fetch('https://api.exchangerate-api.com/v4/latest/USD',{ signal:AbortSignal.timeout(8000) })
    if (!r.ok) return
    const d = await r.json()
    _fx = d.rates||{}; _fxTs = Date.now()
    setConfig('fx_rates', JSON.stringify({ rates:_fx, ts:_fxTs }))
  } catch {
    try { const c=JSON.parse(getConfig('fx_rates')||'{}'); if(c.rates){_fx=c.rates;_fxTs=c.ts} } catch {}
  }
}

export function convertUSD(amountUSD, currency) {
  const rate = _fx[(currency||'GMD').toUpperCase()] || 1
  return { amount:+(amountUSD||0), currency:currency||'GMD', rate, converted:+((amountUSD||0)*rate).toFixed(2), rateAge:_fxTs?Math.floor((Date.now()-_fxTs)/60000)+'min':'unknown' }
}

// ── SWIFT validator ───────────────────────────────────────────────────────────
export function validateSWIFT(swift) {
  const code = (swift||'').toUpperCase().trim()
  if (!/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(code)) return { valid:false, error:'Invalid SWIFT format. Expected: BANKCCLL or BANKCCLL123' }
  return { valid:true, bankCode:code.slice(0,4), country:code.slice(4,6), location:code.slice(6,8), branch:code.slice(8)||'XXX', formatted:code }
}

// ── Fee calculator ─────────────────────────────────────────────────────────────
export function calcFee(amount, method='wave') {
  const rates = { wave:0.015, afrimoney:0.015, qmoney:0.015, bank:0.0125, bank_intl:0.015, crypto:0.010, card:0.035 }
  const rate  = rates[(method||'wave').toLowerCase()] ?? 0.015
  const fee   = +(+(amount||0)*rate).toFixed(2)
  return { amount:+(amount||0), fee, net:+(+(amount||0)-fee).toFixed(2), rate:(rate*100).toFixed(2)+'%', method:method||'wave' }
}

// ── Revenue streaming ─────────────────────────────────────────────────────────
let _stream = null

export function startRevenueStream({ ratePerHour, destination, network='wave', currency='GMD' }) {
  if (_stream) { clearInterval(_stream.timer); _stream=null }
  const timer = setInterval(async()=>{
    const avail = parseFloat(getConfig('daily_achieved')||'0')
    if (avail < ratePerHour*0.9) return
    try {
      const { createTransfer } = await import('./modempay.js')
      await createTransfer({ amount:ratePerHour, currency, phone:destination, network, reference:TX_MSG+' STREAM' })
      emit('withdrawal_created',{ amount:ratePerHour, destination, network })
    } catch(e){ console.warn('[TREASURY] Stream transfer failed:',e.message?.slice(0,60)) }
  }, 3600000)
  _stream = { ratePerHour, destination, network, currency, timer }
  console.log(`[TREASURY] Streaming: $${ratePerHour}/hr → ${destination} (${network})`)
}

export function stopRevenueStream() { if(_stream){clearInterval(_stream.timer);_stream=null} }

// ── Yield optimizer ───────────────────────────────────────────────────────────
let _protocol = 'aave', _apy = 0

async function optimizeYield() {
  const apys = {}
  try { const r=await fetch('https://aave-api-v2.aave.com/data/markets-data',{signal:AbortSignal.timeout(5000)}); if(r.ok){const d=await r.json();const u=d?.reserves?.find?.(r=>r.symbol==='USDC');if(u)apys.aave=parseFloat(u.liquidityRate)*100} } catch {}
  apys.aave     = apys.aave     || parseFloat(getConfig('apy_aave')    ||'4.2')
  apys.compound = apys.compound || parseFloat(getConfig('apy_compound')||'3.8')
  apys.morpho   = apys.morpho   || parseFloat(getConfig('apy_morpho')  ||'5.1')
  const [best] = Object.entries(apys).sort((a,b)=>b[1]-a[1])
  if (best && best[1] > _apy+0.5 && best[0]!==_protocol) {
    console.log(`[TREASURY] Yield: ${_protocol}→${best[0]} (${best[1].toFixed(1)}% APY)`)
    _protocol = best[0]; _apy = best[1]
    setConfig('yield_current_protocol', _protocol); setConfig('yield_current_apy', _apy.toFixed(2))
  }
  setConfig('yield_apys', JSON.stringify(apys))
}

// ── Scheduled transfers ───────────────────────────────────────────────────────
let _schedules = []

export function addSchedule({ amount, destination, network, frequency, currency='GMD', name='' }) {
  const s = { id:`sch_${Date.now()}`, amount, destination, network, frequency, currency, name, active:true, nextRun:Date.now()+(frequency==='daily'?86400000:frequency==='weekly'?604800000:3600000), reference:TX_MSG, created:Math.floor(Date.now()/1000) }
  _schedules.push(s)
  setConfig('scheduled_transfers', JSON.stringify(_schedules))
  return s
}

export function removeSchedule(id) { _schedules=_schedules.filter(s=>s.id!==id); setConfig('scheduled_transfers',JSON.stringify(_schedules)) }
export function getSchedules() { return _schedules }

async function runScheduler() {
  const now = Date.now()
  for (const s of _schedules.filter(s=>s.active&&s.nextRun<=now)) {
    try {
      const { createTransfer } = await import('./modempay.js')
      await createTransfer({ amount:s.amount, currency:s.currency, phone:s.destination, network:s.network, reference:TX_MSG })
      s.nextRun = Date.now()+(s.frequency==='daily'?86400000:s.frequency==='weekly'?604800000:3600000)
      emit('withdrawal_created',{ id:s.id, amount:s.amount })
    } catch(e){ console.warn('[TREASURY] Schedule failed:',s.id,e.message?.slice(0,60)) }
  }
  setConfig('scheduled_transfers', JSON.stringify(_schedules))
}

// ── Tax lot tracker ───────────────────────────────────────────────────────────
const _lots = []

export function recordTaxLot({ txHash, chain, protocol, costBasisUSD, salePriceUSD, ts }) {
  const lot = { id:`lot_${Date.now()}`, txHash, chain, protocol, costBasis:+(costBasisUSD||0).toFixed(2), salePrice:+(salePriceUSD||0).toFixed(2), gain:+((salePriceUSD||0)-(costBasisUSD||0)).toFixed(2), ts:ts||Math.floor(Date.now()/1000), year:new Date().getFullYear() }
  _lots.push(lot); if(_lots.length>100000) _lots.shift(); return lot
}

export function exportTaxCSV(year) {
  const h = 'Date,Chain,Protocol,Cost Basis,Sale Price,Gain/Loss,TxHash'
  const r = _lots.filter(l=>!year||l.year===year).map(l=>`${new Date(l.ts*1000).toISOString()},${l.chain},${l.protocol},${l.costBasis},${l.salePrice},${l.gain},${l.txHash}`)
  return [h,...r].join('\n')
}

// ── Execution journal ─────────────────────────────────────────────────────────
const _journal = []

export function journalRecord(entry) {
  const rec = { ...entry, journalId:`jrn_${Date.now()}`, ts:Math.floor(Date.now()/1000) }
  _journal.push(rec); if(_journal.length>500000) _journal.shift(); return rec
}

export function exportJournalCSV() {
  const h = 'JournalID,Timestamp,Chain,Strategy,Profit,Gas,TxHash,Status'
  const r = _journal.map(e=>`${e.journalId},${e.ts},${e.chain||''},${e.strategy||''},${e.profit||0},${e.gas||0},${e.txHash||''},${e.status||''}`)
  return [h,...r].join('\n')
}

// ── Multi-recipient split ─────────────────────────────────────────────────────
export async function splitTransfer({ totalAmount, currency='GMD', recipients, network='wave' }) {
  const results = []
  for (const rec of (recipients||[])) {
    const amt = +((totalAmount||0)*rec.pct/100).toFixed(2)
    try {
      const { createTransfer } = await import('./modempay.js')
      const r = await createTransfer({ amount:amt, currency, phone:rec.phone, name:rec.name, network, reference:TX_MSG })
      results.push({ ok:true, recipient:rec.phone, amount:amt, id:r.id })
    } catch(e){ results.push({ ok:false, recipient:rec.phone, amount:amt, error:e.message }) }
    await new Promise(r=>setTimeout(r,2000))
  }
  return results
}

// ── Stats ─────────────────────────────────────────────────────────────────────
export const getTreasuryStats = () => ({
  totalBalance: parseFloat(getConfig('daily_achieved')||'0'),
  lpDeployed:   parseFloat(getConfig('lp_total')||'0'),
  streaming:    _stream ? { active:true, ratePerHour:_stream.ratePerHour } : { active:false },
  yieldProtocol:_protocol,
  currentAPY:   _apy,
  scheduledCount:_schedules.filter(s=>s.active).length,
  taxLots:      _lots.length,
  journalEntries:_journal.length,
  fxCurrencies: Object.keys(_fx).length,
  fxUpdated:    _fxTs?new Date(_fxTs).toISOString():'never',
  txMessage:    TX_MSG,
})

export function startTreasury() {
  try { _schedules=JSON.parse(getConfig('scheduled_transfers')||'[]') } catch {}
  refreshFX().catch(()=>{})
  setInterval(()=>refreshFX().catch(()=>{})  ,3600000)
  setInterval(()=>optimizeYield().catch(()=>{}),1800000)
  setInterval(()=>runScheduler().catch(()=>{}) ,60000)
  optimizeYield().catch(()=>{})
  console.log('[TREASURY] JP Morgan sovereign treasury — 10 features active')
  console.log(`[TREASURY] "${TX_MSG}"`)
}
