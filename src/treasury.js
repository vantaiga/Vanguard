// X7-SV — TREASURY ENGINE
// USDC sweep after every execution
// Modem Pay → Wave Mobile Money → GMD withdrawal
// Auto-withdraw toggle
// Exports: getAutoWithdraw, setAutoWithdraw, withdraw, manualWithdraw, startTreasury

import { getConfig, setConfig, recordWithdrawal } from './db.js'
import { getActiveChains, getChain } from './chains.js'
import { rpcCall } from './rpc.js'

// ─── AUTO-WITHDRAW STATE ──────────────────────────────────────────────────────

export function getAutoWithdraw() {
  return getConfig('auto_withdraw') === 'true'
}

export function setAutoWithdraw(val) {
  setConfig('auto_withdraw', val ? 'true' : 'false')
  return val
}

// ─── USDC SWEEP ───────────────────────────────────────────────────────────────

export async function sweepToUSDC(chainName, contractAddr) {
  try {
    const chain = getChain(chainName)
    if (!chain?.weth || !chain?.usdc) return

    const tokens = [chain.weth, chain.wbtc, chain.dai].filter(Boolean)
    if (!tokens.length) return

    const { buildAndSubmitBundle } = await import('./builders.js')
    const { encodeFunctionData, parseAbi } = await import('viem')

    const SWEEP_ABI = parseAbi([
      'function sweepToUSDC(address[] calldata tokens) external'
    ])

    const data = encodeFunctionData({
      abi: SWEEP_ABI,
      functionName: 'sweepToUSDC',
      args: [tokens]
    })

    await buildAndSubmitBundle(chainName, contractAddr, data, 0)
  } catch (e) {
    console.log('[TREASURY] sweep error: ' + e.message?.slice(0, 80))
  }
}

// ─── MODEM PAY WITHDRAWAL ─────────────────────────────────────────────────────

export async function manualWithdraw(amountUSDC) {
  if (!amountUSDC || Number(amountUSDC) <= 0) {
    throw new Error('Invalid withdrawal amount')
  }

  const key    = process.env.MODEM_PAY_SECRET_KEY
  const wave   = process.env.MODEM_PAY_WAVE_NUMBER
  const pubKey = process.env.MODEM_PAY_PUBLIC_KEY

  if (!key || !wave) {
    throw new Error('MODEM_PAY_SECRET_KEY and MODEM_PAY_WAVE_NUMBER required')
  }

  const amount = parseFloat(amountUSDC)
  const rate   = 570
  const gmd    = (amount * rate).toFixed(2)

  let txId = 'mp_' + Date.now()

  try {
    const resp = await fetch('https://api.modempay.com/v1/transfer', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'X-Public-Key':  pubKey || '',
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({
        amount:    amount,
        currency:  'USDC',
        recipient: wave,
        network:   'wave',
        reference: 'X7SV-' + Date.now()
      }),
      signal: AbortSignal.timeout(30000)
    })

    if (!resp.ok) {
      const errText = await resp.text().catch(() => resp.status.toString())
      throw new Error('Modem Pay API error: ' + errText.slice(0, 200))
    }

    const data = await resp.json()
    txId = data.id || data.transaction_id || txId
  } catch (e) {
    if (e.message?.startsWith('Modem Pay API error')) throw e
    console.log('[TREASURY] Modem Pay network error: ' + e.message?.slice(0, 100))
  }

  try {
    recordWithdrawal({
      usdcAmount: amount,
      gmdAmount:  parseFloat(gmd),
      status:     'completed',
      txId
    })
  } catch {}

  setConfig('last_withdrawal', JSON.stringify({
    amount, gmd, txId, ts: Date.now()
  }))

  const totalWithdrawn = parseFloat(getConfig('total_withdrawn') || '0') + amount
  setConfig('total_withdrawn', totalWithdrawn.toFixed(2))

  console.log('[TREASURY] Withdrawal: $' + amount + ' USDC → ' + gmd + ' GMD | txId: ' + txId)

  return { success: true, amount, gmd, txId }
}

// ─── WITHDRAW ALIAS ───────────────────────────────────────────────────────────

export async function withdraw(amount) {
  return manualWithdraw(amount)
}

// ─── TREASURY STATS ───────────────────────────────────────────────────────────

export function getTreasuryStats() {
  const totalRevenue   = parseFloat(getConfig('sv_total')       || '0')
  const totalWithdrawn = parseFloat(getConfig('total_withdrawn') || '0')
  const available      = Math.max(0, totalRevenue - totalWithdrawn)
  const autoWithdraw   = getAutoWithdraw()
  const lastWD         = JSON.parse(getConfig('last_withdrawal') || 'null')

  const byChain = {}
  try {
    const chains = getActiveChains()
    for (const chain of chains) {
      const profit = parseFloat(getConfig('chain_profit_' + chain.name) || '0')
      if (profit > 0) byChain[chain.name] = profit
    }
  } catch {}

  return {
    totalRevenue,
    totalWithdrawn,
    available,
    autoWithdraw,
    lastWithdrawal: lastWD,
    byChain
  }
}

// ─── RECORD CHAIN PROFIT ──────────────────────────────────────────────────────

export function recordChainProfit(chainName, profitUSDC) {
  if (!chainName || !profitUSDC || profitUSDC <= 0) return
  const key     = 'chain_profit_' + chainName
  const current = parseFloat(getConfig(key) || '0')
  setConfig(key, (current + profitUSDC).toFixed(4))
}

// ─── BROADCAST HELPER ─────────────────────────────────────────────────────────

function broadcastTreasury() {
  try {
    import('./dashboard.js').then(m => {
      const stats = getTreasuryStats()
      m.broadcast('treasury_update', stats)
    }).catch(() => {})
  } catch {}
}

// ─── START ────────────────────────────────────────────────────────────────────

export function startTreasury() {
  console.log('[TREASURY] USDC sweep + Modem Pay integration active')
  console.log('[TREASURY] Auto-withdraw: ' + (getAutoWithdraw() ? 'ON' : 'OFF'))

  setInterval(async () => {
    try {
      if (!getAutoWithdraw()) return

      const totalRevenue   = parseFloat(getConfig('sv_total')       || '0')
      const totalWithdrawn = parseFloat(getConfig('total_withdrawn') || '0')
      const available      = totalRevenue - totalWithdrawn

      if (available < 500) return

      const withdrawAmount = parseFloat((available * 0.3).toFixed(2))
      if (withdrawAmount < 1) return

      console.log('[TREASURY] Auto-withdraw triggered: $' + withdrawAmount)
      await manualWithdraw(withdrawAmount)
      broadcastTreasury()
    } catch (e) {
      console.log('[TREASURY] Auto-withdraw error: ' + e.message?.slice(0, 100))
    }
  }, 60000)

  setInterval(() => {
    broadcastTreasury()
  }, 30000)
  }
