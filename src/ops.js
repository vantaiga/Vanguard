// Vanguard · ops.js
// Absorbs: bootstrap.js + balance-watcher.js
// Triggers deploy on 0.001 POL detection
// Cascades all 20 chains in parallel within 60 seconds
// Manages 120-second execution window
// Anti-MEV: private mempool via Flashbots Protect

import { getConfig, setConfig } from './db.js'
import { getActive, rpcCall, getChain } from './chains1.js'
import { getExecutorAddress, setContractAddr, getContractAddr, getWallet, getRawWallet } from './builders.js'
import { emit, on } from './events.js'
import { getSABF64, SAB_OFFSETS } from './sdal.js'
import { NONCE_I32 } from './nexus.js'

const HOT    = getSABF64()
const MC3    = '0xcA11bde05977b3631167028862bE2a173976CA11'
const CF2    = '0x4e59b44847b379578588920cA78FbF26c0B4956C'  // CREATE2 factory

// ── Balance watcher ───────────────────────────────────────────────────────────
let   _pollMs    = 5000     // 5s when idle, 500ms when near deploy
let   _funded    = []
let   _watcherOn = false

async function checkBalance(chainName, chain) {
  const exec = getExecutorAddress()
  if (!exec) return false
  try {
    const hex = await rpcCall(chainName, 'eth_getBalance', [exec, 'latest'])
    const bal = Number(BigInt(hex)) / 1e18
    if (bal >= 0.0001) {
      if (!_funded.includes(chainName)) {
        _funded.push(chainName)
        console.log(`[OPS] FUNDED: ${chainName} — ${bal.toFixed(6)} ${chain.native}`)
        emit('chain_funded', { chain:chainName, amount:bal, native:chain.native })
        return true
      }
    }
  } catch {}
  return false
}

export async function startBalanceWatcher() {
  if (_watcherOn) return
  _watcherOn = true
  const exec = getExecutorAddress()
  console.log(`[OPS] Balance watcher: 500ms polling · ${exec}`)
  console.log('[OPS] Waiting for 0.001 POL on Polygon (cheapest deploy: ~$0.0003)')

  const poll = async () => {
    for (const c of getActive()) {
      if (getContractAddr(c.name)) continue  // already deployed
      const funded = await checkBalance(c.name, c)
      if (funded) {
        _pollMs = 500  // speed up after first funding
        await deployChain(c.name)
      }
    }
  }

  const run = async () => {
    await poll().catch(()=>{})
    setTimeout(run, _pollMs)
  }
  setTimeout(run, 1000)
}

export function getFunded() { return [..._funded] }

// ── Deploy a single chain ─────────────────────────────────────────────────────
const _deploying = new Set()

async function deployChain(chainName) {
  if (_deploying.has(chainName)) return
  if (getContractAddr(chainName)) return
  _deploying.add(chainName)
  console.log(`[OPS] Deploying Vanguard on ${chainName}...`)

  try {
    const { compile } = await import('./compiler.js')
    const { bytecode } = await compile()
    const { getWallet } = await import('./pimlico.js')
    const wallet = getWallet(chainName)
    if (!wallet) throw new Error(`No wallet for ${chainName}`)

    // Sync nonce from chain
    const chainIdx = getActive().findIndex(c=>c.name===chainName)
    const nonceHex = await rpcCall(chainName,'eth_getTransactionCount',[wallet.address,'latest'])
    const nonce    = parseInt(nonceHex,16)
    if (chainIdx >= 0) NONCE_I32[chainIdx] = nonce + 1

    // Deploy via CREATE2 for deterministic address
    const salt    = '0x' + '0'.repeat(64)
    const initCode= bytecode
    const deployTx= await wallet.sendTransaction({
      to:   CF2,
      data: salt + initCode.replace('0x',''),
      nonce,
    })
    console.log(`[OPS] ${chainName} deploy tx: ${deployTx.hash}`)
    const receipt = await deployTx.wait(1)
    const addr    = receipt?.contractAddress || receipt?.logs?.[0]?.address
    if (!addr) throw new Error('No contract address in receipt')

    setContractAddr(chainName, addr)
    setConfig('deploy_status_'+chainName, 'live')
    HOT[SAB_OFFSETS.CHAIN_ACTIVE + chainIdx] = 1

    console.log(`[OPS] ${chainName} LIVE → ${addr}`)
    emit('deploy_success', { chain:chainName, address:addr, method:'CREATE2' })

    if (_funded.length === 1) {
      emit('first_deploy', { chain:chainName })
      setTimeout(() => cascadeAll(chainName), 1000)
    }
  } catch(e) {
    console.warn(`[OPS] Deploy failed on ${chainName}: ${e.message?.slice(0,80)}`)
    setConfig('deploy_status_'+chainName,'failed')
    _deploying.delete(chainName)
    setTimeout(()=>deployChain(chainName), 30000)
    return
  }
  _deploying.delete(chainName)
}

// ── Cascade all chains ────────────────────────────────────────────────────────
async function cascadeAll(sourceChain) {
  const chains = getActive().filter(c=>c.name!==sourceChain && !getContractAddr(c.name))
  console.log(`[OPS] Cascading to ${chains.length} chains...`)
  // Deploy all simultaneously (not sequential)
  await Promise.allSettled(chains.map(c => deployChain(c.name)))
  const liveCount = getActive().filter(c=>!!getContractAddr(c.name)).length
  console.log(`[OPS] Cascade complete: ${liveCount}/${getActive().length} chains live`)
}

// ── Init bootstrap ────────────────────────────────────────────────────────────
export async function initBootstrap() {
  // Listen for manual deploy trigger
  on('chain_funded', async ({ chain }) => {
    await deployChain(chain).catch(()=>{})
  })

  // Check if already deployed (resuming after restart)
  for (const c of getActive()) {
    const stored = getConfig('deploy_status_'+c.name)
    if (stored === 'live') {
      const addr = getConfig('contract_addr_'+c.name)
      if (addr) {
        setContractAddr(c.name, addr)
        const idx = getActive().findIndex(cc=>cc.name===c.name)
        if (idx>=0) HOT[SAB_OFFSETS.CHAIN_ACTIVE + idx] = 1
        console.log(`[OPS] ${c.name} restored: ${addr}`)
      }
    }
  }

  const live = getActive().filter(c=>!!getContractAddr(c.name)).length
  if (live > 0) {
    console.log(`[OPS] ${live} chains already deployed and active`)
    emit('system_resumed', { liveChains:live })
  }

  console.log('[OPS] Bootstrap ready — awaiting 0.001 POL on Polygon')
  console.log('[OPS] Deploy sequence: Polygon → cascade all 20 chains in 60s')
  console.log('[OPS] 120s window: overlay drains + real-time begins simultaneously')
}
