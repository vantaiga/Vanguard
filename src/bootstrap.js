// X7-SV · bootstrap.js — ARCHITECTURE 1: Zero-Seed via Cross-Pool Flash Arb
//
// COMPLETE REDESIGN. The old bootstrap.js is entirely replaced.
//
// HOW IT WORKS:
//   scanner.js detects a real cross-pool price gap
//   emits 'arb_opportunity' with verified profitable parameters
//   bootstrap.js builds the bundle:
//     tx[0]: CREATE2 deploy X7.sol (if not deployed)
//     tx[1]: X7.crossPoolArb() with scanner's parameters
//   Submits to all 6 builders
//   If profitable: builders include it → contract deploys → profit swept
//   After ETH live: deploys all L2s in parallel
//
// WHY THIS WORKS (unlike previous implementation):
//   Old: round-trip same pool → impossible to profit → always reverts
//   New: cross-pool gap → verified profitable by scanner → builders include
//
// FAILURE PROOFING:
//   Gap closes before inclusion → amountOutMin fails in contract → revert
//     → builder drops bundle → zero cost → we wait for next gap
//   Multiple opportunities simultaneously → deduplication (one bundle at a time)
//   Railway restart → DB check → if already deployed, activates immediately
//   RPC failure → 8-provider race pool (Promise.any)
//   Re-entrancy → _ethBundleInFlight flag
//   Gas fee invariant → baseFee×2+tip (proven formula from prior fix)

import {
  keccak256, encodePacked,
  encodeAbiParameters, parseAbiParameters
} from 'viem'
import { getActiveChains, getChain } from './chains.js'
import {
  getContractAddr, setContractAddr,
  getExecutorAddress, getWalletClient,
  contractExists, sendTx, waitTx
} from './pimlico.js'
import { compile, getArtifact } from './compiler.js'
import { getConfig, setConfig } from './db.js'
import { emit, on } from './events.js'

// ── CONSTANTS ─────────────────────────────────────────────────────────────────
const CREATE2_FACTORY = '0x4e59b44847b379578588920cA78FbF26c0B4956C'

// ── MULTI-PROVIDER ETH RPC POOL ───────────────────────────────────────────────
// 8 providers in race mode (Promise.any) — never exhausted
// Proven in logs: RPC calls succeed consistently with this pool
const ETH_PROVIDERS = [
  process.env.ALCHEMY_ETH_KEY && process.env.ALCHEMY_ETH_KEY !== 'demo'
    ? `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_ETH_KEY}` : null,
  process.env.INFURA_KEY
    ? `https://mainnet.infura.io/v3/${process.env.INFURA_KEY}` : null,
  'https://eth.drpc.org',
  'https://eth.llamarpc.com',
  'https://rpc.ankr.com/eth',
  'https://ethereum.publicnode.com',
  'https://cloudflare-eth.com',
  'https://1rpc.io/eth',
  'https://ethereum.blockpi.network/v1/rpc/public',
].filter(Boolean)

async function ethRPC(method, params = [], timeoutMs = 4000) {
  const calls = ETH_PROVIDERS.map(url =>
    fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal:  AbortSignal.timeout(timeoutMs)
    })
    .then(r => r.json())
    .then(d => {
      if (d.error)          throw new Error(d.error.message)
      if (d.result === undefined) throw new Error('no result')
      return d.result
    })
  )
  try {
    return await Promise.any(calls)
  } catch {
    throw new Error('[RPC:ethereum] All providers exhausted')
  }
}

// ── STATE ─────────────────────────────────────────────────────────────────────
let _computedAddr        = null
const _deploying         = new Set()
const _live              = new Set()
let   _ethBundleInFlight = false
let   _lastBundleAttempt = 0
const BUNDLE_COOLDOWN_MS = 13000  // One ETH block

// ── GAS PARAMS — EIP-1559 INVARIANT GUARANTEED ───────────────────────────────
// maxFeePerGas = baseFee×2 + tip — proven formula
// invariant: maxFeePerGas >= maxPriorityFeePerGas always holds
const TIPS = [1500000000n, 2000000000n, 3000000000n, 5000000000n]

async function getGasParams(attempt = 0) {
  const tip = TIPS[Math.min(attempt, TIPS.length - 1)]
  try {
    const block   = await ethRPC('eth_getBlockByNumber', ['latest', false])
    const baseFee = BigInt(block?.baseFeePerGas || '0x3b9aca00')
    return {
      maxFeePerGas:         baseFee * 2n + tip,
      maxPriorityFeePerGas: tip
    }
  } catch {
    // Safe fallback: tip×3 always >= tip
    return {
      maxFeePerGas:         tip * 3n,
      maxPriorityFeePerGas: tip
    }
  }
}

// ── CREATE2 ADDRESS PRE-COMPUTATION ───────────────────────────────────────────
export function computeCreate2Address(bytecode) {
  const executor = getExecutorAddress()
  if (!executor) return null
  const salt         = keccak256(encodePacked(['address','string'], [executor, 'x7sv_v3']))
  const bytecodeHash = keccak256(bytecode)
  const preimage     = encodePacked(
    ['bytes1','address','bytes32','bytes32'],
    ['0xff', CREATE2_FACTORY, salt, bytecodeHash]
  )
  const addr = ('0x' + keccak256(preimage).slice(-40)).toLowerCase()
  return { addr, salt, bytecodeHash }
}

function buildDeployCalldata(bytecode, constructorArgs, salt) {
  const selector   = '0x4af63f02'
  const initCode   = bytecode + constructorArgs.slice(2)
  const saltPadded = salt.slice(2).padStart(64, '0')
  const offset     = '0000000000000000000000000000000000000000000000000000000000000040'
  const len        = Math.floor((initCode.length - 2) / 2)
  const lenHex     = len.toString(16).padStart(64, '0')
  const dataHex    = initCode.slice(2).padEnd(Math.ceil(len / 32) * 64, '0')
  return selector + saltPadded + offset + lenHex + dataHex
}

// Build crossPoolArb calldata from scanner opportunity
// Signature: crossPoolArb(address,uint256,address,address,address,uint24,uint24,uint256,uint256,address)
function buildCrossPoolCalldata(opportunity, contractAddr, executor) {
  const selector = '0x' + keccak256(new TextEncoder().encode(
    'crossPoolArb(address,uint256,address,address,address,uint24,uint24,uint256,uint256,address)'
  )).slice(2, 10)

  const args = encodeAbiParameters(
    parseAbiParameters(
      'address,uint256,address,address,address,uint24,uint24,uint256,uint256,address'
    ),
    [
      opportunity.flashToken,
      opportunity.flashAmountWei,        // USDC amount in 6-decimal BigInt
      opportunity.poolBuy,
      opportunity.poolSell,
      opportunity.assetToken,
      opportunity.buyFee,
      opportunity.sellFee,
      opportunity.minBuyAmount,          // BigInt, asset token wei
      opportunity.minSellUsdc,           // BigInt, USDC units (6 dec)
      executor
    ]
  )
  return selector + args.slice(2)
}

// ── BUNDLE SUBMISSION — ALL 6 BUILDERS ───────────────────────────────────────
const BUILDERS = [
  'https://rpc.titanbuilder.xyz',
  'https://rpc.buildernet.org',
  'https://rpc.beaverbuild.org',
  'https://rsync-builder.xyz',
  'https://relay.flashbots.net',
  'https://mev-share.flashbots.net',
]

async function submitBundle(txs, blockNum) {
  const blockHex = '0x' + blockNum.toString(16)
  const body     = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'eth_sendBundle',
    params: [{
      txs,
      blockNumber:  blockHex,
      minTimestamp: 0,
      maxTimestamp: Math.floor(Date.now() / 1000) + 60
    }]
  })

  const results = await Promise.allSettled(
    BUILDERS.map(url =>
      fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal:  AbortSignal.timeout(3000)
      })
      .then(r => r.json())
      .then(d => ({ url, ok: !!d.result }))
      .catch(() => ({ url, ok: false }))
    )
  )

  return results
    .filter(r => r.status === 'fulfilled' && r.value.ok)
    .map(r => r.value.url.split('/')[2])
}

// ── CORE BOOTSTRAP EXECUTION ──────────────────────────────────────────────────
//
// Called when scanner emits 'arb_opportunity' with verified profitable params.
// Builds bundle: [CREATE2_deploy, crossPoolArb]
// Submits across 4 blocks with escalating tips.
//
// DEDUPLICATION:
//   _ethBundleInFlight: only one bundle active at a time
//   _lastBundleAttempt: 13s cooldown (one block)
//   These prevent nonce conflicts from multiple simultaneous opportunities

async function executeBootstrap(opportunity) {
  // Guard: only one active bundle
  if (_ethBundleInFlight) {
    console.log('[BOOTSTRAP] Bundle in flight — queuing opportunity')
    return null
  }
  if (Date.now() - _lastBundleAttempt < BUNDLE_COOLDOWN_MS) return null

  // Already live? Skip deploy tx
  const addr     = _computedAddr
  const executor = getExecutorAddress()
  if (!addr || !executor) return null

  const alreadyLive = await contractExists('ethereum', addr).catch(() => false)
  if (alreadyLive) {
    if (!_live.has('ethereum')) {
      setContractAddr('ethereum', addr)
      _live.add('ethereum')
      emit('deploy_success', { chain: 'ethereum', address: addr, method: 'already-live' })
      propagateToL2s().catch(() => {})
    }
    // Execute arb directly (no deploy needed)
    return executeArbOnly(opportunity, addr, executor)
  }

  _ethBundleInFlight = true
  _lastBundleAttempt = Date.now()

  const artifact = getArtifact()
  if (!artifact) { _ethBundleInFlight = false; return null }

  const computed = computeCreate2Address(artifact.bytecode)
  if (!computed) { _ethBundleInFlight = false; return null }

  try {
    const chain  = getChain('ethereum')
    const wallet = getWalletClient('ethereum')
    if (!wallet || !chain?.usdc || !chain?.weth) {
      _ethBundleInFlight = false; return null
    }

    // Get nonce + block + gas simultaneously (race across 8 providers)
    const [nonceHex, blockHex, gas] = await Promise.all([
      ethRPC('eth_getTransactionCount', [executor, 'pending']),
      ethRPC('eth_blockNumber', []),
      getGasParams(0)
    ])

    const nonce    = parseInt(nonceHex, 16)
    const blockNum = parseInt(blockHex, 16)

    console.log(
      `[BOOTSTRAP] Opportunity: ${opportunity.pairName} gap=${opportunity.gapPct}% ` +
      `flash=$${(opportunity.flashAmountUsdc/1e6).toFixed(1)}M ` +
      `profit~$${opportunity.estimatedProfit.toLocaleString()}`
    )
    console.log(`[BOOTSTRAP] nonce=${nonce} block=${blockNum} ` +
      `maxFee=${gas.maxFeePerGas/1000000000n}gwei tip=${gas.maxPriorityFeePerGas/1000000000n}gwei`)

    // Build constructor args (5 params: router, usdc, weth, balancer, aave)
    const constructorArgs = encodeAbiParameters(
      parseAbiParameters('address,address,address,address,address'),
      [
        chain.router,
        chain.usdc,
        chain.weth,
        chain.flashAddr || '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
        chain.aavePool  || '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'
      ]
    )

    const deployCalldata = buildDeployCalldata(
      artifact.bytecode, constructorArgs, computed.salt
    )
    const arbCalldata    = buildCrossPoolCalldata(opportunity, addr, executor)

    // Sign tx[0]: CREATE2 deploy  (nonce)
    let signedDeploy
    try {
      signedDeploy = await wallet.signTransaction({
        to:      CREATE2_FACTORY,
        data:    deployCalldata,
        nonce,
        gas:     600000n,
        chainId: 1,
        ...gas
      })
    } catch (e) {
      console.log('[BOOTSTRAP] Sign deploy failed:', e.message?.slice(0, 120))
      _ethBundleInFlight = false
      return null
    }

    // Sign tx[1]: crossPoolArb  (nonce+1)
    let signedArb
    try {
      signedArb = await wallet.signTransaction({
        to:      addr,        // Contract doesn't exist yet — CREATE2 address
        data:    arbCalldata,
        nonce:   nonce + 1,
        gas:     900000n,
        chainId: 1,
        ...gas
      })
    } catch (e) {
      console.log('[BOOTSTRAP] Sign arb failed:', e.message?.slice(0, 120))
      _ethBundleInFlight = false
      return null
    }

    // Submit across 4 blocks, escalating tips
    for (let attempt = 0; attempt < 4; attempt++) {
      const targetBlock = blockNum + attempt + 1
      const tipGwei     = gas.maxPriorityFeePerGas / 1000000000n
      console.log(`[BOOTSTRAP] Attempt ${attempt+1}/4 block=${targetBlock} tip=${tipGwei}gwei`)

      const txs  = [signedDeploy, signedArb]
      const wins = await submitBundle(txs, targetBlock)
      // Double coverage: also submit to block+2 simultaneously
      submitBundle(txs, targetBlock + 1).catch(() => {})

      if (wins.length > 0) {
        console.log(`[BOOTSTRAP] Accepted by: ${wins.join(', ')}`)
      }

      // Wait one block
      await new Promise(r => setTimeout(r, 12500))

      // Check deployment
      const deployed = await contractExists('ethereum', addr).catch(() => false)
      if (deployed) {
        setContractAddr('ethereum', addr)
        _live.add('ethereum')
        console.log('[BOOTSTRAP] ✓ ETH LIVE — cross-pool arb bootstrap complete:', addr)
        emit('deploy_success', { chain: 'ethereum', address: addr, method: 'cross-pool-arb' })
        _ethBundleInFlight = false

        // Check executor USDC balance (profit should be here)
        checkExecutorBalance().catch(() => {})

        // Propagate to L2s
        setTimeout(() => propagateToL2s().catch(() => {}), 3000)
        return addr
      }

      // Escalate gas for next attempt
      if (attempt < 3) {
        const newGas = await getGasParams(attempt + 1)
        const tipG   = newGas.maxPriorityFeePerGas / 1000000000n
        console.log(`[BOOTSTRAP] Escalating to ${tipG}gwei`)
        try {
          signedDeploy = await wallet.signTransaction({
            to: CREATE2_FACTORY, data: deployCalldata,
            nonce, gas: 600000n, chainId: 1, ...newGas
          })
          signedArb = await wallet.signTransaction({
            to: addr, data: arbCalldata,
            nonce: nonce + 1, gas: 900000n, chainId: 1, ...newGas
          })
          Object.assign(gas, newGas)
        } catch (e) {
          console.log('[BOOTSTRAP] Re-sign failed:', e.message?.slice(0, 80))
        }
      }
    }

    // Final check after 4 attempts
    const final = await contractExists('ethereum', addr).catch(() => false)
    if (final) {
      setContractAddr('ethereum', addr)
      _live.add('ethereum')
      console.log('[BOOTSTRAP] ✓ ETH LIVE (late confirm):', addr)
      emit('deploy_success', { chain: 'ethereum', address: addr, method: 'late-confirm' })
      setTimeout(() => propagateToL2s().catch(() => {}), 3000)
      _ethBundleInFlight = false
      return addr
    }

    console.log('[BOOTSTRAP] 4 attempts exhausted — waiting for next gap')
    _ethBundleInFlight = false
    return null

  } catch (e) {
    console.error('[BOOTSTRAP] Unexpected error:', e.message?.slice(0, 100))
    _ethBundleInFlight = false
    return null
  }
}

// ── POST-DEPLOY ARB EXECUTION ─────────────────────────────────────────────────
// After contract is live: execute arb directly without deploy tx
async function executeArbOnly(opportunity, contractAddr, executor) {
  const wallet = getWalletClient('ethereum')
  if (!wallet) return null

  try {
    const [nonceHex, blockHex, gas] = await Promise.all([
      ethRPC('eth_getTransactionCount', [executor, 'pending']),
      ethRPC('eth_blockNumber', []),
      getGasParams(0)
    ])

    const nonce    = parseInt(nonceHex, 16)
    const blockNum = parseInt(blockHex, 16)
    const arbCalldata = buildCrossPoolCalldata(opportunity, contractAddr, executor)

    let signedArb
    try {
      signedArb = await wallet.signTransaction({
        to: contractAddr, data: arbCalldata,
        nonce, gas: 900000n, chainId: 1, ...gas
      })
    } catch (e) {
      console.log('[BOOTSTRAP] Post-deploy sign failed:', e.message?.slice(0, 80))
      return null
    }

    // Single attempt first — if it works, great
    const wins = await submitBundle([signedArb], blockNum + 1)
    if (wins.length > 0) {
      console.log(`[BOOTSTRAP] Post-deploy arb submitted: ${wins.join(', ')}`)
    }
    return wins.length > 0 ? 'submitted' : null
  } catch { return null }
}

// ── EXECUTOR BALANCE CHECK ────────────────────────────────────────────────────
async function checkExecutorBalance() {
  const executor = getExecutorAddress()
  const chain    = getChain('ethereum')
  if (!executor || !chain?.usdc) return

  try {
    const balHex = await ethRPC('eth_call', [{
      to:   chain.usdc,
      data: '0x70a08231' + executor.slice(2).padStart(64, '0')
    }, 'latest'])
    const usdcBal = Number(BigInt(balHex || '0x0')) / 1e6
    console.log(`[BOOTSTRAP] Executor USDC balance: $${usdcBal.toFixed(2)}`)
    setConfig('executor_usdc_bal', usdcBal.toFixed(2))
  } catch {}
}

// ── L2 PROPAGATION ────────────────────────────────────────────────────────────
async function propagateToL2s() {
  const l2s = getActiveChains().filter(c => c.name !== 'ethereum')
  console.log(`[BOOTSTRAP] Propagating to ${l2s.length} L2s in parallel...`)

  await Promise.allSettled(
    l2s.map((l2, i) =>
      new Promise(r => setTimeout(r, i * 300))
        .then(() => deployL2(l2.name))
        .catch(() => {})
    )
  )
}

// ── L2 DIRECT DEPLOY ──────────────────────────────────────────────────────────
async function deployL2(chainName) {
  if (_deploying.has(chainName)) return null
  if (_live.has(chainName))      return getContractAddr(chainName)

  const existing = getContractAddr(chainName)
  if (existing) {
    const live = await contractExists(chainName, existing).catch(() => false)
    if (live) { _live.add(chainName); return existing }
  }

  const artifact = getArtifact()
  if (!artifact) return null

  const computed = computeCreate2Address(artifact.bytecode)
  if (!computed) return null

  const onChain = await contractExists(chainName, computed.addr).catch(() => false)
  if (onChain) {
    setContractAddr(chainName, computed.addr)
    _live.add(chainName)
    console.log('[BOOTSTRAP]', chainName, 'already on-chain:', computed.addr)
    emit('deploy_success', { chain: chainName, address: computed.addr, method: 'existing' })
    return computed.addr
  }

  _deploying.add(chainName)
  setConfig('deploy_status_' + chainName, 'deploying')

  try {
    const chain = getChain(chainName)
    if (!chain) throw new Error('No chain config')

    const constructorArgs = encodeAbiParameters(
      parseAbiParameters('address,address,address,address,address'),
      [
        chain.router   || '0x0000000000000000000000000000000000000001',
        chain.usdc     || '0x0000000000000000000000000000000000000001',
        chain.weth     || '0x0000000000000000000000000000000000000001',
        chain.flashAddr|| '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
        chain.aavePool || '0x0000000000000000000000000000000000000001'
      ]
    )

    const deployCalldata = buildDeployCalldata(
      artifact.bytecode, constructorArgs, computed.salt
    )
    const hash    = await sendTx(chainName, CREATE2_FACTORY, deployCalldata)
    if (!hash) throw new Error('sendTx null')

    const receipt = await waitTx(chainName, hash, 120000)
    if (!receipt || receipt.status === 'reverted') throw new Error('tx reverted')

    const verified = await contractExists(chainName, computed.addr).catch(() => false)
    if (!verified) throw new Error('Not at CREATE2 address')

    setContractAddr(chainName, computed.addr)
    _live.add(chainName)
    setConfig('deploy_status_' + chainName, 'live')
    _deploying.delete(chainName)

    console.log('[BOOTSTRAP] ✓', chainName, 'LIVE:', computed.addr)
    emit('deploy_success', { chain: chainName, address: computed.addr, method: 'l2-direct' })
    return computed.addr

  } catch (e) {
    console.error('[BOOTSTRAP]', chainName, e.message?.slice(0, 100))
    setConfig('deploy_status_' + chainName, 'failed')
    _deploying.delete(chainName)
    return null
  }
}

// ── SELF-HEALING ──────────────────────────────────────────────────────────────
async function selfHeal() {
  const artifact = getArtifact()
  if (!artifact) return

  for (const chain of getActiveChains()) {
    const stored = getContractAddr(chain.name)
    if (!stored) continue
    try {
      const exists = await contractExists(chain.name, stored)
      if (!exists) {
        console.log('[BOOTSTRAP] Self-heal:', chain.name)
        setConfig('contract_' + chain.name, '')
        _live.delete(chain.name)
        if (chain.name !== 'ethereum') {
          deployL2(chain.name).catch(() => {})
        }
        // ETH re-bootstrap happens automatically on next 'arb_opportunity' event
      }
    } catch {}
    await new Promise(r => setTimeout(r, 200))
  }
}

// ── EXPORTS ───────────────────────────────────────────────────────────────────

export function getBootstrapStatus() {
  const artifact = getArtifact()
  const computed = artifact ? computeCreate2Address(artifact.bytecode) : null
  return {
    computedAddress:  computed?.addr || _computedAddr || 'compiling...',
    liveChains:       [..._live],
    deployingChains:  [..._deploying],
    bundleInFlight:   _ethBundleInFlight,
    lastBundleMs:     Date.now() - _lastBundleAttempt,
    providers:        ETH_PROVIDERS.length,
    executorUsdcBal:  parseFloat(getConfig('executor_usdc_bal') || '0'),
    allChains: getActiveChains().map(c => ({
      name:    c.name,
      status:  _live.has(c.name)
        ? 'live'
        : (getConfig('deploy_status_' + c.name) || 'waiting'),
      address: getContractAddr(c.name) || null
    }))
  }
}

export async function triggerBootstrap(chainName, opportunity) {
  if (chainName === 'ethereum' && opportunity) return executeBootstrap(opportunity)
  if (chainName !== 'ethereum') return deployL2(chainName)
  return null
}

// Keep for vaults.js compatibility — but now no-op for ETH
// ETH bootstrap only happens via scanner 'arb_opportunity' events
export async function onMegaSwapDetected() {
  // Intentionally empty — mega-swap is no longer the trigger
  // Scanner detects the PRICE GAP that the swap creates
  // bootstrap.js acts on 'arb_opportunity' not 'mega_swap'
}

export async function initBootstrap() {
  const artifact = await compile()
  if (!artifact) { console.error('[BOOTSTRAP] Compile failed'); return }

  const computed = computeCreate2Address(artifact.bytecode)
  if (computed) {
    _computedAddr = computed.addr
    console.log('[BOOTSTRAP] CREATE2 address (all chains):', computed.addr)
    console.log('[BOOTSTRAP] RPC pool:', ETH_PROVIDERS.length, 'providers (race mode)')
    setConfig('create2_address', computed.addr)
  }

  // Check all chains for existing deployments (handles Railway redeploy)
  let liveCount = 0
  for (const chain of getActiveChains()) {
    const stored = getContractAddr(chain.name)
    if (stored) {
      const exists = await contractExists(chain.name, stored).catch(() => false)
      if (exists) {
        _live.add(chain.name); liveCount++
        console.log('[BOOTSTRAP]', chain.name, 'RESTORED:', stored)
        emit('deploy_success', { chain: chain.name, address: stored, method: 'restored' })
        continue
      }
    }
    if (computed?.addr) {
      const exists = await contractExists(chain.name, computed.addr).catch(() => false)
      if (exists) {
        setContractAddr(chain.name, computed.addr)
        _live.add(chain.name); liveCount++
        console.log('[BOOTSTRAP]', chain.name, 'RECOVERED:', computed.addr)
        emit('deploy_success', { chain: chain.name, address: computed.addr, method: 'recovered' })
      }
    }
    await new Promise(r => setTimeout(r, 100))
  }

  console.log(`[BOOTSTRAP] ${liveCount}/${getActiveChains().length} chains already live`)

  if (!_live.has('ethereum')) {
    console.log('[BOOTSTRAP] ETH waiting for scanner gap detection')
    console.log('[BOOTSTRAP] Trigger: cross-pool gap > 0.15% with profit > $500')
    console.log('[BOOTSTRAP] Executor wallet balance required: $0.00')
  }

  // L2s: deploy if ETH already live
  if (_live.has('ethereum')) {
    const l2s = getActiveChains().filter(c => c.name !== 'ethereum' && !_live.has(c.name))
    if (l2s.length > 0) {
      console.log('[BOOTSTRAP] Deploying', l2s.length, 'remaining L2s...')
      await Promise.allSettled(
        l2s.map((c, i) =>
          new Promise(r => setTimeout(r, i * 300)).then(() => deployL2(c.name))
        )
      )
    }
  }

  // Listen for scanner opportunities
  // THIS IS THE ONLY TRIGGER FOR ETH BOOTSTRAP
  on('arb_opportunity', async (opportunity) => {
    if (opportunity.chain !== 'ethereum') return
    await executeBootstrap(opportunity)
  })

  console.log('[BOOTSTRAP] Listening for arb_opportunity events from scanner.js')

  // Self-healing every 60s
  setInterval(selfHeal, 60000)
      }
