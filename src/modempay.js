// Vanguard · modempay.js
// FIXED: accepts ANY key format from env var MODEMPAY_SECRET_KEY
// FIXED: mode detection via key prefix OR MODEMPAY_MODE env var override
// FIXED: account_number field (not phone) per ModemPay PHP SDK docs
// Source: https://packagist.org/packages/modempay/modempay-php

const MODEMPAY_LIVE = 'https://api.modempay.com/v1'
const MODEMPAY_TEST = 'https://api.test.modempay.com/v1'

// Key detection — your env var MODEMPAY_SECRET_KEY is read directly
function getKey()  { return process.env.MODEMPAY_SECRET_KEY || '' }

// Mode: check MODEMPAY_MODE override first, then key prefix
// If you have a live key that doesn't start with 'sk_live_',
// set MODEMPAY_MODE=live in Railway Variables
function isLive() {
  const override = process.env.MODEMPAY_MODE || ''
  if (override.toLowerCase() === 'live')  return true
  if (override.toLowerCase() === 'test')  return false
  const key = getKey()
  // Check common live key prefixes
  return key.startsWith('sk_live_') ||
         key.startsWith('mp_live_') ||
         key.startsWith('live_')    ||
         key.startsWith('pk_live_') ||
         key.length > 30  // any long key assumed live if no prefix match
}

function getBase()        { return isLive() ? MODEMPAY_LIVE : MODEMPAY_TEST }
function isConfigured()   { return !!getKey() }

// ── Rate limit tracking ───────────────────────────────────────────────────────
const _calls = []
function checkRate() {
  const now    = Date.now()
  const window = now - 15 * 60 * 1000
  while (_calls.length && _calls[0] < window) _calls.shift()
  if (_calls.length >= 95) throw new Error('ModemPay rate limit approaching (95/100 per 15min)')
  _calls.push(now)
}

async function mpFetch(method, path, body) {
  checkRate()
  const key = getKey()
  if (!key) throw new Error('MODEMPAY_SECRET_KEY not set in Railway Variables')

  const res = await fetch(getBase() + path, {
    method,
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
    body:   body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`ModemPay ${res.status}: ${data.message || data.error || JSON.stringify(data).slice(0,100)}`)
  }
  return data
}

// ── API Methods (per ModemPay PHP SDK) ────────────────────────────────────────

export async function getBalance() {
  return mpFetch('GET', '/balances')
}

// Transfer per PHP SDK: account_number, network, beneficiary_name, amount, currency
export async function createTransfer({ amount, currency='GMD', phone, name, network='wave', reference }) {
  if (!amount || amount <= 0) throw new Error('Invalid amount')
  if (!phone) throw new Error('account_number (phone) required')

  const body = {
    amount,
    currency,
    account_number:  phone,
    network:         network.toLowerCase(),
    beneficiary_name:name || 'Vanguard User',
    reference:       reference || `vng_${Date.now()}`,
  }

  const result = await mpFetch('POST', '/transfers', body)
  console.log(`[MODEMPAY] Transfer: ${amount} ${currency} → ${phone} via ${network} (${result.id || 'queued'})`)
  return result
}

export async function getTransferStatus(id) {
  return mpFetch('GET', `/transfers/${id}`)
}

export async function listTransactions(limit=20) {
  return mpFetch('GET', `/transactions?limit=${limit}`)
}

export async function createPaymentIntent({ amount, currency='GMD', customerPhone, customerName }) {
  return mpFetch('POST', '/payment-intents', {
    amount, currency,
    customer: { phone: customerPhone, name: customerName }
  })
}

// ── Fee calculator ────────────────────────────────────────────────────────────
export function calcFee(amount, method='wave') {
  const rates = { wave:0.015, afrimoney:0.015, qmoney:0.015, bank:0.0125, crypto:0.01, card:0.035 }
  const rate  = rates[method.toLowerCase()] || 0.015
  const fee   = amount * rate
  return { amount, fee:+fee.toFixed(2), net:+(amount-fee).toFixed(2), rate:(rate*100)+'%' }
}

// ── Webhook verification ──────────────────────────────────────────────────────
export async function verifyWebhook(rawBody, signature) {
  const secret = process.env.MODEMPAY_WEBHOOK_SECRET
  if (!secret) return true
  const crypto   = await import('crypto')
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  return signature === `sha256=${expected}` || signature === expected
}

// ── Withdrawal queue ──────────────────────────────────────────────────────────
const _queue = []
let   _processing = false

export function queueWithdrawal(req) {
  _queue.push({ ...req, queuedAt: Date.now() })
  console.log(`[MODEMPAY] Queued: $${req.amount} → ${req.phone}`)
  if (!_processing) processQueue()
}

async function processQueue() {
  if (_processing || !_queue.length) return
  _processing = true
  try {
    while (_queue.length) {
      const req = _queue.shift()
      try { await createTransfer(req) }
      catch(e) { console.error('[MODEMPAY] Queue transfer failed:', e.message) }
      if (_queue.length) await new Promise(r => setTimeout(r, 10000))
    }
  } finally { _processing = false }
}

// ── Stats ─────────────────────────────────────────────────────────────────────
export function getModemPayStats() {
  const key  = getKey()
  const live = isLive()
  return {
    configured:    isConfigured(),
    mode:          live ? 'LIVE' : 'TEST',
    keyPrefix:     key ? (key.slice(0,8)+'...') : 'NOT SET',
    envVar:        'MODEMPAY_SECRET_KEY',
    modeOverride:  process.env.MODEMPAY_MODE || 'auto-detect',
    queueLength:   _queue.length,
    callsWindow:   _calls.length,
    rateLimit:     '100 req / 15min',
    base:          getBase(),
    networks: ['wave','afrimoney','qmoney','bank','crypto'],
    fees: { wave:'1.5%', afrimoney:'1.5%', qmoney:'1.5%', bank:'1.25%', crypto:'1.0%' }
  }
}

// ── Express routes ────────────────────────────────────────────────────────────
export function registerModemPayRoutes(app) {
  app.post('/api/modempay/withdraw', async (req, res) => {
    const { amount, phone, name, network, currency } = req.body || {}
    if (!amount || !phone) return res.status(400).json({ error:'amount and phone required' })
    if (parseFloat(amount) <= 0) return res.status(400).json({ error:'Invalid amount' })
    try {
      const fee = calcFee(parseFloat(amount), network || 'wave')
      if (!isConfigured()) {
        queueWithdrawal({ amount:parseFloat(amount), currency:currency||'GMD', phone, name, network:network||'wave' })
        return res.json({ ok:true, status:'queued', fee, message:'Queued — add MODEMPAY_SECRET_KEY to Railway Variables' })
      }
      const result = await createTransfer({
        amount:   parseFloat(amount),
        currency: currency || 'GMD',
        phone, name,
        network:  network || 'wave',
        reference:`vng_${Date.now()}`
      })
      res.json({ ok:true, status:result.status||'submitted', transferId:result.id, fee })
    } catch(e) {
      console.error('[MODEMPAY] Withdraw error:', e.message)
      res.status(500).json({ error: e.message })
    }
  })

  app.get('/api/modempay/balance', async (_, res) => {
    if (!isConfigured()) return res.json({ configured:false, message:'Add MODEMPAY_SECRET_KEY to Railway Variables' })
    try { res.json(await getBalance()) }
    catch(e) { res.status(500).json({ error:e.message }) }
  })

  app.get('/api/modempay/transactions', async (_, res) => {
    if (!isConfigured()) return res.json({ configured:false, transactions:[] })
    try { res.json(await listTransactions(20)) }
    catch(e) { res.status(500).json({ error:e.message }) }
  })

  app.get('/api/modempay/status/:id', async (req, res) => {
    try { res.json(await getTransferStatus(req.params.id)) }
    catch(e) { res.status(500).json({ error:e.message }) }
  })

  app.get('/api/modempay/fee', (req, res) => {
    const { amount, method } = req.query
    if (!amount) return res.status(400).json({ error:'amount required' })
    res.json(calcFee(parseFloat(amount), method || 'wave'))
  })

  app.post('/api/modempay/webhook', async (req, res) => {
    const sig = req.headers['x-modempay-signature'] || ''
    const raw = JSON.stringify(req.body)
    if (!await verifyWebhook(raw, sig)) return res.status(401).json({ error:'Invalid signature' })
    res.json({ received: true })
    const { type, data } = req.body
    console.log(`[MODEMPAY] Webhook: ${type}`)
    if (type === 'transfer.succeeded') emit('withdrawal_completed', { transferId:data?.id })
    if (type === 'transfer.failed')    emit('withdrawal_failed',    { transferId:data?.id, error:data?.failure_reason })
  })

  app.get('/api/modempay/stats', (_, res) => res.json(getModemPayStats()))

  console.log('[MODEMPAY] Routes: /api/modempay/{withdraw,balance,transactions,fee,status,webhook,stats}')
}

export function startModemPay() {
  const stats = getModemPayStats()
  if (stats.configured) {
    console.log(`[MODEMPAY] ${stats.mode} mode — key: ${stats.keyPrefix}`)
    if (!isLive()) {
      console.log('[MODEMPAY] To force LIVE mode: add MODEMPAY_MODE=live to Railway Variables')
    }
  } else {
    console.log('[MODEMPAY] Not configured — add MODEMPAY_SECRET_KEY to Railway Variables')
  }
  console.log('[MODEMPAY] Networks: Wave · Afrimoney · QMoney · Bank · Crypto')
}

import { emit } from './events.js'
