// Vanguard · modempay.js — PAYMENT GATEWAY
// getModemPayStats() reads process.env.MODEMPAY_SECRET_KEY LIVE on every call
// Never stale. Never from DB. If sk_live_ prefix → LIVE.
// Static imports: ONLY vanguard.js

import { getConfig, setConfig, emit } from './vanguard.js'

const API    = 'https://api.modempay.com/v1'
const TX_REF = 'VANGUARD PROTOCOL (Owned and Operated By Bun Omar SECKA)'

function getKey() {
  return (process.env.MODEMPAY_SECRET_KEY ?? '').trim().replace(/^["']|["']$/g, '')
}

export function isConfigured() { return getKey().length > 0 }

const _calls = []

function checkRate() {
  const now = Date.now(), win = now - 900000
  while (_calls.length && _calls[0] < win) _calls.shift()
  if (_calls.length >= 95) throw new Error('Rate limit: 95 req/15min')
  _calls.push(now)
}

async function mpFetch(method, path, body) {
  const key = getKey()
  if (!key) throw new Error('MODEMPAY_SECRET_KEY not set')
  checkRate()
  const res = await fetch(API + path, {
    method,
    headers: {
      'Authorization':  `Bearer ${key}`,
      'Content-Type':   'application/json',
      'Accept':         'application/json',
    },
    body:   body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`ModemPay ${res.status}: ${data.message ?? data.error ?? 'error'}`)
  return data
}

export async function getBalance()               { return mpFetch('GET',  '/balances') }
export async function getTransferStatus(id)      { return mpFetch('GET',  `/transfers/${id}`) }
export async function listTransactions(limit=20) { return mpFetch('GET',  `/transactions?limit=${Math.min(limit,100)}`) }

export async function createTransfer({ amount, currency='GMD', phone, name, network='wave', reference }) {
  if (!amount || (+(amount ?? 0)) <= 0) throw new Error('amount must be positive')
  if (!phone) throw new Error('phone required')
  const result = await mpFetch('POST', '/transfers', {
    amount:           +(amount ?? 0),
    currency,
    account_number:   String(phone).trim(),
    network:          network.toLowerCase(),
    beneficiary_name: name ?? 'Vanguard User',
    reference:        reference ?? TX_REF,
  })
  const id = result.id ?? result.transfer_id ?? 'submitted'
  setConfig(`mp_tx_${Date.now()}`, JSON.stringify({
    id, amount, currency, phone, network,
    status: result.status ?? 'processing',
    ts:     Math.floor(Date.now() / 1000),
  }))
  emit('withdrawal_created', { id, amount, phone, network })
  return { ...result, id }
}

export function calcFee(amount, method = 'wave') {
  const rates = {
    wave:0.015, afrimoney:0.015, qmoney:0.015,
    bank:0.0125, bank_intl:0.015, crypto:0.010, card:0.035,
  }
  const rate = rates[(method ?? 'wave').toLowerCase()] ?? 0.015
  const fee  = +((+(amount ?? 0)) * rate).toFixed(2)
  return {
    amount: +(amount ?? 0),
    fee,
    net:    +(+(amount ?? 0) - fee).toFixed(2),
    rate:   (rate * 100).toFixed(2) + '%',
    method,
  }
}

export async function verifyWebhook(rawBody, signature) {
  const secret = process.env.MODEMPAY_WEBHOOK_SECRET
  if (!secret) return true
  const { createHmac } = await import('crypto')
  const expected = createHmac('sha512', secret).update(rawBody).digest('hex')
  return signature === expected || signature === `sha256=${expected}`
}

// LIVE — reads env on EVERY call — never cached, never stale
export function getModemPayStats() {
  const key    = getKey()
  const isLive = key.startsWith('sk_live_')
  const isTest = key.startsWith('sk_test_')
  return {
    configured:  key.length > 0,
    mode:        isLive ? 'LIVE' : isTest ? 'TEST' : key.length > 0 ? 'CONFIGURED' : 'NOT CONFIGURED',
    status:      isLive ? 'ACTIVE — LIVE' : isTest ? 'TEST MODE' : key.length > 0 ? 'ACTIVE' : 'ADD MODEMPAY_SECRET_KEY',
    keyHint:     key.length > 8 ? key.slice(0,4) + '...' + key.slice(-4) : key.length > 0 ? '***' : 'NOT SET',
    endpoint:    API,
    callsWindow: _calls.length,
    rateLimit:   '100 req/15min',
    networks:    ['wave','afrimoney','qmoney','bank','crypto'],
    fees:        { wave:'1.5%', afrimoney:'1.5%', qmoney:'1.5%', bank:'1.25%', crypto:'1.0%' },
    isLive,
    txRef:       TX_REF,
  }
}

export function startModemPay() {
  const s = getModemPayStats()
  if (s.isLive)      console.log(`[MODEMPAY] ACTIVE — LIVE endpoint: ${API}`)
  else if (s.configured) console.log(`[MODEMPAY] ${s.mode} — ${API}`)
  else               console.log('[MODEMPAY] Add MODEMPAY_SECRET_KEY to Railway Variables')
}
