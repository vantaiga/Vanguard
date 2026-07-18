// Vanguard · vanguard_vaults.js — RPC + 10 Strategic Vaults
// FIXED: imports from builders.js not pimlico.js
// All pimlico functions come from builders.js
// Lazy imports for chains1.js and nexus.js — no circular risk

import { getConfig, setConfig, recordExecution } from './db.js'
import { emit, on }                              from './events.js'
import { getSABF64, SAB_OFFSETS }                from './sdal.js'

const HOT = getSABF64()

// ── 10 Strategic Vaults ───────────────────────────────────────────────────────
const SV = {}
const SV_LABELS = { sv1:'Velocity Arb',sv2:'Cascade Arb',sv3:'Cross-Chain',sv4:'Backrun',sv5:'JIT-LP',sv6:'Sandwich',sv7:'Stable Arb',sv8:'LP Snipe',sv9:'Derivatives',sv10:'Protocol Flow' }
for (const k of ['sv1','sv2','sv3','sv4','sv5','sv6','sv7','sv8','sv9','sv10']) {
  SV[k] = { total: parseFloat(getConfig(k+'_total')||'0'), count: 0, label: SV_LABELS[k] }
}

export const getSVStats = () => ({
  sv: SV,
  total: Object.values(SV).reduce((s,v)=>s+v.total,0),
  count: Object.values(SV).reduce((s,v)=>s+v.count,0),
})

// ── Execute arb via NEXUS → APEX ──────────────────────────────────────────────
const _busy = {}

export async function executeArb(chainName, svKey, opp) {
  if (getConfig('system_paused') === '1') return null
  if (getConfig('pause_'+chainName) === '1') return null
  const key = chainName + svKey
  if (_busy[key]) return null
  _busy[key] = true

  try {
    // Lazy import — no circular at parse time
    const { nexusRoute, recordRevenue } = await import('./nexus.js')
    const { getContractAddr }           = await import('./builders.js')

    if (!getContractAddr(chainName)) return null

    const decision = nexusRoute({
      chain:         chainName,
      type:          svKey,
      profitEst:     opp.estimatedProfit || 0,
      flashRequired: opp.flashAmountWei ? Number(opp.flashAmountWei) / 1e6 : 0,
      calldata:      opp.calldata || '',
      chainId:       opp.chainId  || 1,
    })

    if (!decision) return null

    const { apexExecute } = await import('./apex.js')
    const txHash = await apexExecute(decision)
    if (!txHash) return null

    SV[svKey].total += opp.estimatedProfit || 0
    SV[svKey].count++
    setConfig(svKey+'_total', SV[svKey].total.toFixed(2))
    recordExecution({ txHash, chain:chainName, protocol:svKey, profitUsdc:opp.estimatedProfit||0, status:'success' })
    recordRevenue(opp.estimatedProfit || 0)
    emit('sv_update', { key:svKey, profit:opp.estimatedProfit, chain:chainName })
    return txHash
  } finally {
    _busy[key] = false
  }
}

// ── Replay overlay queue post-deploy ─────────────────────────────────────────
export async function replayQueue(chainName) {
  const { overlayPending, replayChain } = await import('./overlay.js')
  const { nexusRoute }                  = await import('./nexus.js')
  const { apexExecute }                 = await import('./apex.js')

  const pending = overlayPending(chainName)
  if (!pending.length) return 0

  console.log(`[VAULTS] Replaying ${pending.length} queued swaps on ${chainName}`)

  return replayChain(chainName, async entry => {
    const decision = nexusRoute({
      chain:         chainName,
      type:          'vault_arb',
      profitEst:     entry.profitEst || 0,
      flashRequired: entry.flash     || 0,
      calldata:      entry.calldata  || '',
      chainId:       entry.chainId   || 1,
    })
    if (!decision) return null
    return apexExecute(decision)
  })
}

// ── Periodic arb — tier-1 chains every 2s ────────────────────────────────────
async function periodicArb() {
  if (getConfig('system_paused') === '1') return
  const { getActive, rpcCall }  = await import('./chains1.js')
  const { getContractAddr }     = await import('./builders.js')
  const { nexusRoute }          = await import('./nexus.js')

  const prices = JSON.parse(getConfig('prices') || '{}')
  const eth    = parseFloat(prices.ETH || '0')
  if (!eth) return

  for (const c of getActive().filter(x => x.tier === 1)) {
    if (!getContractAddr(c.name)) continue
    if (getConfig('pause_'+c.name) === '1') continue
    const dex = parseFloat(getConfig('dex_price_'+c.name) || '0')
    if (!dex) continue
    const gap = Math.abs(eth - dex) / dex * 100
    if (gap < 0.05) continue
    const flash     = Math.min(500000, gap * 50000)
    const profitEst = Math.floor(flash * (gap - 0.05) / 100)
    if (profitEst < (c.minProfit || 5)) continue
    nexusRoute({ chain:c.name, type:'vault_arb', profitEst, flashRequired:flash, chainId:c.id||1 })
  }
}

// ── Block number ──────────────────────────────────────────────────────────────
export async function getBlock(chainName) {
  try {
    const { rpcCall } = await import('./chains1.js')
    return parseInt(await rpcCall(chainName, 'eth_blockNumber', []), 16)
  } catch { return 0 }
}

// ── Events ────────────────────────────────────────────────────────────────────
on('deploy_success', ({ chain }) => {
  const size = parseInt(getConfig('overlay_queue_size') || '0')
  if (size > 0) {
    console.log(`[VAULTS] ${chain} deployed — replaying ${size} queued swaps`)
    setTimeout(() => replayQueue(chain).catch(() => {}), 1000)
  }
})

// ── Start ─────────────────────────────────────────────────────────────────────
export function startVaults() {
  setInterval(() => periodicArb().catch(() => {}), 2000)
  setInterval(() => setConfig('sv_stats', JSON.stringify(getSVStats())), 30000)
  console.log('[VAULTS] 10 SVs active — feeding NEXUS every 2s')
}
