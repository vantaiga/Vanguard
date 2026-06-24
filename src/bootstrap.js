// X7-SV · bootstrap.js — ARCHITECTURE 1: Zero-Seed · Zero-Gas
// FIXED: constructor takes 5 args (weth now explicit)
// FIXED: bootstrapExecute passes executor address for profit sweep
// FIXED: amountOutMinimum=0 in X7.sol _roundTrip (no revert)

import { keccak256, encodePacked, encodeAbiParameters, parseAbiParameters } from 'viem'
import { getActiveChains, getChain } from './chains.js'
import { getContractAddr, setContractAddr, getExecutorAddress, getWalletClient, contractExists, sendTx, waitTx } from './pimlico.js'
import { compile, getArtifact } from './compiler.js'
import { getConfig, setConfig } from './db.js'
import { emit } from './events.js'

// ── CONSTANTS ─────────────────────────────────────────────────────────────────
const CREATE2_FACTORY   = '0x4e59b44847b379578588920cA78FbF26c0B4956C'
const FLASH_AMOUNT_WETH = 100000n * 10n**18n // pure BigInt — no float

// ── MULTI-PROVIDER ETH RPC POOL ───────────────────────────────────────────────
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
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc:'2.0', id:1, method, params }),
      signal: AbortSignal.timeout(timeoutMs)
    })
    .then(r => r.json())
    .then(d => {
      if (d.error) throw new Error(d.error.message)
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
const BUNDLE_COOLDOWN_MS = 13000

// ── CREATE2 PRE-COMPUTATION ───────────────────────────────────────────────────
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
  const saltPadded = salt.slice(2).padStart(64,'0')
  const offset     = '0000000000000000000000000000000000000000000000000000000000000040'
  const len        = Math.floor((initCode.length - 2) / 2)
  const lenHex     = len.toString(16).padStart(64,'0')
  const dataHex    = initCode.slice(2).padEnd(Math.ceil(len/32)*64,'0')
  return selector + saltPadded + offset + lenHex + dataHex
}

// FIXED: bootstrapExecute now takes executor address as last arg
// Signature: bootstrapExecute(address _weth, address _usdc, uint256 flashAmount,
//                              uint24 buyFee, uint24 sellFee, address executor)
function buildBootstrapCalldata(chain, executor) {
  if (!chain?.weth || !chain?.usdc) return null
  const selector = '0x' + keccak256(new TextEncoder().encode(
    'bootstrapExecute(address,address,uint256,uint24,uint24,address)'
  )).slice(2,10)
  const args = encodeAbiParameters(
    parseAbiParameters('address,address,uint256,uint24,uint24,address'),
    [chain.weth, chain.usdc, FLASH_AMOUNT_WETH, 500, 3000, executor]
  )
  return selector + args.slice(2)
}

// ── GAS PARAMS — EIP-1559 INVARIANT GUARANTEED ───────────────────────────────
// maxFeePerGas = baseFee*2 + tip — always >= tip regardless of network conditions
const TIPS = [1500000000n, 2000000000n, 3000000000n, 5000000000n]

async function getGasParams(attempt = 0) {
  const tip = TIPS[Math.min(attempt, TIPS.length - 1)]
  try {
    const block   = await ethRPC('eth_getBlockByNumber', ['latest', false])
    const baseFee = BigInt(block?.baseFeePerGas || '0x3b9aca00')
    const maxFee  = baseFee * 2n + tip
    return { maxFeePerGas: maxFee, maxPriorityFeePerGas: tip }
  } catch {
    return { maxFeePerGas: tip * 3n, maxPriorityFeePerGas: tip }
  }
}

// ── BUNDLE SUBMISSION ─────────────────────────────────────────────────────────
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
    jsonrpc:'2.0', id:1, method:'eth_sendBundle',
    params:[{ txs, blockNumber:blockHex, minTimestamp:0, maxTimestamp:Math.floor(Date.now()/1000)+60 }]
  })
  const results = await Promise.allSettled(
    BUILDERS.map(url =>
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body,
        signal: AbortSignal.timeout(3000)
      })
      .then(r => r.json())
      .then(d => ({ url, ok:!!d.result }))
      .catch(() => ({ url, ok:false }))
    )
  )
  return results
    .filter(r => r.status==='fulfilled' && r.value.ok)
    .map(r => r.value.url.split('/')[2])
}

// ── ETHEREUM ZERO-SEED BUNDLE ─────────────────────────────────────────────────
async function bootstrapEthereum(artifact) {
  if (_ethBundleInFlight) return null
  if (Date.now() - _lastBundleAttempt < BUNDLE_COOLDOWN_MS) return null

  const chain    = getChain('ethereum')
  const executor = getExecutorAddress()
  if (!chain?.weth || !chain?.usdc || !executor) return null

  const computed = computeCreate2Address(artifact.bytecode)
  if (!computed) return null
  const { addr, salt } = computed

  const alreadyLive = await contractExists('ethereum', addr).catch(() => false)
  if (alreadyLive) {
    setContractAddr('ethereum', addr)
    _live.add('ethereum')
    emit('deploy_success', { chain:'ethereum', address:addr, method:'already-live' })
    setTimeout(() => propagateToL2s().catch(() => {}), 3000)
    return addr
  }

  _ethBundleInFlight = true
  _lastBundleAttempt = Date.now()

  try {
    console.log('[BOOTSTRAP] ETH zero-seed bundle building...')
    console.log('[BOOTSTRAP] Target address:', addr)

    const wallet = getWalletClient('ethereum')
    if (!wallet) return null

    const [nonceHex, blockHex, gas] = await Promise.all([
      ethRPC('eth_getTransactionCount', [executor, 'pending']),
      ethRPC('eth_blockNumber', []),
      getGasParams(0)
    ])

    const nonce    = parseInt(nonceHex, 16)
    const blockNum = parseInt(blockHex, 16)

    console.log(`[BOOTSTRAP] nonce=${nonce} block=${blockNum} maxFee=${gas.maxFeePerGas/1000000000n}gwei tip=${gas.maxPriorityFeePerGas/1000000000n}gwei`)

    // FIXED: 5 constructor args (router, usdc, weth, balancer, aave)
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

    const deployCalldata = buildDeployCalldata(artifact.bytecode, constructorArgs, salt)

    // FIXED: pass executor so receiveFlashLoan sweeps profit to wallet
    const bootstrapCalldata = buildBootstrapCalldata(chain, executor)
    if (!bootstrapCalldata) return null

    // Sign deploy tx (nonce)
    let signedDeploy
    try {
      signedDeploy = await wallet.signTransaction({
        to: CREATE2_FACTORY, data: deployCalldata,
        nonce, gas: 600000n, chainId: 1, ...gas
      })
    } catch (e) {
      console.log('[BOOTSTRAP] Sign deploy failed:', e.message?.slice(0,120))
      return null
    }

    // Sign execute tx (nonce+1)
    let signedExec
    try {
      signedExec = await wallet.signTransaction({
        to: addr, data: bootstrapCalldata,
        nonce: nonce + 1, gas: 900000n, chainId: 1, ...gas
      })
    } catch (e) {
      console.log('[BOOTSTRAP] Sign exec failed:', e.message?.slice(0,120))
      return null
    }

    // Submit across 4 blocks with escalating tips
    for (let attempt = 0; attempt < 4; attempt++) {
      const targetBlock = blockNum + attempt + 1
      const tipGwei = gas.maxPriorityFeePerGas / 1000000000n
      console.log(`[BOOTSTRAP] ETH attempt ${attempt+1}/4 targeting block ${targetBlock} tip=${tipGwei}gwei`)

      const txs  = [signedDeploy, signedExec]
      const wins = await submitBundle(txs, targetBlock)
      submitBundle(txs, targetBlock + 1).catch(() => {}) // double coverage

      if (wins.length > 0) {
        console.log(`[BOOTSTRAP] ETH bundle accepted by: ${wins.join(', ')}`)
      }

      await new Promise(r => setTimeout(r, 12500))

      const deployed = await contractExists('ethereum', addr).catch(() => false)
      if (deployed) {
        setContractAddr('ethereum', addr)
        _live.add('ethereum')
        console.log('[BOOTSTRAP] ✓ ETH LIVE — zero-seed complete:', addr)
        emit('deploy_success', { chain:'ethereum', address:addr, method:'zero-seed' })
        setTimeout(() => propagateToL2s().catch(() => {}), 3000)
        return addr
      }

      if (attempt < 3) {
        const newGas = await getGasParams(attempt + 1)
        console.log(`[BOOTSTRAP] Escalating tip to ${newGas.maxPriorityFeePerGas/1000000000n}gwei`)
        try {
          signedDeploy = await wallet.signTransaction({
            to: CREATE2_FACTORY, data: deployCalldata,
            nonce, gas: 600000n, chainId: 1, ...newGas
          })
          signedExec = await wallet.signTransaction({
            to: addr, data: bootstrapCalldata,
            nonce: nonce + 1, gas: 900000n, chainId: 1, ...newGas
          })
          Object.assign(gas, newGas)
        } catch (e) {
          console.log('[BOOTSTRAP] Re-sign failed:', e.message?.slice(0,80))
        }
      }
    }

    // Final check
    const final = await contractExists('ethereum', addr).catch(() => false)
    if (final) {
      setContractAddr('ethereum', addr)
      _live.add('ethereum')
      console.log('[BOOTSTRAP] ✓ ETH LIVE (late confirm):', addr)
      emit('deploy_success', { chain:'ethereum', address:addr, method:'zero-seed-late' })
      setTimeout(() => propagateToL2s().catch(() => {}), 3000)
      return addr
    }

    console.log('[BOOTSTRAP] ETH bundle: 4 attempts exhausted — will retry on next mega-swap')
    return null

  } finally {
    _ethBundleInFlight = false
  }
}

// ── L2 SELF-PROPAGATION ───────────────────────────────────────────────────────
async function propagateToL2s() {
  const l2chains = getActiveChains().filter(c => c.name !== 'ethereum')
  console.log(`[BOOTSTRAP] Propagating to ${l2chains.length} L2s in parallel...`)
  await Promise.allSettled(
    l2chains.map((l2, i) =>
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
  const { addr, salt } = computed

  const onChain = await contractExists(chainName, addr).catch(() => false)
  if (onChain) {
    setContractAddr(chainName, addr)
    _live.add(chainName)
    console.log('[BOOTSTRAP]', chainName, 'already on-chain:', addr)
    emit('deploy_success', { chain:chainName, address:addr, method:'existing' })
    return addr
  }

  _deploying.add(chainName)
  setConfig('deploy_status_' + chainName, 'deploying')

  try {
    const chain = getChain(chainName)
    if (!chain) throw new Error('No chain config')

    // FIXED: 5 constructor args
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

    const deployCalldata = buildDeployCalldata(artifact.bytecode, constructorArgs, salt)
    const hash           = await sendTx(chainName, CREATE2_FACTORY, deployCalldata)
    if (!hash) throw new Error('sendTx null')

    const receipt = await waitTx(chainName, hash, 120000)
    if (!receipt || receipt.status === 'reverted') throw new Error('tx reverted')

    const verified = await contractExists(chainName, addr).catch(() => false)
    if (!verified) throw new Error('Not at CREATE2 address')

    setContractAddr(chainName, addr)
    _live.add(chainName)
    setConfig('deploy_status_' + chainName, 'live')
    _deploying.delete(chainName)

    console.log('[BOOTSTRAP] ✓', chainName, 'LIVE:', addr)
    emit('deploy_success', { chain:chainName, address:addr, method:'l2-direct' })
    return addr

  } catch (e) {
    console.error('[BOOTSTRAP]', chainName, e.message?.slice(0,100))
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
        if (chain.name === 'ethereum') {
          _ethBundleInFlight = false
          _lastBundleAttempt = 0
          onMegaSwapDetected().catch(() => {})
        } else {
          deployL2(chain.name).catch(() => {})
        }
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
    allChains: getActiveChains().map(c => ({
      name:    c.name,
      status:  _live.has(c.name) ? 'live' : (getConfig('deploy_status_'+c.name) || 'waiting'),
      address: getContractAddr(c.name) || null
    }))
  }
}

export async function triggerBootstrap(chainName) {
  const artifact = getArtifact()
  if (!artifact) return null
  if (chainName === 'ethereum') return bootstrapEthereum(artifact)
  return deployL2(chainName)
}

export async function onMegaSwapDetected() {
  if (_live.has('ethereum'))  return
  if (_ethBundleInFlight)     return
  if (Date.now() - _lastBundleAttempt < BUNDLE_COOLDOWN_MS) return
  const artifact = getArtifact()
  if (!artifact) return
  bootstrapEthereum(artifact).catch(e =>
    console.error('[BOOTSTRAP] ETH error:', e.message?.slice(0,80))
  )
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

  let liveCount = 0
  for (const chain of getActiveChains()) {
    const stored = getContractAddr(chain.name)
    if (stored) {
      const exists = await contractExists(chain.name, stored).catch(() => false)
      if (exists) {
        _live.add(chain.name); liveCount++
        console.log('[BOOTSTRAP]', chain.name, 'RESTORED:', stored)
        emit('deploy_success', { chain:chain.name, address:stored, method:'restored' })
        continue
      }
    }
    if (computed?.addr) {
      const exists = await contractExists(chain.name, computed.addr).catch(() => false)
      if (exists) {
        setContractAddr(chain.name, computed.addr)
        _live.add(chain.name); liveCount++
        console.log('[BOOTSTRAP]', chain.name, 'RECOVERED:', computed.addr)
        emit('deploy_success', { chain:chain.name, address:computed.addr, method:'recovered' })
      }
    }
    await new Promise(r => setTimeout(r, 100))
  }

  console.log(`[BOOTSTRAP] ${liveCount}/${getActiveChains().length} chains already live`)

  if (!_live.has('ethereum')) {
    console.log('[BOOTSTRAP] ETH waiting for zero-seed trigger (first $100M+ swap)')
    console.log('[BOOTSTRAP] Executor wallet balance required: $0.00')
    console.log('[BOOTSTRAP] RPC pool ready:', ETH_PROVIDERS.length, 'providers in race mode')
  }

  if (_live.has('ethereum')) {
    const l2s = getActiveChains().filter(c => c.name !== 'ethereum' && !_live.has(c.name))
    if (l2s.length > 0) {
      await Promise.allSettled(
        l2s.map((c, i) =>
          new Promise(r => setTimeout(r, i * 300)).then(() => deployL2(c.name))
        )
      )
    }
  }

  setInterval(selfHeal, 60000)
}
