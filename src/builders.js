// Vanguard · builders.js — MEV Builders + Executor Wallet + Compiler
// ONE log line total: "[BUILDERS] 6/6 connected"
// Zero reconnect spam. Zero per-builder connect logs.
// Absorbs: pimlico.js + compiler.js + builder connections

import http2      from 'http2'
import { ethers } from 'ethers'
import { getConfig, setConfig } from './db.js'

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — MEV BUILDER CONNECTIONS
// ═══════════════════════════════════════════════════════════════════════════

const BUILDER_URLS = {
  flashbots:   'https://relay.flashbots.net',
  titan:       'https://rpc.titanbuilder.xyz',
  beaverbuild: 'https://rpc.beaverbuild.org',
  rsync:       'https://rsync-builder.xyz',
  buildernet:  'https://rpc.buildernet.org',
  mevshare:    'https://mev-share.flashbots.net',
}

const _sessions  = {}
const _ready     = {}
let   _readyCount = 0
let   _loggedFinal = false

function connectBuilder(name, url) {
  try {
    const s = http2.connect(url, { settings: { enablePush: false }, timeout: 10000 })
    s.on('connect', () => {
      const wasReady = _ready[name]
      _sessions[name] = s
      _ready[name]    = true
      if (!wasReady) {
        _readyCount++
        // Only log once when ALL 6 are connected
        if (_readyCount >= Object.keys(BUILDER_URLS).length && !_loggedFinal) {
          _loggedFinal = true
          console.log(`[BUILDERS] ${_readyCount}/${Object.keys(BUILDER_URLS).length} connected`)
        }
      }
    })
    s.on('error', () => { _ready[name] = false; setTimeout(() => connectBuilder(name, url), 10000) })
    s.on('close', () => { _ready[name] = false; setTimeout(() => connectBuilder(name, url), 5000)  })
    _sessions[name] = s
  } catch {
    setTimeout(() => connectBuilder(name, url), 15000)
  }
}

export function initBuilderConnections() {
  for (const [name, url] of Object.entries(BUILDER_URLS)) connectBuilder(name, url)
}

export async function submitToBuilders(signedTx, blockNumber) {
  const payload = Buffer.from(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'eth_sendBundle',
    params: [{ txs: [signedTx], blockNumber: '0x' + ((blockNumber || 0) + 1).toString(16) }],
  }))
  const results = []
  for (const [name, session] of Object.entries(_sessions)) {
    if (!_ready[name]) continue
    try {
      const req = session.request({ ':method':'POST', ':path':'/rpc', 'content-type':'application/json', 'content-length':String(payload.length) })
      req.write(payload); req.end()
      req.on('response', () => results.push({ name, ok: true }))
      req.on('error',    () => results.push({ name, ok: false }))
    } catch { results.push({ name, ok: false }) }
  }
  return results
}

export async function submitPrivate(signedTx) {
  try {
    const r = await fetch('https://rpc.flashbots.net/fast', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_sendRawTransaction',params:[signedTx]}), signal:AbortSignal.timeout(5000) })
    return r.ok
  } catch { return false }
}

export const getBuilderStats = () => ({ connected: _readyCount, total: Object.keys(BUILDER_URLS).length, builders: Object.keys(BUILDER_URLS) })

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — EXECUTOR WALLET (was pimlico.js)
// ═══════════════════════════════════════════════════════════════════════════

let _wallet    = null
const _addrs   = {}

export function initPimlico() {
  const raw = process.env.EXECUTOR_PRIVATE_KEY
  if (!raw) { console.warn('[PIMLICO] No EXECUTOR_PRIVATE_KEY — deploy disabled'); return }
  try {
    _wallet = new ethers.Wallet(raw.startsWith('0x') ? raw : '0x' + raw)
    setConfig('executor_address', _wallet.address)
    console.log('[PIMLICO] Executor wallet:', _wallet.address)
    // Restore previously deployed addresses
    const CHAINS = ['ethereum','arbitrum','base','polygon','optimism','avalanche','bnb','blast','linea','scroll','zksync','gnosis','mantle','sonic','berachain','sei','unichain','worldchain','metis','mode']
    for (const c of CHAINS) { const a = getConfig('contract_addr_'+c); if (a) _addrs[c] = a }
    const restored = Object.keys(_addrs).length
    if (restored) console.log(`[PIMLICO] Restored ${restored} deployed contracts`)
  } catch(e) { console.error('[PIMLICO] Wallet error:', e.message?.slice(0,80)) }
}

export function getExecutorAddress() { return _wallet?.address || getConfig('executor_address') || null }

export function getWallet(chainName) {
  if (!_wallet) return null
  try {
    // Lazy import to avoid circular at parse time
    const rpcUrl = _chainRPC[chainName] || 'https://polygon.llamarpc.com'
    return _wallet.connect(new ethers.JsonRpcProvider(rpcUrl))
  } catch { return _wallet }
}

// RPC URLs for wallet connection (minimal set, not importing chains1.js)
const _chainRPC = {
  ethereum: 'https://eth.drpc.org', arbitrum: 'https://arb1.arbitrum.io/rpc',
  base:     'https://mainnet.base.org', polygon: 'https://polygon.llamarpc.com',
  optimism: 'https://mainnet.optimism.io', bnb: 'https://bsc-dataseed.bnbchain.org',
}

export function getRawWallet()              { return _wallet }
export function setContractAddr(c, addr)    { _addrs[c] = addr; setConfig('contract_addr_'+c, addr) }
export function getContractAddr(c)          { return _addrs[c] || getConfig('contract_addr_'+c) || null }
export function getAllContracts()            { return { ..._addrs } }

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — CONTRACT COMPILER (was compiler.js)
// ═══════════════════════════════════════════════════════════════════════════

const MINIMAL_BYTECODE = '0x6080604052348015600f57600080fd5b50336000806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff160217905550609e8060596000396000f3fe6080604052600080fdfea264697066735822'

export const VANGUARD_ABI = [
  'function dexArb(address,address,uint256,uint24,uint24,uint256) external',
  'function crossPoolArb(address,uint256,address,address,address,uint24,uint24,uint256,uint256,address) external',
  'function flashLiquidate(address,address,address,uint256,bool) external',
  'function sweep(address[],address) external',
  'function owner() external view returns (address)',
  'event ArbExecuted(address indexed,uint256)',
]

export async function compile() {
  const cached = getConfig('compiled_bytecode')
  if (cached && cached.length > 20) {
    console.log('[COMPILER] Using cached bytecode')
    return { bytecode: cached, abi: VANGUARD_ABI }
  }
  try {
    const { existsSync, readFileSync } = await import('fs')
    if (existsSync('./contracts/Vanguard.sol')) {
      const { createRequire } = await import('module')
      const solc    = createRequire(import.meta.url)('solc')
      const source  = readFileSync('./contracts/Vanguard.sol', 'utf8')
      const input   = { language:'Solidity', sources:{'V.sol':{content:source}}, settings:{outputSelection:{'*':{'*':['abi','evm.bytecode']}},optimizer:{enabled:true,runs:200}} }
      const output  = JSON.parse(solc.compile(JSON.stringify(input)))
      const contract= output.contracts?.['V.sol']?.['Vanguard']
      if (contract?.evm?.bytecode?.object) {
        const bytecode = '0x' + contract.evm.bytecode.object
        setConfig('compiled_bytecode', bytecode)
        console.log('[COMPILER] Vanguard.sol compiled')
        return { bytecode, abi: contract.abi }
      }
    }
  } catch {}
  setConfig('compiled_bytecode', MINIMAL_BYTECODE)
  console.log('[COMPILER] Minimal bytecode ready')
  return { bytecode: MINIMAL_BYTECODE, abi: VANGUARD_ABI }
}

export function getBytecode()   { return getConfig('compiled_bytecode') || MINIMAL_BYTECODE }
export function getVanguardABI(){ return VANGUARD_ABI }
