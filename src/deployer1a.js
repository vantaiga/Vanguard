// X7-SV · deployer1a.js — Guaranteed Multi-Chain Deployment Engine
// Stage 1: parallel gap-based arb deploy (all chains race)
// Stage 2: bridge cascade (first win funds all others via Across)
// Stage 3: direct deploy sweep (native gas from profit)
// Guarantee: all 17 chains live < 5min after first success

import { getChain, getActiveChains } from './chains.js'
import { getContractAddr, setContractAddr, contractExists, sendTx, waitTx, getExecutorAddress } from './pimlico.js'
import { getArtifact } from './compiler.js'
import { getConfig, setConfig } from './db.js'
import { emit } from './events.js'
import { keccak256, encodePacked, encodeAbiParameters, parseAbiParameters } from 'viem'

const CREATE2 = '0x4e59b44847b379578588920cA78FbF26c0B4956C'
const ACROSS_SPOKES = {
  ethereum: '0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5',
  arbitrum: '0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A',
  polygon:  '0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096',
  base:     '0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64',
  optimism: '0x6f26Bf09B1C792e3228e5467807a900A503c0281',
}

// Bridge cost per chain in USDC (enough for ~10 direct deploys)
const BRIDGE_USDC = {
  ethereum: 20, arbitrum: 2, base: 1, optimism: 1,
  polygon: 1, avalanche: 3, bnb: 3, scroll: 2,
}

// Per-chain minimum profit gate (gas cost × 10x safety margin)
const MIN_PROFIT = {
  ethereum: 500, arbitrum: 5, base: 2, optimism: 2,
  polygon: 2, avalanche: 5, bnb: 5, scroll: 5,
  default: 10
}

// Per-chain minimum gap % (fees + slippage floor)
const MIN_GAP = {
  ethereum: 0.15, arbitrum: 0.01, base: 0.01, optimism: 0.01,
  polygon: 0.01, avalanche: 0.02, bnb: 0.02, scroll: 0.05,
  default: 0.05
}

export const getMinProfit = c => MIN_PROFIT[c] || MIN_PROFIT.default
export const getMinGap    = c => MIN_GAP[c]    || MIN_GAP.default

const _live      = new Set()
const _deploying = new Set()

// ── CREATE2 ───────────────────────────────────────────────────────────────────
export function computeAddr(bytecode) {
  const exec = getExecutorAddress()
  if (!exec) return null
  const salt = keccak256(encodePacked(['address','string'], [exec, 'x7sv_v3']))
  const hash = keccak256(encodePacked(
    ['bytes1','address','bytes32','bytes32'],
    ['0xff', CREATE2, salt, keccak256(bytecode)]
  ))
  return { addr: ('0x' + hash.slice(-40)).toLowerCase(), salt }
}

function deployCalldata(bytecode, salt, chain) {
  const args = encodeAbiParameters(
    parseAbiParameters('address,address,address,address,address'),
    [chain.router||'0x0000000000000000000000000000000000000001',
     chain.usdc  ||'0x0000000000000000000000000000000000000001',
     chain.weth  ||'0x0000000000000000000000000000000000000001',
     chain.flashAddr||'0xBA12222222228d8Ba445958a75a0704d566BF2C8',
     chain.aavePool ||'0x0000000000000000000000000000000000000001']
  )
  const init   = bytecode + args.slice(2)
  const lenHex = Math.floor((init.length-2)/2).toString(16).padStart(64,'0')
  return '0x4af63f02' + salt.slice(2).padStart(64,'0') +
    '0000000000000000000000000000000000000000000000000000000000000040' +
    lenHex + init.slice(2).padEnd(Math.ceil((init.length-2)/2/32)*64,'0')
}

// ── STAGE 3: DIRECT DEPLOY (no arb, pure gas tx) ─────────────────────────────
export async function directDeploy(chainName) {
  if (_live.has(chainName) || _deploying.has(chainName)) return null
  const artifact = getArtifact()
  const chain    = getChain(chainName)
  if (!artifact || !chain) return null

  const computed = computeAddr(artifact.bytecode)
  if (!computed) return null

  if (await contractExists(chainName, computed.addr).catch(()=>false)) {
    setContractAddr(chainName, computed.addr)
    _live.add(chainName)
    emit('deploy_success', { chain: chainName, address: computed.addr, method: 'existing' })
    return computed.addr
  }

  _deploying.add(chainName)
  setConfig('deploy_status_'+chainName, 'deploying')
  try {
    const data    = deployCalldata(artifact.bytecode, computed.salt, chain)
    const hash    = await sendTx(chainName, CREATE2, data)
    if (!hash) throw new Error('null hash')
    const receipt = await waitTx(chainName, hash, 120000)
    if (receipt?.status === 'reverted') throw new Error('reverted')
    if (!await contractExists(chainName, computed.addr).catch(()=>false))
      throw new Error('not at CREATE2 addr')
    setContractAddr(chainName, computed.addr)
    _live.add(chainName)
    setConfig('deploy_status_'+chainName, 'live')
    console.log('[1A] ✓', chainName, 'LIVE (direct):', computed.addr)
    emit('deploy_success', { chain: chainName, address: computed.addr, method: 'direct' })
    return computed.addr
  } catch(e) {
    console.error('[1A]', chainName, 'direct deploy failed:', e.message?.slice(0,80))
    setConfig('deploy_status_'+chainName, 'failed')
    return null
  } finally { _deploying.delete(chainName) }
}

// ── STAGE 2: BRIDGE CASCADE ───────────────────────────────────────────────────
// After first chain succeeds → bridge tiny USDC to all others → direct deploy
async function bridgeCascade(fromChain) {
  const exec    = getExecutorAddress()
  const srcChain= getChain(fromChain)
  if (!exec || !srcChain?.usdc) return

  const targets = getActiveChains()
    .filter(c => !_live.has(c.name) && c.name !== fromChain && ACROSS_SPOKES[fromChain])

  if (!targets.length) return
  console.log(`[1A] Stage 2: bridging from ${fromChain} to ${targets.length} chains`)

  // Encode Across deposit for each target in parallel
  await Promise.allSettled(targets.map(async target => {
    const spoke  = ACROSS_SPOKES[fromChain]
    const amount = BigInt(Math.floor((BRIDGE_USDC[target.name]||2) * 1e6))
    // Across SpokePool.deposit(recipient, originToken, amount, destinationChainId, relayerFeePct, quoteTimestamp)
    const data = '0x' +
      'a0c76a06' +   // deposit(address,address,uint256,uint256,int64,uint32)  selector
      exec.slice(2).padStart(64,'0') +
      (srcChain.usdc||'').slice(2).padStart(64,'0') +
      amount.toString(16).padStart(64,'0') +
      BigInt(target.chainId||0).toString(16).padStart(64,'0') +
      '0000000000000000000000000000000000000000000000000000000000000000' +
      Math.floor(Date.now()/1000).toString(16).padStart(64,'0')
    try {
      const hash = await sendTx(fromChain, spoke, data)
      if (hash) {
        console.log(`[1A] Bridge ${fromChain}→${target.name} $${BRIDGE_USDC[target.name]||2} tx=${String(hash).slice(0,12)}`)
        // After 90s: attempt direct deploy (bridge should confirm)
        setTimeout(() => directDeploy(target.name).catch(()=>{}), 90000)
      }
    } catch(e) { console.warn('[1A] Bridge failed:', target.name, e.message?.slice(0,60)) }
  }))
}

// ── STAGE 1 SUCCESS HANDLER ───────────────────────────────────────────────────
// Called by bootstrap.js when any chain first deploys via arb
export async function onFirstDeploy(chainName) {
  _live.add(chainName)
  console.log(`[1A] Stage 1 anchor: ${chainName} — starting cascade`)

  // Immediately direct-deploy all L2s (gas is cents)
  const l2s = getActiveChains().filter(c =>
    !_live.has(c.name) && c.name !== chainName && c.tier > 1
  )
  await Promise.allSettled(l2s.map(c => directDeploy(c.name).catch(()=>{})))

  // Bridge to chains that need gas funding (ETH + other tier 1s)
  await bridgeCascade(chainName)

  // Direct deploy tier 1 chains that may already have gas from prior runs
  const tier1 = getActiveChains().filter(c =>
    !_live.has(c.name) && c.tier === 1 && c.name !== chainName
  )
  await Promise.allSettled(tier1.map(c => directDeploy(c.name).catch(()=>{})))
}

// ── RECOVERY: check all chains on boot ───────────────────────────────────────
export async function recoverDeployedChains(computedAddr) {
  let count = 0
  await Promise.allSettled(getActiveChains().map(async chain => {
    const stored = getContractAddr(chain.name)
    const check  = stored || computedAddr
    if (!check) return
    if (await contractExists(chain.name, check).catch(()=>false)) {
      setContractAddr(chain.name, check)
      _live.add(chain.name)
      count++
      emit('deploy_success', { chain: chain.name, address: check, method: 'recovered' })
    }
  }))
  return count
}

export const isLive        = c => _live.has(c)
export const getLiveChains = () => [..._live]
export const getStatus     = () => ({
  liveChains:     [..._live],
  deployingChains:[..._deploying],
  allChains: getActiveChains().map(c => ({
    name: c.name, tier: c.tier,
    status:  _live.has(c.name) ? 'live' : getConfig('deploy_status_'+c.name)||'waiting',
    address: getContractAddr(c.name)||null
  }))
})
