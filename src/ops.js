// Vanguard · ops.js
// Balance watcher + deploy cascade + 120-second execution window
// Static imports: ONLY db.js, sdal.js, events.js
// All other imports dynamic — zero circular risk

import { getConfig, setConfig } from './db.js'
import { getSABF64, SAB_OFFSETS } from './sdal.js'
import { emit, on } from './events.js'

const HOT = getSABF64()

const EXECUTOR = '0xEc92EF0C897b48A3525Df011D08011c5eB2D6D39'
const CHAINS = [
  'ethereum','arbitrum','base','polygon','optimism','avalanche',
  'bnb','blast','linea','scroll','zksync','gnosis','mantle',
  'sonic','berachain','sei','unichain','worldchain',
]

let _funded    = new Set()
let _deploying = new Set()
let _pollMs    = 5000

// ── Check balance on a chain ──────────────────────────────────────────────────
async function checkBalance(chainName) {
  try {
    const { rpcCall } = await import('./chains1.js')
    const exec = getConfig('executor_address') || EXECUTOR
    const hex  = await rpcCall(chainName, 'eth_getBalance', [exec, 'latest'])
    const bal  = Number(BigInt(hex)) / 1e18
    if (bal >= 0.0001 && !_funded.has(chainName)) {
      _funded.add(chainName)
      const chain = (await import('./chains1.js')).getChain(chainName)
      console.log(`[OPS] FUNDED: ${chainName} — ${bal.toFixed(6)} ${chain?.native || 'ETH'}`)
      emit('chain_funded', { chain:chainName, amount:bal })
      return true
    }
  } catch {}
  return false
}

// ── Deploy contract on a chain ────────────────────────────────────────────────
async function deployChain(chainName) {
  if (_deploying.has(chainName)) return
  const { getContractAddr, setContractAddr, compile, getWallet } = await import('./builders.js')
  if (getContractAddr(chainName)) return

  _deploying.add(chainName)
  console.log(`[OPS] Deploying Vanguard on ${chainName}...`)

  try {
    const { bytecode }  = await compile()
    const wallet        = await getWallet(chainName)
    if (!wallet) throw new Error('No wallet for ' + chainName)

    const { rpcCall }  = await import('./chains1.js')
    const nonceHex     = await rpcCall(chainName, 'eth_getTransactionCount', [wallet.address, 'latest'])
    const nonce        = parseInt(nonceHex, 16)

    // Sync nonce to NEXUS SAB
    const { NONCE_I32 } = await import('./nexus.js')
    const chainIdx = CHAINS.indexOf(chainName)
    if (chainIdx >= 0) NONCE_I32[chainIdx] = nonce + 1

    // Deploy via CREATE2 factory for deterministic address
    const CREATE2 = '0x4e59b44847b379578588920cA78FbF26c0B4956C'
    const salt    = '0x' + '0'.repeat(64)
    const tx      = await wallet.sendTransaction({ to:CREATE2, data:salt + bytecode.replace('0x',''), nonce })
    console.log(`[OPS] ${chainName} deploy tx: ${tx.hash}`)
    const receipt = await tx.wait(1)
    const addr    = receipt?.contractAddress || receipt?.logs?.[0]?.address

    if (!addr) throw new Error('No contract address in receipt')

    setContractAddr(chainName, addr)
    setConfig('deploy_status_'+chainName, 'live')
    HOT[SAB_OFFSETS.CHAIN_ACTIVE + Math.max(0, CHAINS.indexOf(chainName))] = 1

    console.log(`[OPS] ${chainName} LIVE → ${addr}`)
    emit('deploy_success', { chain:chainName, address:addr })

    // Trigger overlay replay for this chain
    setTimeout(async () => {
      try {
        const { replayChain, overlayPending } = await import('./overlay.js')
        const { nexusRoute }                  = await import('./nexus.js')
        const { apexExecute }                 = await import('./apex.js')
        const pending = overlayPending(chainName)
        if (pending.length) {
          console.log(`[OPS] ${chainName}: replaying ${pending.length} queued swaps`)
          replayChain(chainName, async entry => {
            const d = nexusRoute({ chain:chainName, type:'vault_arb', profitEst:entry.profitEst||0, flashRequired:entry.flash||0, calldata:entry.calldata||'', chainId:entry.chainId||1 })
            return d ? apexExecute(d) : null
          })
        }
      } catch {}
    }, 2000)

  } catch(e) {
    console.warn(`[OPS] Deploy failed on ${chainName}: ${e.message?.slice(0,80)}`)
    setConfig('deploy_status_'+chainName, 'failed')
    _deploying.delete(chainName)
    setTimeout(() => deployChain(chainName), 30000)
    return
  }

  _deploying.delete(chainName)
}

// ── Cascade all chains ────────────────────────────────────────────────────────
async function cascadeAll(sourceChain) {
  const rest = CHAINS.filter(c => c !== sourceChain)
  console.log(`[OPS] Cascading deployment to ${rest.length} chains simultaneously...`)
  await Promise.allSettled(rest.map(c => deployChain(c)))
  const { getContractAddr } = await import('./builders.js')
  const live = CHAINS.filter(c => !!getContractAddr(c)).length
  console.log(`[OPS] Cascade complete — ${live}/${CHAINS.length} chains live`)
}

// ── Balance watcher ───────────────────────────────────────────────────────────
export function startBalanceWatcher() {
  const exec = getConfig('executor_address') || EXECUTOR
  console.log(`[OPS] Balance watcher: ${exec}`)
  console.log('[OPS] Waiting for 0.001 POL on Polygon...')

  let _firstDeploy = false
  const poll = async () => {
    try {
      for (const chain of CHAINS) {
        const { getContractAddr } = await import('./builders.js')
        if (getContractAddr(chain)) continue
        const funded = await checkBalance(chain)
        if (funded && !_firstDeploy) {
          _firstDeploy = true
          _pollMs = 500
          await deployChain(chain)
          setTimeout(() => cascadeAll(chain), 1000)
        }
      }
    } catch {}
    setTimeout(poll, _pollMs)
  }

  setTimeout(poll, 1000)
}

// ── Restore already-deployed chains ──────────────────────────────────────────
export async function initBootstrap() {
  const { getContractAddr, setContractAddr } = await import('./builders.js')
  let restored = 0

  for (const chain of CHAINS) {
    const stored = getConfig('deploy_status_'+chain)
    if (stored === 'live') {
      const addr = getConfig('contract_addr_'+chain)
      if (addr) {
        setContractAddr(chain, addr)
        HOT[SAB_OFFSETS.CHAIN_ACTIVE + Math.max(0, CHAINS.indexOf(chain))] = 1
        restored++
      }
    }
  }

  if (restored > 0) {
    console.log(`[OPS] ${restored} chains restored from previous deployment`)
    emit('system_resumed', { liveChains:restored })
  }

  console.log('[OPS] Bootstrap complete — watching for 0.001 POL')
}
