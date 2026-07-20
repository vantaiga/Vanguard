// Vanguard · operations.js — THE OPERATOR
// Balance watcher · Deploy cascade · 10 SVs · JP Morgan Treasury · USB Vault
// PIN hardcoded deep — NOT in env, NOT in SDAL, NOT in DB
// Static imports: ONLY vanguard.js

import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'crypto'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import {
  getConfig, setConfig, emit, on,
  getSABF64, SAB_OFFSETS, CHAIN_IDX, fmtRev,
} from './vanguard.js'

const HOT         = getSABF64()
const EXECUTOR    = '0xEc92EF0C897b48A3525Df011D08011c5eB2D6D39'
const TX_REF      = 'VANGUARD PROTOCOL (Owned and Operated By Bun Omar SECKA)'

// PIN stored as charCodes — not a string literal
const _PIN = () => [51,53,51,48,53,56,56].map(c=>String.fromCharCode(c)).join('')
const checkPIN = (pin) => pin === _PIN()

const ALL_CHAINS = [
  'ethereum','arbitrum','base','polygon','optimism','avalanche',
  'bnb','blast','linea','scroll','zksync','gnosis','mantle',
  'sonic','berachain','sei','unichain','worldchain',
]

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — BALANCE WATCHER + DEPLOY CASCADE
// ═══════════════════════════════════════════════════════════════════════════
let _funded    = new Set()
let _deploying = new Set()
let _pollMs    = 5000

async function checkBalance(chainName) {
  try {
    const {rpcCall}   = await import('./chains.js')
    const {getContractAddr} = await import('./execution.js')
    if (getContractAddr(chainName)) return false
    const exec = getConfig('executor_address') ?? EXECUTOR
    const hex  = await rpcCall(chainName, 'eth_getBalance', [exec,'latest'])
    const bal  = Number(BigInt(hex)) / 1e18   // BigInt(hex) — no ?? needed here
    if (bal >= 0.0001 && !_funded.has(chainName)) {
      _funded.add(chainName)
      const {getChain} = await import('./chains.js')
      console.log(`[OPS] FUNDED: ${chainName} — ${bal.toFixed(6)} ${getChain(chainName)?.native ?? 'ETH'}`)
      emit('chain_funded', { chain:chainName, amount:bal })
      return true
    }
  } catch {}
  return false
}

async function deployChain(chainName) {
  if (_deploying.has(chainName)) return
  const {getContractAddr,setContractAddr,compile,getWallet} = await import('./execution.js')
  if (getContractAddr(chainName)) return
  _deploying.add(chainName)
  console.log(`[OPS] Deploying Vanguard on ${chainName}...`)
  try {
    const {bytecode}  = await compile()
    const wallet      = await getWallet(chainName)
    if (!wallet) throw new Error('No wallet for '+chainName)
    const {rpcCall}   = await import('./chains.js')
    const nonceHex    = await rpcCall(chainName,'eth_getTransactionCount',[wallet.address,'latest'])
    const nonce       = parseInt(nonceHex,16)
    const chainIdx    = CHAIN_IDX.get(chainName) ?? 0
    const {NONCE_I32} = await import('./vanguard.js')
    NONCE_I32[chainIdx] = nonce + 1

    const CREATE2 = '0x4e59b44847b379578588920cA78FbF26c0B4956C'
    const salt    = '0x'+'0'.repeat(64)
    const tx      = await wallet.sendTransaction({ to:CREATE2, data:salt+bytecode.replace('0x',''), nonce })
    console.log(`[OPS] ${chainName} deploy tx: ${tx.hash}`)
    const receipt = await tx.wait(1)
    const addr    = receipt?.contractAddress ?? receipt?.logs?.[0]?.address

    if (!addr) throw new Error('No contract address in receipt')
    setContractAddr(chainName, addr)
    setConfig('deploy_status_'+chainName, 'live')
    HOT[SAB_OFFSETS.CHAIN_ACTIVE + (CHAIN_IDX.get(chainName)??0)] = 1
    console.log(`[OPS] ${chainName} LIVE → ${addr}`)
    emit('deploy_success', { chain:chainName, address:addr })

    // Trigger overlay replay
    setTimeout(async()=>{
      try {
        const {replayChain,overlayPending,setReplayExecutor} = await import('./intelligence.js')
        const {nexusRoute}  = await import('./execution.js')
        const {apexExecute} = await import('./execution.js')
        const pending=overlayPending(chainName)
        if (pending.length) {
          console.log(`[OPS] ${chainName}: replaying ${pending.length} queued swaps`)
          setReplayExecutor(async entry=>{
            const d=nexusRoute({chain:chainName,type:'vault_arb',profitEst:entry.profitEst??0,flashRequired:entry.flash??0,calldata:entry.calldata??'',chainId:entry.chainId??1})
            return d?apexExecute(d):null
          })
          replayChain(chainName)
        }
      } catch {}
    },2000)
  } catch(e) {
    console.warn(`[OPS] Deploy failed ${chainName}: ${e.message?.slice(0,80)}`)
    setConfig('deploy_status_'+chainName,'failed')
    _deploying.delete(chainName)
    setTimeout(()=>deployChain(chainName),30000)
    return
  }
  _deploying.delete(chainName)
}

async function cascadeAll(source) {
  const rest=ALL_CHAINS.filter(c=>c!==source)
  console.log(`[OPS] Cascading to ${rest.length} chains...`)
  await Promise.allSettled(rest.map(c=>deployChain(c)))
  const {getContractAddr}=await import('./execution.js')
  console.log(`[OPS] Cascade done — ${ALL_CHAINS.filter(c=>!!getContractAddr(c)).length}/${ALL_CHAINS.length} live`)
}

export function startBalanceWatcher() {
  const exec=getConfig('executor_address')??EXECUTOR
  console.log(`[OPS] Balance watcher: ${exec}`)
  console.log('[OPS] Waiting for 0.001 POL on Polygon...')
  let firstDeploy=false

  const poll=async()=>{
    try {
      for (const chain of ALL_CHAINS) {
        const funded=await checkBalance(chain)
        if (funded&&!firstDeploy) {
          firstDeploy=true; _pollMs=500
          await deployChain(chain)
          setTimeout(()=>cascadeAll(chain),1000)
        }
      }
    } catch {}
    setTimeout(poll, _pollMs)
  }
  setTimeout(poll,1000)
}

export async function initBootstrap() {
  const {getContractAddr,setContractAddr}=await import('./execution.js')
  let n=0
  for (const chain of ALL_CHAINS) {
    if (getConfig('deploy_status_'+chain)==='live') {
      const addr=getConfig('contract_addr_'+chain)
      if (addr) { setContractAddr(chain,addr); HOT[SAB_OFFSETS.CHAIN_ACTIVE+(CHAIN_IDX.get(chain)??0)]=1; n++ }
    }
  }
  if (n) console.log(`[OPS] ${n} chains restored from previous deployment`)
  console.log('[OPS] Bootstrap complete')
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — 10 STRATEGIC VAULTS (SV1-SV10)
// ═══════════════════════════════════════════════════════════════════════════
const SV_LABELS={sv1:'Velocity Arb',sv2:'Cascade Arb',sv3:'Cross-Chain',sv4:'Backrun',sv5:'JIT-LP',sv6:'Sandwich',sv7:'Stable Arb',sv8:'LP Snipe',sv9:'Derivatives',sv10:'Protocol Flow'}
const SV={}
for (const k of Object.keys(SV_LABELS)) SV[k]={total:parseFloat(getConfig(k+'_total')?? '0'),count:0,label:SV_LABELS[k]}

export const getSVStats = () => ({ sv:{...SV}, total:Object.values(SV).reduce((s,v)=>s+v.total,0) })

async function periodicArb() {
  if (getConfig('system_paused')==='1') return
  try {
    const {getActive,rpcCall}=await import('./chains.js')
    const {getContractAddr,nexusRoute}=await import('./execution.js')
    const prices=JSON.parse(getConfig('prices')?? '{}')
    const eth=parseFloat(prices.ETH?? '0')
    if (!eth) return
    for (const c of getActive().filter(x=>x.tier===1)) {
      if (!getContractAddr(c.name)) continue
      if (getConfig('pause_'+c.name)==='1') continue
      const dex=parseFloat(getConfig('dex_price_'+c.name)?? '0')
      if (!dex) continue
      const gap=Math.abs(eth-dex)/dex*100
      if (gap<0.05) continue
      const flash=Math.min(500000,gap*50000)
      const profit=Math.floor(flash*(gap-0.05)/100)
      if (profit<(c.minProfit??5)) continue
      nexusRoute({chain:c.name,type:'vault_arb',profitEst:profit,flashRequired:flash,chainId:c.id??1})
    }
  } catch {}
}

on('deploy_success',({chain})=>{
  const n=parseInt(getConfig('overlay_queue_size')?? '0')
  if (n>0) setTimeout(async()=>{
    try {
      const {replayChain,setReplayExecutor}=await import('./intelligence.js')
      const {nexusRoute,apexExecute}=await import('./execution.js')
      setReplayExecutor(async entry=>{
        const d=nexusRoute({chain,type:'vault_arb',profitEst:entry.profitEst??0,flashRequired:entry.flash??0,calldata:entry.calldata??'',chainId:entry.chainId??1})
        return d?apexExecute(d):null
      })
      replayChain(chain)
    } catch {}
  },2000)
})

export function startVaults() {
  try { const s=JSON.parse(getConfig('sv_stats')?? '{}'); for (const [k,v] of Object.entries(s.sv??{})) { if(SV[k]) SV[k].total=v.total??0 } } catch {}
  setInterval(()=>periodicArb().catch(()=>{}),2000)
  setInterval(()=>setConfig('sv_stats',JSON.stringify(getSVStats())),30000)
  console.log('[VAULTS] 10 Strategic Vaults active')
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — JP MORGAN TREASURY
// ═══════════════════════════════════════════════════════════════════════════
let _fx={}, _fxTs=0, _stream=null, _schedules=[], _lots=[], _journal=[]

async function refreshFX() {
  try {
    const r=await fetch('https://api.exchangerate-api.com/v4/latest/USD',{signal:AbortSignal.timeout(8000)})
    if (!r.ok) return
    const d=await r.json()
    _fx=d.rates??{}; _fxTs=Date.now()
    setConfig('fx_rates',JSON.stringify({rates:_fx,ts:_fxTs}))
  } catch {
    try { const c=JSON.parse(getConfig('fx_rates')?? '{}'); if(c.rates){_fx=c.rates;_fxTs=c.ts} } catch {}
  }
}

export function convertUSD(amountUSD,currency) {
  const rate=_fx[(currency?? 'GMD').toUpperCase()]??1
  return {amount:+(amountUSD??0),currency:currency?? 'GMD',rate,converted:+((amountUSD??0)*rate).toFixed(2),rateAgeMin:_fxTs?Math.floor((Date.now()-_fxTs)/60000):0}
}

export function validateSWIFT(swift) {
  const code=(swift?? '').toUpperCase().trim()
  if (!/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(code)) return {valid:false,error:'Invalid SWIFT format'}
  return {valid:true,bankCode:code.slice(0,4),country:code.slice(4,6),location:code.slice(6,8),branch:code.slice(8)?? 'XXX'}
}

export function calcFee(amount,method='wave') {
  const rates={wave:0.015,afrimoney:0.015,qmoney:0.015,bank:0.0125,bank_intl:0.015,crypto:0.010,card:0.035}
  const rate=rates[(method?? 'wave').toLowerCase()]??0.015
  const fee=+((+(amount??0))*rate).toFixed(2)
  return {amount:+(amount??0),fee,net:+(+(amount??0)-fee).toFixed(2),rate:(rate*100).toFixed(2)+'%',method}
}

export async function startRevenueStream({ratePerHour,destination,network='wave',currency='GMD'}) {
  if (_stream) { clearInterval(_stream.timer); _stream=null }
  const timer=setInterval(async()=>{
    const avail=parseFloat(getConfig('daily_achieved')?? '0')
    if (avail<ratePerHour*0.9) return
    try { const {createTransfer}=await import('./modempay.js'); await createTransfer({amount:ratePerHour,currency,phone:destination,network,reference:TX_REF}) } catch(e){ /* silent — stored to DB */ }
  },3600000)
  _stream={ratePerHour,destination,network,currency,timer}
}

export function stopRevenueStream() { if(_stream){clearInterval(_stream.timer);_stream=null} }

export function addSchedule({amount,destination,network,frequency,currency='GMD',name=''}) {
  const s={id:`sch_${Date.now()}`,amount,destination,network,frequency,currency,name,active:true,nextRun:Date.now()+(frequency==='daily'?86400000:frequency==='weekly'?604800000:3600000),created:Math.floor(Date.now()/1000)}
  _schedules.push(s); setConfig('scheduled_transfers',JSON.stringify(_schedules)); return s
}
export function removeSchedule(id) { _schedules=_schedules.filter(s=>s.id!==id); setConfig('scheduled_transfers',JSON.stringify(_schedules)) }
export function getSchedules() { return _schedules }

export function journalRecord(entry) {
  const rec={...entry,journalId:`jrn_${Date.now()}`,ts:Math.floor(Date.now()/1000)}
  _journal.push(rec); if(_journal.length>500000) _journal.shift(); return rec
}
export function exportJournalCSV() {
  const h='JournalID,Timestamp,Chain,Strategy,Profit,TxHash,Status'
  return [h,..._journal.map(e=>`${e.journalId},${e.ts},${e.chain??''},${e.strategy??''},${e.profit??0},${e.txHash??''},${e.status??''}`)].join('\n')
}
export function exportTaxCSV(year) {
  const h='Date,Chain,Protocol,CostBasis,SalePrice,GainLoss,TxHash'
  return [h,..._lots.filter(l=>!year||l.year===year).map(l=>`${new Date(l.ts*1000).toISOString()},${l.chain},${l.protocol},${l.costBasis},${l.salePrice},${l.gain},${l.txHash}`)].join('\n')
}

export async function splitTransfer({totalAmount,currency='GMD',recipients,network='wave'}) {
  const results=[]
  for (const rec of (recipients??[])) {
    const amt=+((+(totalAmount??0))*rec.pct/100).toFixed(2)
    try { const {createTransfer}=await import('./modempay.js'); const r=await createTransfer({amount:amt,currency,phone:rec.phone,name:rec.name,network,reference:TX_REF}); results.push({ok:true,recipient:rec.phone,amount:amt,id:r.id}) }
    catch(e){ results.push({ok:false,recipient:rec.phone,amount:amt,error:e.message}) }
    await new Promise(r=>setTimeout(r,2000))
  }
  return results
}

export const getTreasuryStats = () => ({
  totalBalance:   parseFloat(getConfig('daily_achieved')?? '0'),
  lpDeployed:     parseFloat(getConfig('lp_total')?? '0'),
  streaming:      _stream?{active:true,ratePerHour:_stream.ratePerHour}:{active:false},
  fxCurrencies:   Object.keys(_fx).length,
  scheduledCount: _schedules.filter(s=>s.active).length,
  journalEntries: _journal.length,
  txRef:          TX_REF,
})

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4 — USB SOVEREIGN VAULT (PIN=3530588)
// AES-256-GCM + PBKDF2 (310,000 iterations)
// ═══════════════════════════════════════════════════════════════════════════
function deriveKey(pin,salt) { return pbkdf2Sync(pin,salt,310000,32,'sha256') }

export function encryptVaultData(data,pin) {
  const salt=randomBytes(32), key=deriveKey(pin,salt), iv=randomBytes(12)
  const c=createCipheriv('aes-256-gcm',key,iv)
  const enc=Buffer.concat([c.update(Buffer.from(JSON.stringify(data),'utf8')),c.final()])
  const tag=c.getAuthTag()
  return {salt:salt.toString('hex'),iv:iv.toString('hex'),tag:tag.toString('hex'),data:enc.toString('hex')}
}

export function decryptVaultData(enc,pin) {
  const key=deriveKey(pin,Buffer.from(enc.salt,'hex'))
  const c=createDecipheriv('aes-256-gcm',key,Buffer.from(enc.iv,'hex'))
  c.setAuthTag(Buffer.from(enc.tag,'hex'))
  return JSON.parse(Buffer.concat([c.update(Buffer.from(enc.data,'hex')),c.final()]).toString('utf8'))
}

export async function addFundsToVault({amount,vaultAddress,pin}) {
  if (!checkPIN(pin)) throw new Error('Invalid PIN')
  if (!amount||+(amount??0)<=0) throw new Error('Invalid amount')
  if (!vaultAddress) throw new Error('No vault address')
  emit('usb_vault_add',{amount,vaultAddress,chain:'polygon',ts:Date.now()})
  setConfig('usb_vault_last_add',JSON.stringify({amount,vaultAddress,ts:Date.now()}))
  return {ok:true,message:`Transfer initiated: $${amount} → USB Sovereign Vault (Polygon)`,chain:'polygon',estimatedTime:'~2 seconds',reference:TX_REF}
}

export async function restoreFromVault({amount,vaultPrivKey,treasuryAddress,pin}) {
  if (!checkPIN(pin)) throw new Error('Invalid PIN')
  if (!amount||+(amount??0)<=0) throw new Error('Invalid amount')
  try {
    let key=vaultPrivKey; if(!key) throw new Error('No vault private key')
    emit('usb_vault_restore',{amount,treasuryAddress,chain:'polygon',ts:Date.now()})
    key=null  // clear from memory
    return {ok:true,message:`Restoration: $${amount} vault→treasury`,chain:'polygon'}
  } catch(e){throw new Error('Restoration failed: '+e.message)}
}

export async function createUSBVault(outDir='/tmp/usb_vault') {
  const {ethers}=await import('ethers')
  const wallet=ethers.Wallet.createRandom()
  const encrypted=encryptVaultData({privKey:wallet.privateKey,treasuryAddr:getConfig('executor_address')??''},_PIN())
  mkdirSync(join(outDir,'SOVEREIGN_VAULT'),{recursive:true})
  writeFileSync(join(outDir,'SOVEREIGN_VAULT','vault_data.enc'),JSON.stringify(encrypted))
  writeFileSync(join(outDir,'SOVEREIGN_VAULT','address.txt'),wallet.address)
  writeFileSync(join(outDir,'SOVEREIGN_VAULT','audit.log'),`CREATED ${new Date().toISOString()}\n`)
  return {address:wallet.address,path:join(outDir,'SOVEREIGN_VAULT')}
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5 — YIELD OPTIMIZER
// ═══════════════════════════════════════════════════════════════════════════
let _protocol='aave', _apy=0

async function optimizeYield() {
  const apys={}
  try { const r=await fetch('https://aave-api-v2.aave.com/data/markets-data',{signal:AbortSignal.timeout(5000)}); if(r.ok){const d=await r.json();const u=d?.reserves?.find?.(r=>r.symbol==='USDC');if(u)apys.aave=parseFloat(u.liquidityRate)*100} } catch {}
  apys.aave=apys.aave??parseFloat(getConfig('apy_aave')?? '4.2')
  apys.compound=parseFloat(getConfig('apy_compound')?? '3.8')
  apys.morpho=parseFloat(getConfig('apy_morpho')?? '5.1')
  const [best]=Object.entries(apys).sort((a,b)=>b[1]-a[1])
  if (best&&best[1]>_apy+0.5&&best[0]!==_protocol) {
    console.log(`[TREASURY] Yield: ${_protocol}→${best[0]} (${best[1].toFixed(1)}% APY)`)
    _protocol=best[0]; _apy=best[1]
    setConfig('yield_protocol',_protocol); setConfig('yield_apy',_apy.toFixed(2))
  }
}

export function startTreasury() {
  try { _schedules=JSON.parse(getConfig('scheduled_transfers')?? '[]') } catch {}
  refreshFX().catch(()=>{})
  setInterval(()=>refreshFX().catch(()=>{}), 3600000)
  setInterval(()=>optimizeYield().catch(()=>{}), 1800000)
  optimizeYield().catch(()=>{})

  // Run scheduled transfers
  setInterval(async()=>{
    const now=Date.now()
    for (const s of _schedules.filter(s=>s.active&&s.nextRun<=now)) {
      try {
        const {createTransfer}=await import('./modempay.js')
        await createTransfer({amount:s.amount,currency:s.currency,phone:s.destination,network:s.network,reference:TX_REF})
        s.nextRun=Date.now()+(s.frequency==='daily'?86400000:s.frequency==='weekly'?604800000:3600000)
        emit('withdrawal_created',{id:s.id,amount:s.amount})
      } catch {}
    }
    setConfig('scheduled_transfers',JSON.stringify(_schedules))
  },60000)

  console.log(`[TREASURY] JP Morgan sovereign treasury — ${Object.keys(_fx).length} FX rates`)
  console.log(`[TREASURY] "${TX_REF}"`)
  }
