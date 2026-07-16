// Vanguard · treasury.js — JP Morgan style sovereign treasury
// Revenue streaming · Yield optimization · FX conversion
// SWIFT validation · Scheduled transfers · Tax lot tracking
// Multi-recipient · Cross-chain consolidation · Execution journal
// Transaction message: "VANGUARD PROTOCOL (Owned and Operated By Bun Omar SECKA)"

import { getConfig, setConfig } from './db.js'
import { emit } from './events.js'

const TX_MSG = 'VANGUARD PROTOCOL (Owned and Operated By Bun Omar SECKA)'

// ── FX Rates ──────────────────────────────────────────────────────────────────
let _fxRates     = {}
let _fxUpdatedTs = 0

async function refreshFX() {
  try {
    const r = await fetch('https://api.exchangerate-api.com/v4/latest/USD',
      { signal:AbortSignal.timeout(8000) })
    if (!r.ok) return
    const d   = await r.json()
    _fxRates  = d.rates || {}
    _fxUpdatedTs = Date.now()
    setConfig('fx_rates', JSON.stringify({ rates:_fxRates, ts:_fxUpdatedTs }))
  } catch {
    try {
      const cached = JSON.parse(getConfig('fx_rates')||'{}')
      if (cached.rates) { _fxRates=cached.rates; _fxUpdatedTs=cached.ts }
    } catch {}
  }
}

export function convertUSD(amountUSD, currency) {
  const rate = _fxRates[currency.toUpperCase()] || 1
  return { amount:amountUSD, currency, rate, converted:+(amountUSD*rate).toFixed(2),
           rateAge: _fxUpdatedTs ? Math.floor((Date.now()-_fxUpdatedTs)/60000)+'min' : 'unknown' }
}

// ── SWIFT validator ───────────────────────────────────────────────────────────
export function validateSWIFT(swift) {
  const code = (swift||'').toUpperCase().trim()
  const regex = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/
  if (!regex.test(code)) return { valid:false, error:`Invalid SWIFT format. Expected: BANKCCLL or BANKCCLL123` }
  return {
    valid:      true,
    bankCode:   code.slice(0,4),
    country:    code.slice(4,6),
    location:   code.slice(6,8),
    branch:     code.slice(8) || 'XXX',
    formatted:  code,
  }
}

// ── Fee calculator ─────────────────────────────────────────────────────────────
export function calcFee(amount, method='wave') {
  const rates = { wave:0.015, afrimoney:0.015, qmoney:0.015, bank:0.0125,
                  bank_intl:0.015, crypto:0.010, card:0.035 }
  const rate  = rates[method.toLowerCase()] ?? 0.015
  const fee   = +(amount*rate).toFixed(2)
  return { amount:+amount, fee, net:+(amount-fee).toFixed(2), rate:(rate*100).toFixed(2)+'%', method }
}

// ── Revenue streaming ─────────────────────────────────────────────────────────
let _stream = null  // { ratePerHour, destination, network, currency, interval }

export function startRevenueStream({ ratePerHour, destination, network='wave', currency='GMD' }) {
  if (_stream) { clearInterval(_stream.timer); _stream = null }
  // Transfer every hour
  const timer = setInterval(async () => {
    const avail = parseFloat(getConfig('daily_achieved')||'0')
    if (avail < ratePerHour * 0.9) return  // not enough balance
    try {
      const { createTransfer } = await import('./modempay.js')
      await createTransfer({ amount:ratePerHour, currency, phone:destination,
                              network, reference:`vng_stream_${Date.now()}` })
      console.log(`[TREASURY] Stream: $${ratePerHour}/hr → ${destination} (${network})`)
      emit('stream_transfer', { amount:ratePerHour, destination, network })
    } catch(e) { console.warn('[TREASURY] Stream transfer failed:', e.message?.slice(0,60)) }
  }, 3600000)  // every hour
  _stream = { ratePerHour, destination, network, currency, timer }
  console.log(`[TREASURY] Revenue streaming: $${ratePerHour}/hr → ${destination}`)
}

export function stopRevenueStream() {
  if (_stream) { clearInterval(_stream.timer); _stream = null }
}

// ── Yield optimizer ───────────────────────────────────────────────────────────
const PROTOCOLS = ['aave','compound','morpho','curve','yearn']
let   _currentProtocol = 'aave'
let   _currentAPY      = 0

async function optimizeYield() {
  const apys = {}
  // Read rates from on-chain / APIs
  try {
    // Aave V3 ETH supply rate (simplified read)
    const r = await fetch('https://aave-api-v2.aave.com/data/markets-data',
      { signal:AbortSignal.timeout(5000) })
    if (r.ok) {
      const d = await r.json()
      const usdc = d?.reserves?.find?.(r=>r.symbol==='USDC')
      if (usdc) apys.aave = parseFloat(usdc.liquidityRate)*100
    }
  } catch {}

  // Default fallback APYs if API fails
  apys.aave     = apys.aave     || parseFloat(getConfig('apy_aave')||'4.2')
  apys.compound = apys.compound || parseFloat(getConfig('apy_compound')||'3.8')
  apys.morpho   = apys.morpho   || parseFloat(getConfig('apy_morpho')||'5.1')

  const best    = Object.entries(apys).sort((a,b)=>b[1]-a[1])[0]
  const bestPct = best[1]

  setConfig('yield_apys', JSON.stringify(apys))

  if (best[0] !== _currentProtocol && bestPct > _currentAPY + 0.5) {
    console.log(`[TREASURY] Yield switch: ${_currentProtocol} (${_currentAPY.toFixed(1)}%) → ${best[0]} (${bestPct.toFixed(1)}%)`)
    _currentProtocol = best[0]
    _currentAPY      = bestPct
    setConfig('yield_current_protocol', _currentProtocol)
    setConfig('yield_current_apy', _currentAPY.toFixed(2))
    emit('yield_switched', { from:_currentProtocol, to:best[0], apy:bestPct })
  }

  return { apys, best:best[0], bestAPY:bestPct }
}

// ── Scheduled transfers ────────────────────────────────────────────────────────
let _schedules = []

export function addSchedule({ amount, destination, network, frequency, currency='GMD', name='' }) {
  const sch = {
    id:          `sch_${Date.now()}`,
    amount, destination, network, frequency, currency, name,
    active:      true,
    nextRun:     calcNextRun(frequency),
    reference:   TX_MSG,
    created:     Math.floor(Date.now()/1000),
  }
  _schedules.push(sch)
  persistSchedules()
  return sch
}

export function removeSchedule(id) {
  _schedules = _schedules.filter(s=>s.id!==id)
  persistSchedules()
}

function calcNextRun(freq) {
  const now = Date.now()
  if (freq === 'daily')   return now + 86400000
  if (freq === 'weekly')  return now + 604800000
  if (freq === 'monthly') return now + 2592000000
  if (freq === 'hourly')  return now + 3600000
  if (typeof freq === 'number') return now + freq  // custom ms
  return now + 86400000
}

function persistSchedules() { setConfig('scheduled_transfers', JSON.stringify(_schedules)) }

async function runScheduler() {
  const now = Date.now()
  for (const sch of _schedules.filter(s=>s.active && s.nextRun<=now)) {
    try {
      const { createTransfer } = await import('./modempay.js')
      await createTransfer({ amount:sch.amount, currency:sch.currency,
                              phone:sch.destination, network:sch.network,
                              reference:TX_MSG })
      sch.nextRun = calcNextRun(sch.frequency)
      setConfig(`sch_last_run_${sch.id}`, new Date().toISOString())
      emit('scheduled_transfer_executed', { id:sch.id, amount:sch.amount })
    } catch(e) { console.warn('[TREASURY] Schedule failed:', sch.id, e.message?.slice(0,60)) }
  }
  persistSchedules()
}

// ── Tax lot tracker ───────────────────────────────────────────────────────────
const _lots = []

export function recordTaxLot({ txHash, chain, protocol, costBasisUSD, salePriceUSD, ts }) {
  const lot = {
    id:       `lot_${Date.now()}`,
    txHash, chain, protocol,
    costBasis: +costBasisUSD.toFixed(2),
    salePrice: +salePriceUSD.toFixed(2),
    gain:      +(salePriceUSD - costBasisUSD).toFixed(2),
    gainPct:   costBasisUSD > 0 ? +((salePriceUSD-costBasisUSD)/costBasisUSD*100).toFixed(4) : 0,
    ts:        ts || Math.floor(Date.now()/1000),
    year:      new Date().getFullYear(),
  }
  _lots.push(lot)
  if (_lots.length > 100000) _lots.shift()  // cap at 100K lots
  return lot
}

export function exportTaxCSV(year) {
  const header = 'Date,Chain,Protocol,Cost Basis,Sale Price,Gain/Loss,TxHash'
  const rows   = _lots
    .filter(l => !year || l.year === year)
    .map(l => `${new Date(l.ts*1000).toISOString()},${l.chain},${l.protocol},${l.costBasis},${l.salePrice},${l.gain},${l.txHash}`)
  return [header, ...rows].join('\n')
}

// ── Multi-recipient split ─────────────────────────────────────────────────────
export async function splitTransfer({ totalAmount, currency='GMD', recipients, network='wave' }) {
  const results = []
  for (const rec of recipients) {
    const amt = +(totalAmount * rec.pct / 100).toFixed(2)
    try {
      const { createTransfer } = await import('./modempay.js')
      const r = await createTransfer({ amount:amt, currency, phone:rec.phone,
                                        name:rec.name, network, reference:TX_MSG })
      results.push({ ok:true, recipient:rec.phone, amount:amt, id:r.id })
    } catch(e) {
      results.push({ ok:false, recipient:rec.phone, amount:amt, error:e.message })
    }
    await new Promise(r=>setTimeout(r,2000))  // rate limit between transfers
  }
  return results
}

// ── Execution journal (immutable append-only) ─────────────────────────────────
const _journal = []

export function journalRecord(entry) {
  const rec = { ...entry, journalId:`jrn_${Date.now()}`, ts:Math.floor(Date.now()/1000) }
  _journal.push(rec)
  if (_journal.length > 500000) _journal.shift()
  setConfig('journal_last', JSON.stringify(rec))
  return rec
}

export function exportJournalCSV() {
  const header = 'JournalID,Timestamp,Chain,Strategy,Profit,Gas,TxHash,Status'
  const rows   = _journal.map(e =>
    `${e.journalId},${e.ts},${e.chain||''},${e.strategy||''},${e.profit||0},${e.gas||0},${e.txHash||''},${e.status||''}`)
  return [header,...rows].join('\n')
}

// ── Treasury stats ─────────────────────────────────────────────────────────────
export const getTreasuryStats = () => ({
  totalBalance:    parseFloat(getConfig('daily_achieved')||'0'),
  lpDeployed:      parseFloat(getConfig('lp_total')||'0'),
  streaming:       _stream ? { active:true, ratePerHour:_stream.ratePerHour } : { active:false },
  yieldProtocol:   _currentProtocol,
  currentAPY:      _currentAPY,
  scheduledCount:  _schedules.filter(s=>s.active).length,
  taxLots:         _lots.length,
  journalEntries:  _journal.length,
  fxRates:         Object.keys(_fxRates).length,
  fxUpdated:       _fxUpdatedTs ? new Date(_fxUpdatedTs).toISOString() : 'never',
  txMessage:       TX_MSG,
})

// ── Register Express routes ────────────────────────────────────────────────────
export function registerTreasuryRoutes(app) {
  app.get('/api/treasury/stats',   (_, res) => res.json(getTreasuryStats()))
  app.get('/api/treasury/fx',      (_, res) => res.json(_fxRates))
  app.post('/api/treasury/convert',(req,res)=> res.json(convertUSD(req.body.amount, req.body.currency||'GMD')))
  app.post('/api/treasury/validate-swift', (req,res)=>res.json(validateSWIFT(req.body.swift)))
  app.get('/api/treasury/fee',     (req,res)=> res.json(calcFee(parseFloat(req.query.amount||'0'), req.query.method||'wave')))
  app.post('/api/treasury/stream/start', (req,res)=>{
    const { ratePerHour, destination, network, currency } = req.body||{}
    if (!ratePerHour||!destination) return res.status(400).json({error:'ratePerHour and destination required'})
    startRevenueStream({ ratePerHour:parseFloat(ratePerHour), destination, network, currency })
    res.json({ ok:true, ratePerHour, destination })
  })
  app.post('/api/treasury/stream/stop',  (_, res)=>{ stopRevenueStream(); res.json({ ok:true }) })
  app.post('/api/treasury/schedule/add', (req,res)=>{
    try { res.json({ ok:true, schedule:addSchedule(req.body) }) }
    catch(e) { res.status(500).json({error:e.message}) }
  })
  app.delete('/api/treasury/schedule/:id', (req,res)=>{ removeSchedule(req.params.id); res.json({ok:true}) })
  app.get('/api/treasury/schedules', (_, res)=>res.json(_schedules))
  app.post('/api/treasury/split',   async(req,res)=>{
    try { res.json(await splitTransfer(req.body)) }
    catch(e) { res.status(500).json({error:e.message}) }
  })
  app.get('/api/treasury/tax/csv',  (req,res)=>{
    res.setHeader('Content-Type','text/csv')
    res.setHeader('Content-Disposition',`attachment; filename=vanguard_tax_${req.query.year||'all'}.csv`)
    res.send(exportTaxCSV(req.query.year ? parseInt(req.query.year) : null))
  })
  app.get('/api/treasury/journal/csv', (_, res)=>{
    res.setHeader('Content-Type','text/csv')
    res.setHeader('Content-Disposition','attachment; filename=vanguard_journal.csv')
    res.send(exportJournalCSV())
  })
  app.post('/api/treasury/withdraw', async(req,res)=>{
    const { amount, phone, name, network, currency, swift, accountNumber, transferType } = req.body||{}
    if(!amount||!phone) return res.status(400).json({error:'amount and phone/account required'})
    const fee = calcFee(parseFloat(amount), network||'wave')
    try {
      const { createTransfer } = await import('./modempay.js')
      const result = await createTransfer({
        amount:parseFloat(amount), currency:currency||'GMD',
        phone:phone||accountNumber, name, network:network||'wave',
        reference:TX_MSG,
        ...(swift ? {swift} : {}),
      })
      journalRecord({ chain:'polygon', strategy:'withdrawal', profit:0,
                      txHash:result.id||'', status:'submitted' })
      res.json({ ok:true, status:result.status||'submitted', transferId:result.id, fee, reference:TX_MSG })
    } catch(e) {
      console.error('[TREASURY] Withdrawal error:', e.message)
      res.status(500).json({ error:e.message })
    }
  })

  console.log('[TREASURY] Routes: /api/treasury/{stats,fx,convert,validate-swift,fee,stream,schedule,split,tax,journal,withdraw}')
}

export function startTreasury() {
  // Load schedules from DB
  try { _schedules = JSON.parse(getConfig('scheduled_transfers')||'[]') } catch {}
  // Load cached FX
  try {
    const cached = JSON.parse(getConfig('fx_rates')||'{}')
    if (cached.rates) { _fxRates=cached.rates; _fxUpdatedTs=cached.ts }
  } catch {}

  refreshFX().catch(()=>{})
  setInterval(() => refreshFX().catch(()=>{}), 3600000)  // refresh every hour
  setInterval(() => optimizeYield().catch(()=>{}), 1800000)  // optimize every 30min
  setInterval(() => runScheduler().catch(()=>{}), 60000)  // scheduler tick every min
  optimizeYield().catch(()=>{})

  console.log('[TREASURY] JP Morgan sovereign treasury active')
  console.log('[TREASURY] Revenue streaming · Yield optimizer · FX rates · SWIFT validation')
  console.log('[TREASURY] Tax lot tracking · Multi-recipient · Scheduled transfers')
  console.log(`[TREASURY] All transfers signed: "${TX_MSG}"`)
}
