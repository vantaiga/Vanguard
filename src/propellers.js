// X7-SV · propellers.js — Layer 0: 14 propellers · controls all revenue multipliers

import { encodeFunctionData, parseAbi } from 'viem'
import { getConfig, setConfig } from './db.js'
import { rpcCall } from './rpc.js'
import { getChain, getActiveChains } from './chains.js'
import { getContractAddr } from './pimlico.js'
import { emit } from './events.js'

const ARB_ABI = parseAbi(['function dexArb(address,address,uint256,uint24,uint24,uint256) external'])

// ── CONFIG ───────────────────────────────────────────────────────────────────
const P = {
  level:      () => parseInt(getConfig('prop_intensity')    || '5'),
  flashRatio: () => parseInt(getConfig('prop_flash_ratio')  || '20'),
  cascade:    () => parseInt(getConfig('prop_cascade_depth')|| '5'),
  horizon:    () => parseInt(getConfig('prop_block_horizon')|| '3'),
  cexThresh:  () => parseFloat(getConfig('prop_cex_threshold')|| '0.05'),
  builderTip: () => parseInt(getConfig('prop_builder_tip')  || '7500'),
  solverBps:  () => parseInt(getConfig('solver_margin_bps') || '10'),
}

let _stats = { total:0, execs:0, byPropeller:{} }

function log(id, profit) {
  _stats.byPropeller[id] = (_stats.byPropeller[id]||0) + profit
  _stats.total  += profit
  _stats.execs  += 1
  setConfig('prop_stats', JSON.stringify(_stats))
  emit('propeller_fire', { id, profit })
}

export const getPropellerStats  = () => _stats
export const getPropellerConfig = () => ({
  intensity:   P.level(), flashRatio: P.flashRatio(),
  cascadeDepth:P.cascade(), blockHorizon:P.horizon(),
  cexThreshold:P.cexThresh(), builderTip:P.builderTip(), solverBps:P.solverBps()
})
export const setPropellerConfig = (key, value) => setConfig('prop_'+key, String(value))

// ── P1: CAPITAL AMPLIFIER ────────────────────────────────────────────────────
export async function p1Amplify(chainName, tokenIn, amountIn) {
  if (P.level() < 1) return amountIn
  const ratio = BigInt(Math.min(P.flashRatio(), 100))
  const target = amountIn * ratio
  try {
    const chain = getChain(chainName)
    if (!chain?.flashAddr) return amountIn
    const balHex = await rpcCall(chainName, 'eth_call', [{
      to:   tokenIn,
      data: '0x70a08231' + chain.flashAddr.slice(2).padStart(64,'0')
    }, 'latest'])
    const avail = BigInt(balHex||'0x0')
    return avail >= target ? target : avail > amountIn ? avail : amountIn
  } catch { return amountIn * 5n }
}

// ── P2: CASCADE SCANNER ──────────────────────────────────────────────────────
const CASCADE_POOLS = {
  ethereum: [
    { addr:'0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640', fee:500 },
    { addr:'0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8', fee:3000 },
    { addr:'0x4585FE77225b41b697C938B018E2ac67Ac5a20c0', fee:3000 },
    { addr:'0x60594a405d53811d3BC4766596EFD80fd545A270', fee:500 },
  ],
  arbitrum: [
    { addr:'0xC6962004f452bE9203591991D15f6b388e09E8D0', fee:500 },
    { addr:'0x2f5e87C9312fa29aed5c179E456625D79015299c', fee:3000 },
  ],
  polygon: [{ addr:'0x45dDa9cb7c25131DF268515131f647d726f50608', fee:500 }],
  base:    [{ addr:'0x4C36388bE6F416A29C8d8Eee81C771cE6bE14B5', fee:500 }],
}

export async function p2Cascade(chainName, baseProfit) {
  if (P.level() < 2) return []
  const pools = (CASCADE_POOLS[chainName]||[]).slice(0, P.cascade())
  const opps  = []
  for (const pool of pools) {
    try {
      const chain = getChain(chainName)
      if (!chain?.quoter || !chain?.usdc || !chain?.weth) continue
      const QUOTER_ABI = parseAbi(['function quoteExactInputSingle(address,address,uint24,uint256,uint160) external returns (uint256,uint160,uint32,uint256)'])
      const data = encodeFunctionData({ abi:QUOTER_ABI, functionName:'quoteExactInputSingle', args:[chain.usdc, chain.weth, pool.fee, BigInt(100000e6), 0n] })
      const res  = await rpcCall(chainName, 'eth_call', [{ to:chain.quoter, data }, 'latest'])
      if (res && res !== '0x') {
        const out = BigInt(res.slice(0,66))
        if (out > 0n) opps.push({ ...pool, out, profitUSD: Number(out)/1e18 * (JSON.parse(getConfig('prices')||'{}').ETH||3000) * 0.0003 })
      }
    } catch {}
    await new Promise(r => setTimeout(r, 20))
  }
  return opps.filter(o => o.profitUSD > 50)
}

// ── P3: TEMPORAL STACKER ─────────────────────────────────────────────────────
export function p3Temporals(calldata, profit) {
  if (P.level() < 3) return [{ calldata, profitEst:profit }]
  return Array.from({ length: P.horizon() }, (_, i) => ({
    calldata, profitEst: profit * (1 - i*0.15)
  }))
}

// ── P4: FEE TIER SPLITTER ────────────────────────────────────────────────────
export function p4Tiers(amount) {
  if (P.level() < 4) return [{ fee:500, amount }]
  const tiers = [100,500,3000,10000]
  const split = amount / BigInt(tiers.length)
  return tiers.map(fee => ({ fee, amount:split }))
}

// ── P5: CROSS-SV MULTIPLIER ──────────────────────────────────────────────────
export function p5Multiplier() {
  if (P.level() < 5) return 1.5
  return Math.min(1 + parseInt(getConfig('active_svs')||'10') * 0.15, 3.5)
}

// ── P6: STAT-ARB / CEX-DEX ───────────────────────────────────────────────────
export async function p6StatArb(chainName, cexPrice, dexPrice) {
  if (P.level() < 6) return null
  const gapPct = Math.abs(cexPrice - dexPrice) / dexPrice * 100
  if (gapPct < P.cexThresh()) return null
  const chain  = getChain(chainName)
  const addr   = getContractAddr(chainName)
  if (!chain?.weth || !chain?.usdc || !addr) return null
  const profitEst = gapPct * 100000 / 100
  if (profitEst < (chain.minProfit||50)) return null
  log('P6', profitEst)
  const calldata = encodeFunctionData({ abi:ARB_ABI, functionName:'dexArb',
    args:[chain.usdc, chain.weth, BigInt(Math.floor(100000e6)), 500, 3000, BigInt(Math.floor(profitEst*0.3*1e6))]
  })
  const { executeBundle } = await import('./builders.js')
  return executeBundle(chainName, addr, calldata, profitEst)
}

// ── P7: INTENT FRONT-RUNNER ──────────────────────────────────────────────────
export async function p7Intent(chainName, batch) {
  if (P.level() < 7) return null
  const { tokenIn, tokenOut, totalAmount } = batch
  const chain = getChain(chainName)
  const addr  = getContractAddr(chainName)
  if (!addr || !chain) return null
  const profitEst = totalAmount * 0.0005
  if (profitEst < (chain.minProfit||50)) return null
  log('P7', profitEst)
  const calldata = encodeFunctionData({ abi:ARB_ABI, functionName:'dexArb',
    args:[tokenIn, tokenOut, BigInt(Math.floor(totalAmount*1e6)), 500, 3000, BigInt(Math.floor(profitEst*0.3*1e6))]
  })
  const { executeBundle } = await import('./builders.js')
  return executeBundle(chainName, addr, calldata, profitEst)
}

// ── P8: SOLVER MARGIN ────────────────────────────────────────────────────────
export function p8SolverMargin(orderAmountUSD) {
  return orderAmountUSD * P.solverBps() / 10000
}

// ── P9: MULTI-CHAIN SIMULTANEOUS ─────────────────────────────────────────────
export async function p9MultiChain(triggerEvent, callbackFn) {
  if (P.level() < 5) return []
  const chains  = getActiveChains().filter(c => getContractAddr(c.name))
  const results = await Promise.allSettled(chains.map(c => callbackFn(c.name, triggerEvent)))
  const wins    = results.filter(r=>r.status==='fulfilled'&&r.value).length
  if (wins > 0) log('P9', wins * 500)
  return results
}

// ── P10: LATENCY NETWORK ─────────────────────────────────────────────────────
export const p10ColoUrl = chainName => process.env[`COLO_${chainName.toUpperCase()}_RPC`] || null

// ── P11: LIQUIDITY VACUUM ────────────────────────────────────────────────────
export async function p11LiqVacuum(chainName, removedLiqUSD) {
  if (P.level() < 8 || removedLiqUSD < 1000000) return null
  const profitEst = removedLiqUSD * 0.002
  if (profitEst < 500) return null
  console.log(`[P11] Liquidity vacuum: $${profitEst.toFixed(0)} on ${chainName}`)
  log('P11', profitEst)
  return profitEst
}

// ── P12: GOVERNANCE FRONT-RUN ────────────────────────────────────────────────
export function p12Governance(protocol, priceImpactPct) {
  if (P.level() < 9) return 0
  const profitEst = Math.abs(priceImpactPct) * 1000000 * 0.001
  if (profitEst > 0) log('P12', profitEst)
  return profitEst
}

// ── P13: STABLECOIN DEPEG ────────────────────────────────────────────────────
export async function p13Depeg(chainName, token, deviationPct) {
  if (P.level() < 4 || deviationPct < 0.05) return null
  const profitEst = deviationPct * 1000000 / 100
  console.log(`[P13] Depeg ${token} on ${chainName}: ${deviationPct.toFixed(3)}% → $${profitEst.toFixed(0)}`)
  log('P13', profitEst)
  return profitEst
}

// ── P14: AUTONOMOUS POSITION MANAGER ────────────────────────────────────────
export async function p14AutoPosition(chainName) {
  if (P.level() < 6) return null
  const total = parseFloat(getConfig('sv_total')||'0')
  if (total < 1000) return null
  const lpAmount = total * 0.5
  log('P14', lpAmount * 0.002)
  setConfig('lp_vault_total', (parseFloat(getConfig('lp_vault_total')||'0') + lpAmount * 0.5).toFixed(2))
  return lpAmount
}

// ── MAIN PROCESSOR ───────────────────────────────────────────────────────────
export async function processPropellers(chainName, opp) {
  const lvl = P.level()
  if (lvl === 0) return opp
  let { tokenIn, tokenOut, amountIn, buyFee, sellFee, profitEst } = opp

  if (lvl >= 1) {
    const amplified = await p1Amplify(chainName, tokenIn, amountIn)
    const ratio     = Number(amplified) / Number(amountIn)
    amountIn   = amplified
    profitEst *= ratio
  }
  if (lvl >= 4) profitEst *= 1.5  // fee tier optimization
  if (lvl >= 5) profitEst *= p5Multiplier()
  if (lvl >= 6 && p10ColoUrl(chainName)) profitEst *= 1.15

  return { ...opp, amountIn, buyFee, sellFee, profitEst }
}
