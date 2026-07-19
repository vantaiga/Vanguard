// Vanguard · rs6.js — Cross-Chain Orderbook + V7 Token Buyback
// Static imports: ONLY db.js · sdal.js · events.js

import { getConfig, setConfig } from './db.js'
import { getV7, get as sdalGet } from './sdal.js'
import { emit, on }             from './events.js'

let _buybackAccum = 0
let _totalBurned  = parseFloat(getConfig('v7_total_burned')||'0')
const _orders     = new Map()

// V7 buyback: 1% of RS5+RS6 revenue → buy+burn
async function triggerBuyback(usd) {
  const v7 = getV7()
  if (!v7?.active) return
  _buybackAccum += usd * (v7.buybackPct||0.01)
  if (_buybackAccum < 1000) return
  console.log(`[RS6/V7] Buyback: $${(_buybackAccum/1000).toFixed(1)}K → burn`)
  _totalBurned  += _buybackAccum
  _buybackAccum  = 0
  setConfig('v7_total_burned', _totalBurned.toFixed(2))
  emit('rs6_revenue', { type:'v7_buyback', amount:_totalBurned })
}

on('rs5_revenue', ({ amount })=>{ if(amount>0) triggerBuyback(amount).catch(()=>{}) })

export function placeOrder(order) {
  const cfg = sdalGet('rs6_config')
  if (!cfg?.active) return { ok:false, message:'RS6 not active (Month 2)' }
  const id = `ord_${Date.now()}_${Math.random().toString(36).slice(2,8)}`
  _orders.set(id, { ...order, id, placed:Date.now(), status:'pending' })
  return { ok:true, orderId:id }
}

export function cancelOrder(id) { _orders.delete(id); return { ok:true } }

async function checkFills() {
  const cfg = sdalGet('rs6_config')
  if (!cfg?.active) return
  const prices = JSON.parse(getConfig('prices')||'{}')
  for (const [id, order] of _orders.entries()) {
    if (order.status!=='pending') continue
    const cur = parseFloat(prices[order.tokenOut]||'0')
    if (!cur) continue
    const met = order.side==='buy' ? cur<=order.limitPrice : cur>=order.limitPrice
    if (!met) continue
    order.status = 'filling'
    try {
      const { nexusRoute } = await import('./nexus.js')
      nexusRoute({ chain:order.chain||'arbitrum', type:'vault_arb', profitEst:Math.floor((order.amount||0)*0.0005), flashRequired:order.amount||0, chainId:42161 })
      order.status = 'filled'
      emit('rs6_revenue', { type:'order_filled', orderId:id })
    } catch { order.status='pending' }
  }
}

export const getRS6Stats = () => ({
  active:           sdalGet('rs6_config')?.active||false,
  v7Active:         getV7()?.active||false,
  pendingOrders:    [..._orders.values()].filter(o=>o.status==='pending').length,
  totalBurned:      _totalBurned,
  totalBurnedFmt:   _totalBurned>=1e9?'$'+(_totalBurned/1e9).toFixed(2)+'B':'$'+(_totalBurned/1e6).toFixed(2)+'M',
  buybackAccum:     _buybackAccum,
  activationNote:   'RS6 + V7 buyback activate Month 2 via SDAL update (rs6_config.active = true)',
})

export function startRS6() {
  if (sdalGet('rs6_config')?.active) setInterval(()=>checkFills().catch(()=>{}), 5000)
  console.log(`[RS6] Orderbook: ${sdalGet('rs6_config')?.active?'ACTIVE':'DORMANT (Month 2)'}`)
  console.log(`[RS6] V7 buyback: ${getV7()?.active?'ACTIVE':'DORMANT (Month 2)'}`)
}
