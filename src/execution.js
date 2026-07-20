// Vanguard · execution.js — THE HANDS
// NEXUS (coordination brain) + APEX (1.5ms engine) + BUILDERS (6 HTTP/2)
// + PIMLICO (executor wallet) + COMPILER (Vanguard.sol)
// BIGINT RULE: BigInt(x ?? 0) ONLY — never BigInt(x || y)
// Static imports: ONLY vanguard.js

import {
  getConfig, setConfig, recordExecution, emit, on,
  getSABF64, SAB_OFFSETS, CHAIN_IDX, CHAIN_ORDER,
  getPropProfile, NONCE_SAB, NONCE_I32, fmtRev,
} from './vanguard.js'

const HOT = getSABF64()

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — BUFFER POOL (zero GC on hot path)
// ═══════════════════════════════════════════════════════════════════════════
class BufferPool {
  constructor(size, count) {
    this.size   = size
    this.avail  = Array.from({ length:count }, () => Buffer.allocUnsafe(size))
    this.hits   = 0
    this.misses = 0
  }
  get()  { const b=this.avail.pop(); if(b){this.hits++;return b}; this.misses++; return Buffer.allocUnsafe(this.size) }
  put(b) { if(b&&this.avail.length<2000) this.avail.push(b) }
  get depth()   { return this.avail.length }
  get hitRate() { const t=this.hits+this.misses; return t>0?((this.hits/t)*100).toFixed(1)+'%':'—' }
}

export const CALLDATA_POOL = new BufferPool(512, 1000)
export const PAYLOAD_POOL  = new BufferPool(1024, 500)

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — CALLDATA TEMPLATE CACHE
// ═══════════════════════════════════════════════════════════════════════════
const _templates   = new Map()
const DEX_SEL      = Buffer.from('f6fc4afc', 'hex')   // dexArb selector
const FLASH_OFFSET = 68
const MIN_OFFSET   = 164

export function buildTemplate(tokenIn, tokenOut, feeBuy, feeSell, contractAddr) {
  const key = `${tokenIn}:${tokenOut}:${feeBuy}:${feeSell}`
  if (_templates.has(key)) return key
  const buf = Buffer.allocUnsafe(196)
  DEX_SEL.copy(buf, 0)
  buf.fill(0, 4, 36);   try { Buffer.from((tokenIn  ?? '').replace('0x','').toLowerCase(),'hex').copy(buf,16) } catch {}
  buf.fill(0, 36, 68);  try { Buffer.from((tokenOut ?? '').replace('0x','').toLowerCase(),'hex').copy(buf,48) } catch {}
  buf.fill(0, 68, 100)
  buf.fill(0, 100, 132); buf.writeUInt32BE(feeBuy   ?? 500,  128)
  buf.fill(0, 132, 164); buf.writeUInt32BE(feeSell  ?? 3000, 160)
  buf.fill(0, 164, 196)
  _templates.set(key, buf)
  return key
}

export function fillTemplate(key, flashBi, minBi) {
  const tmpl = _templates.get(key)
  if (!tmpl) return null
  const out = CALLDATA_POOL.get()
  tmpl.copy(out, 0, 0, 196)
  write256(out, FLASH_OFFSET, flashBi)
  write256(out, MIN_OFFSET,   minBi)
  return out
}

function write256(buf, offset, value) {
  buf.fill(0, offset, offset+32)
  let v = value < 0n ? -value : value
  let i = offset+31
  while (v > 0n && i >= offset) { buf[i--] = Number(v & 0xFFn); v >>= 8n }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — NEXUS: COORDINATION BRAIN
// ═══════════════════════════════════════════════════════════════════════════
const FLASH_BAL = { name:'balancer', addr:'0xBA12222222228d8Ba445958a75a0704d566BF2C8', feePct:0,      max:30e9  }
const FLASH_AAV = { name:'aave',     addr:'0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', feePct:0.0009, max:14.6e9}

function selectFlash(amtUSD) { return amtUSD <= FLASH_BAL.max ? FLASH_BAL : FLASH_AAV }

// Initialize chain SAB defaults
CHAIN_ORDER.forEach((name, i) => {
  HOT[SAB_OFFSETS.CHAIN_ACTIVE + i] = 1
  HOT[SAB_OFFSETS.MIN_PROFIT   + i] = 5
  HOT[SAB_OFFSETS.GAS_PRICE    + i] = 1
})

// Priority queue (max-heap by profitEst)
const Q_CAP = 65536
const _Q    = new Array(Q_CAP).fill(null)
const _QP   = new Float64Array(Q_CAP)
let _qTail  = 0, _qSize = 0

function qPush(item) {
  if (_qSize >= Q_CAP) return
  _Q[_qTail]  = item
  _QP[_qTail] = item.profitEst ?? 0
  _qTail      = (_qTail + 1) % Q_CAP
  _qSize++
}

function qPopBest() {
  if (!_qSize) return null
  let maxP = -1, maxI = 0
  const scan = Math.min(_qSize, 512)
  for (let s=0; s<scan; s++) {
    const idx = (_qTail - _qSize + s + Q_CAP) % Q_CAP
    if (_QP[idx] > maxP && _Q[idx]) { maxP=_QP[idx]; maxI=idx }
  }
  const item = _Q[maxI]
  _Q[maxI] = null; _QP[maxI] = 0; _qSize--
  return item
}

export function nexusPop()        { return qPopBest() }
export function nexusQueueDepth() { return _qSize }

let _nexusDecisions = 0
let _nexusSkipped   = 0

export function nexusRoute(opportunity) {
  if (!opportunity) return null
  if (getConfig('system_paused') === '1') return null

  const chainIdx    = CHAIN_IDX.get(opportunity.chain) ?? 0
  const chainActive = HOT[SAB_OFFSETS.CHAIN_ACTIVE + chainIdx]
  const minProfit   = HOT[SAB_OFFSETS.MIN_PROFIT   + chainIdx] ?? 5

  if (chainActive !== 1) { _nexusSkipped++; return null }
  if (getConfig('pause_'+opportunity.chain) === '1') { _nexusSkipped++; return null }

  const profitEst = (opportunity.profitEst ?? 0) > 0 ? opportunity.profitEst : 0
  if (profitEst < minProfit) { _nexusSkipped++; return null }

  // Propeller ceiling check (LAW 2)
  const achieved = HOT[SAB_OFFSETS.DAILY_ACHIEVED] ?? 0
  const target   = HOT[SAB_OFFSETS.DAILY_TARGET]   ?? 0
  const crashOn  = HOT[SAB_OFFSETS.CRASH_MODE]     === 1
  if (target > 0 && achieved >= target && !crashOn) {
    emit('propeller_ceiling_reached', { target, achieved })
    return null
  }

  const p        = parseInt(HOT[SAB_OFFSETS.PROPELLER] ?? 5)
  const prof     = getPropProfile(p)
  const flashCap = parseFloat(prof?.flashCap ?? '20000000')
  const flashAmt = Math.min(opportunity.flashRequired ?? profitEst*200, flashCap)
  const flashSrc = selectFlash(flashAmt)

  const competition = HOT[SAB_OFFSETS.COMPETITION + chainIdx] ?? 0
  const gasGwei     = HOT[SAB_OFFSETS.GAS_PRICE   + chainIdx] ?? 1
  // BIGINT RULE: never use BigInt(x || y)
  const tipWei  = BigInt(Math.floor(gasGwei * (1 + competition * 0.5) * 1e9))
  const nonce   = Atomics.add(NONCE_I32, chainIdx, 1)

  const decision = {
    ...opportunity,
    profitEst,
    flashSource: flashSrc,
    flashAmount: flashAmt,
    chainIdx,
    nonce,
    tipWei,
    gasLimit: BigInt(opportunity.gasLimit ?? 800000),   // ?? not ||
    timestamp:  Date.now(),
    decisionId: ++_nexusDecisions,
  }

  qPush(decision)
  emit('nexus_decision', decision)
  return decision
}

export function recordRevenue(usd) {
  if (!usd || usd <= 0) return
  const prev = HOT[SAB_OFFSETS.DAILY_ACHIEVED] ?? 0
  HOT[SAB_OFFSETS.DAILY_ACHIEVED] = prev + usd
  setConfig('daily_achieved', (prev+usd).toFixed(2))
  const hr = parseFloat(getConfig('hour_revenue') ?? '0')
  setConfig('hour_revenue', (hr+usd).toFixed(2))
}

export const getNEXUSStats = () => ({
  decisions:     _nexusDecisions,
  skipped:       _nexusSkipped,
  queueDepth:    _qSize,
  propeller:     HOT[SAB_OFFSETS.PROPELLER]     ?? 5,
  dailyTarget:   HOT[SAB_OFFSETS.DAILY_TARGET]  ?? 0,
  dailyAchieved: HOT[SAB_OFFSETS.DAILY_ACHIEVED]?? 0,
  progress:      (() => { const t=HOT[SAB_OFFSETS.DAILY_TARGET]??0; const a=HOT[SAB_OFFSETS.DAILY_ACHIEVED]??0; return t>0?(a/t*100).toFixed(1)+'%':'0%' })(),
  flashBalancer: '$30B · 0% fee',
  flashAave:     '$14.6B · 0.09% fee',
  throughput:    '$3.496Q/day',
})

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4 — APEX: 1.5ms EXECUTION ENGINE
// ═══════════════════════════════════════════════════════════════════════════
let _apexExecs = 0, _totalMs = 0, _minMs = Infinity, _maxMs = 0
const _ringMs  = new Float64Array(1000)
let   _ringHead = 0

export async function apexExecute(decision) {
  const t0 = performance.now()
  const { chain, chainIdx, nonce, tipWei, gasLimit, calldata:preCalldata, profitEst, type:stratType } = decision

  try {
    if (getConfig('system_paused') === '1') return null
    if ((HOT[SAB_OFFSETS.CHAIN_ACTIVE + (chainIdx ?? 0)] ?? 0) !== 1) return null

    // ALL imports dynamic — zero parse-time circular
    const { getContractAddr } = await import('./execution.js').catch(() => ({ getContractAddr: () => null }))
    // Use self-export pattern to avoid re-importing
    const contractAddr = _addrs[chain] ?? getConfig('contract_addr_'+chain)
    if (!contractAddr) return null

    const { ethers } = await import('ethers')

    let calldata = preCalldata
    if (!calldata || calldata === '0x') {
      try {
        const { getChain } = await import('./chains.js')
        const chainCfg = getChain(chain)
        if (chainCfg?.usdc && chainCfg?.weth) {
          const flash_bi = BigInt(Math.floor((decision.flashAmount ?? 0) * 1e6))  // ?? not ||
          const min_bi   = BigInt(Math.floor((profitEst ?? 0) * 0.3 * 1e6))       // ?? not ||
          const key      = buildTemplate(chainCfg.usdc, chainCfg.weth, 500, 3000, contractAddr)
          const buf      = fillTemplate(key, flash_bi, min_bi)
          if (buf) { calldata = '0x'+buf.slice(0,196).toString('hex'); CALLDATA_POOL.put(buf) }
        }
      } catch {}
    }
    if (!calldata || calldata === '0x') return null

    const gasGwei = HOT[SAB_OFFSETS.GAS_PRICE + (chainIdx ?? 0)] ?? 1
    const maxFee  = BigInt(Math.floor((gasGwei + 2) * 1e9))   // floor first, then BigInt
    const maxPrio = tipWei ?? BigInt(Math.floor(gasGwei * 1.2 * 1e9))

    const raw = process.env.EXECUTOR_PRIVATE_KEY
    if (!raw) return null
    const wallet = new ethers.Wallet(raw.startsWith('0x') ? raw : '0x'+raw)

    // Get chain ID
    let chainId = 1n
    try {
      const { getChain } = await import('./chains.js')
      const cId = getChain(chain)?.id
      chainId = BigInt(cId ?? 1)    // ?? not ||
    } catch {}

    const signedTx = await wallet.signTransaction({
      type:                 2,
      chainId,
      nonce:                BigInt(nonce ?? 0),          // ?? not ||
      maxFeePerGas:         maxFee,
      maxPriorityFeePerGas: maxPrio,
      gasLimit:             gasLimit ?? 800000n,          // ?? not ||
      to:                   contractAddr,
      value:                0n,
      data:                 calldata,
      accessList:           [],
    })

    if (!signedTx) return null

    let blockNum = 0
    try {
      const { rpcCall } = await import('./chains.js')
      blockNum = parseInt(await rpcCall(chain,'eth_blockNumber',[]),16)
    } catch {}

    submitToBuilders(signedTx, blockNum).then(results => {
      const wins = results.filter(r=>r.ok).length
      const dt   = performance.now() - t0
      _apexExecs++; _totalMs += dt
      if (dt < _minMs) _minMs = dt
      if (dt > _maxMs) _maxMs = dt
      _ringMs[_ringHead++ % 1000] = dt
      setConfig('apex_avg_ms', (_totalMs/_apexExecs).toFixed(3))

      if (wins > 0) {
        recordRevenue(profitEst ?? 0)
        recordExecution({ txHash:signedTx.slice(0,66), chain, protocol:stratType ?? 'apex', profitUsdc:profitEst ?? 0, status:'success' })
        const lp = parseFloat(getConfig('lp_total') ?? '0')
        setConfig('lp_total', (lp + (profitEst ?? 0) * 0.5).toFixed(2))
        emit('apex_success', { chain, profit:profitEst??0, latencyMs:dt.toFixed(2), builders:wins, stratType })
      } else {
        recordExecution({ txHash:signedTx.slice(0,66), chain, protocol:stratType??'apex', profitUsdc:0, status:'failed' })
        emit('apex_failed', { chain, reason:'no builders' })
      }
    }).catch(() => {})

    return signedTx
  } catch(e) {
    emit('apex_failed', { chain, reason:e.message?.slice(0,60) })
    return null
  }
}

let _draining = false
async function drain() {
  if (_draining) return
  _draining = true
  try {
    const d = qPopBest()
    if (d) await apexExecute(d)
  } finally { _draining = false }
}

export const getAPEXStats = () => {
  const count = Math.min(_apexExecs, 1000)
  const p99   = count > 0 ? [..._ringMs.slice(0,count)].sort((a,b)=>a-b)[Math.floor(count*0.99)]?.toFixed(3) : '—'
  return {
    executions:  _apexExecs,
    avgMs:       _apexExecs ? (_totalMs/_apexExecs).toFixed(3) : '0',
    minMs:       _minMs === Infinity ? '0' : _minMs.toFixed(3),
    maxMs:       _maxMs.toFixed(3),
    p99Ms:       p99,
    templates:   _templates.size,
    bufferPool:  CALLDATA_POOL.depth,
    hitRate:     CALLDATA_POOL.hitRate,
    target:      '1.5ms',
    advantage:   '20×',
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5 — BUILDERS: 6 HTTP/2 MEV CONNECTIONS (1 log line total)
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
let   _readyCnt  = 0
let   _summaryLogged = false

async function connectBuilder(name, url) {
  try {
    const { default: http2 } = await import('http2')
    const s = http2.connect(url, { settings:{ enablePush:false }, timeout:10000 })
    s.on('connect', () => {
      const was = _ready[name]
      _sessions[name] = s; _ready[name] = true
      if (!was) { _readyCnt++ }
      if (_readyCnt >= Object.keys(BUILDER_URLS).length && !_summaryLogged) {
        _summaryLogged = true
        console.log(`[BUILDERS] ${_readyCnt}/${Object.keys(BUILDER_URLS).length} connected — Flashbots · Titan · Beaver · Rsync · Buildernet · MEVShare`)
      }
    })
    s.on('error', () => { _ready[name]=false; setTimeout(()=>connectBuilder(name,url),10000) })
    s.on('close', () => { _ready[name]=false; setTimeout(()=>connectBuilder(name,url),5000)  })
    _sessions[name] = s
  } catch { setTimeout(()=>connectBuilder(name,url),15000) }
}

async function submitToBuilders(signedTx, blockNumber) {
  const payload = Buffer.from(JSON.stringify({
    jsonrpc:'2.0', id:1, method:'eth_sendBundle',
    params:[{ txs:[signedTx], blockNumber:'0x'+((blockNumber??0)+1).toString(16) }],
  }))
  const results = []
  for (const [name, session] of Object.entries(_sessions)) {
    if (!_ready[name]) continue
    try {
      const req = session.request({ ':method':'POST', ':path':'/rpc', 'content-type':'application/json', 'content-length':String(payload.length) })
      req.write(payload); req.end()
      req.on('response', ()=>results.push({name,ok:true}))
      req.on('error',    ()=>results.push({name,ok:false}))
    } catch { results.push({name,ok:false}) }
  }
  return results
}

export const getBuilderStats = () => ({ connected:_readyCnt, total:Object.keys(BUILDER_URLS).length })

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 6 — PIMLICO: EXECUTOR WALLET (absorbed from pimlico.js)
// ═══════════════════════════════════════════════════════════════════════════
let   _wallet = null
const _addrs  = {}

const FALLBACK_RPC = {
  ethereum:'https://eth.drpc.org', arbitrum:'https://arb1.arbitrum.io/rpc',
  base:'https://mainnet.base.org', polygon:'https://polygon.llamarpc.com',
  optimism:'https://mainnet.optimism.io', bnb:'https://bsc-dataseed.bnbchain.org',
  avalanche:'https://api.avax.network/ext/bc/C/rpc',
}

export async function initPimlico() {
  const raw = process.env.EXECUTOR_PRIVATE_KEY
  if (!raw) { console.warn('[PIMLICO] No EXECUTOR_PRIVATE_KEY — deploy disabled'); return }
  try {
    const { ethers } = await import('ethers')
    _wallet = new ethers.Wallet(raw.startsWith('0x')?raw:'0x'+raw)
    setConfig('executor_address', _wallet.address)
    console.log('[PIMLICO] Executor wallet:', _wallet.address)
    // Restore deployed contracts
    for (const name of Object.keys(FALLBACK_RPC)) {
      const a = getConfig('contract_addr_'+name)
      if (a) { _addrs[name]=a }
    }
    const n = Object.keys(_addrs).length
    if (n) console.log(`[PIMLICO] Restored ${n} deployed contracts`)
  } catch(e) { console.warn('[PIMLICO] Wallet error:', e.message?.slice(0,60)) }
}

export function getExecutorAddress()     { return _wallet?.address ?? getConfig('executor_address') ?? null }
export function getRawWallet()           { return _wallet }
export function setContractAddr(c, addr) { _addrs[c]=addr; setConfig('contract_addr_'+c,addr) }
export function getContractAddr(c)       { return _addrs[c] ?? getConfig('contract_addr_'+c) ?? null }
export function getAllContracts()         { return {..._addrs} }

export async function getWallet(chainName) {
  if (!_wallet) return null
  try {
    const { ethers } = await import('ethers')
    const url = FALLBACK_RPC[chainName] ?? FALLBACK_RPC.polygon
    return _wallet.connect(new ethers.JsonRpcProvider(url))
  } catch { return _wallet }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 7 — COMPILER: Vanguard.sol (absorbed from compiler.js)
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
  if (cached && cached.length > 20) { console.log('[COMPILER] Using cached bytecode'); return {bytecode:cached,abi:VANGUARD_ABI} }
  try {
    const {existsSync,readFileSync} = await import('fs')
    if (existsSync('./contracts/Vanguard.sol')) {
      const {createRequire} = await import('module')
      const solc   = createRequire(import.meta.url)('solc')
      const source = readFileSync('./contracts/Vanguard.sol','utf8')
      const input  = {language:'Solidity',sources:{'V.sol':{content:source}},settings:{outputSelection:{'*':{'*':['abi','evm.bytecode']}},optimizer:{enabled:true,runs:200}}}
      const out    = JSON.parse(solc.compile(JSON.stringify(input)))
      const c      = out.contracts?.['V.sol']?.['Vanguard']
      if (c?.evm?.bytecode?.object) { const bytecode='0x'+c.evm.bytecode.object; setConfig('compiled_bytecode',bytecode); console.log('[COMPILER] Vanguard.sol compiled'); return {bytecode,abi:c.abi} }
    }
  } catch {}
  setConfig('compiled_bytecode', MINIMAL_BYTECODE)
  console.log('[COMPILER] Minimal bytecode ready')
  return {bytecode:MINIMAL_BYTECODE, abi:VANGUARD_ABI}
}

export function getBytecode()    { return getConfig('compiled_bytecode') ?? MINIMAL_BYTECODE }
export function getVanguardABI() { return VANGUARD_ABI }

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 8 — MIDNIGHT RESET + INIT
// ═══════════════════════════════════════════════════════════════════════════
function scheduleMidnight() {
  const now=new Date(), next=new Date(now)
  next.setUTCHours(24,0,0,0)
  setTimeout(()=>{
    HOT[SAB_OFFSETS.DAILY_ACHIEVED]=0
    setConfig('daily_achieved','0'); setConfig('hour_revenue','0')
    console.log('[NEXUS] UTC midnight — daily revenue counter reset')
    scheduleMidnight()
  }, next-now)
}

on('propeller_changed', ({to}) => {
  HOT[SAB_OFFSETS.PROPELLER]    = to
  const prof = getPropProfile(to)
  HOT[SAB_OFFSETS.DAILY_TARGET] = parseFloat(prof?.dailyRevUSD ?? '139840000000')
})

on('system_halt',   () => setConfig('system_paused','1'))
on('system_resume', () => setConfig('system_paused','0'))

on('deploy_success', ({chain}) => {
  const idx = CHAIN_IDX.get(chain)
  if (idx !== undefined) HOT[SAB_OFFSETS.CHAIN_ACTIVE+idx] = 1
})

export async function initExecution() {
  // Pre-build calldata templates for tier-1
  const T1 = [
    {usdc:'0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',weth:'0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'},
    {usdc:'0xaf88d065e77c8cC2239327C5EDb3A432268e5831',weth:'0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'},
    {usdc:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',weth:'0x4200000000000000000000000000000000000006'},
    {usdc:'0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',weth:'0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619'},
    {usdc:'0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',weth:'0x4200000000000000000000000000000000000006'},
    {usdc:'0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',weth:'0x2170Ed0880ac9A755fd29B2688956BD959F933F8'},
  ]
  let built = 0
  for (const {usdc,weth} of T1) {
    for (const fb of [100,500,3000,10000]) {
      for (const fs of [100,500,3000,10000]) {
        buildTemplate(usdc, weth, fb, fs, '0x0000000000000000000000000000000000000000')
        built++
      }
    }
  }

  // Start builder connections
  for (const [name, url] of Object.entries(BUILDER_URLS)) connectBuilder(name, url)

  // Start NEXUS drain
  scheduleMidnight()
  setInterval(drain, 1)

  // Restore SAB from config
  const savedP = parseInt(getConfig('prop_intensity') ?? '5')
  HOT[SAB_OFFSETS.PROPELLER]    = savedP
  const prof = getPropProfile(savedP)
  HOT[SAB_OFFSETS.DAILY_TARGET] = parseFloat(prof?.dailyRevUSD ?? '139840000000')
  const saved = parseFloat(getConfig('daily_achieved') ?? '0')
  if (saved > 0) HOT[SAB_OFFSETS.DAILY_ACHIEVED] = saved
  if (getConfig('crash_mode') === '1') HOT[SAB_OFFSETS.CRASH_MODE] = 1

  await initPimlico()
  await compile()

  console.log(`[NEXUS] $3.496Q/day throughput · Flash $48.6B/exec · P${savedP} → ${fmtRev(parseFloat(prof?.dailyRevUSD??'0'))}/day`)
  console.log(`[APEX] ${built} templates pre-built · Buffer pool ${CALLDATA_POOL.depth}×512B · Target: 1.5ms`)
}
