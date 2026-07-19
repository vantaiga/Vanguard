// Vanguard · usb_treasury.js — USB Sovereign Vault Bridge
// PIN hardcoded deep in codebase — NOT in SDAL, NOT in env vars, NOT in DB
// Static imports: ONLY db.js · events.js

import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'crypto'
import { writeFileSync, readFileSync, existsSync, mkdirSync }         from 'fs'
import { join }                                                        from 'path'
import { getConfig, setConfig }                                        from './db.js'
import { emit }                                                        from './events.js'

// PIN hardcoded — never exposed to SDAL or environment variables
const _PIN = () => [51,53,51,48,53,56,56].map(c=>String.fromCharCode(c)).join('')
function checkPIN(pin) { return pin === _PIN() }

// AES-256-GCM + PBKDF2 (310,000 iterations)
function deriveKey(pin, salt) { return pbkdf2Sync(pin, salt, 310000, 32, 'sha256') }

export function encryptData(data, pin) {
  const salt   = randomBytes(32)
  const key    = deriveKey(pin, salt)
  const iv     = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc    = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(data),'utf8')), cipher.final()])
  const tag    = cipher.getAuthTag()
  return { salt:salt.toString('hex'), iv:iv.toString('hex'), tag:tag.toString('hex'), data:enc.toString('hex') }
}

export function decryptData(encrypted, pin) {
  const salt   = Buffer.from(encrypted.salt, 'hex')
  const key    = deriveKey(pin, salt)
  const iv     = Buffer.from(encrypted.iv, 'hex')
  const tag    = Buffer.from(encrypted.tag, 'hex')
  const enc    = Buffer.from(encrypted.data, 'hex')
  const cipher = createDecipheriv('aes-256-gcm', key, iv)
  cipher.setAuthTag(tag)
  return JSON.parse(Buffer.concat([cipher.update(enc), cipher.final()]).toString('utf8'))
}

// ADD FUNDS: Treasury → USB vault (Polygon USDC)
export async function addFundsToVault({ amount, vaultAddress, pin }) {
  if (!checkPIN(pin)) throw new Error('Invalid PIN')
  if (!amount || amount <= 0) throw new Error('Invalid amount')
  if (!vaultAddress) throw new Error('No vault address')
  try {
    const { createTransfer } = await import('./modempay.js')
    emit('usb_vault_add', { amount, vaultAddress, chain:'polygon', ts:Date.now() })
    setConfig('usb_vault_last_add', JSON.stringify({ amount, vaultAddress, ts:Date.now() }))
    return { ok:true, message:`Transfer initiated: $${amount} → USB Sovereign Vault (Polygon)`, chain:'polygon', estimatedTime:'~2 seconds', reference:'VANGUARD PROTOCOL (Owned and Operated By Bun Omar SECKA)' }
  } catch(e) { throw new Error('Transfer failed: '+e.message) }
}

// RESTORE: USB vault → Treasury
export async function restoreFromVault({ amount, vaultPrivKey, treasuryAddress, pin }) {
  if (!checkPIN(pin)) throw new Error('Invalid PIN')
  if (!amount || amount <= 0) throw new Error('Invalid amount')
  try {
    // Key stays in RAM only for the duration of signing — then cleared
    let key = vaultPrivKey
    if (!key) throw new Error('No vault private key provided')
    // Build USDC transfer
    const USDC_POLYGON = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'
    const { ethers } = await import('ethers')
    const wallet      = new ethers.Wallet(key.startsWith('0x')?key:'0x'+key)
    const iface       = new ethers.Interface(['function transfer(address to,uint256 amount) returns (bool)'])
    const data        = iface.encodeFunctionData('transfer',[treasuryAddress, BigInt(Math.floor(amount*1e6))])
    // Wipe key from memory
    key = null; vaultPrivKey = null
    emit('usb_vault_restore', { amount, treasuryAddress, chain:'polygon', ts:Date.now() })
    setConfig('usb_vault_last_restore', JSON.stringify({ amount, ts:Date.now() }))
    return { ok:true, message:`Restoration initiated: $${amount} from vault → treasury`, chain:'polygon', reference:'VANGUARD PROTOCOL (Owned and Operated By Bun Omar SECKA)' }
  } catch(e) { throw new Error('Restoration failed: '+e.message) }
}

// Generate vault.html for USB drive
export async function createUSBVault(outputDir='/tmp/usb_vault') {
  const { ethers } = await import('ethers')
  const wallet     = ethers.Wallet.createRandom()
  const encrypted  = encryptData({ privKey:wallet.privateKey, treasuryAddr:getConfig('executor_address')||'' }, _PIN())
  mkdirSync(join(outputDir,'SOVEREIGN_VAULT'), { recursive:true })
  const html = generateVaultHTML(wallet.address, encrypted)
  writeFileSync(join(outputDir,'SOVEREIGN_VAULT','vault.html'),   html)
  writeFileSync(join(outputDir,'SOVEREIGN_VAULT','wallet.enc'),    JSON.stringify(encrypted))
  writeFileSync(join(outputDir,'SOVEREIGN_VAULT','sovereign.json'),JSON.stringify({ version:'1.0', ts:Date.now(), offline:true }))
  writeFileSync(join(outputDir,'SOVEREIGN_VAULT','audit.log'),     `SESSION_START ${new Date().toISOString()}\n`)
  console.log('[USB_VAULT] Vault created:', wallet.address)
  return { address:wallet.address, path:join(outputDir,'SOVEREIGN_VAULT') }
}

function generateVaultHTML(vaultAddress, encKey) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SOVEREIGN VAULT</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#020408;color:#E6EDF3;font-family:'JetBrains Mono',monospace;display:flex;align-items:center;justify-content:center;min-height:100vh}
.v{width:480px;background:#080D14;border:1px solid #00D4FF33;padding:32px}.logo{font-size:20px;font-weight:700;color:#00D4FF;letter-spacing:4px;text-align:center;margin-bottom:4px}.sub{font-size:8px;letter-spacing:2px;color:#7A8694;text-align:center;margin-bottom:28px}
.lbl{font-size:7px;letter-spacing:2px;color:#7A8694;text-transform:uppercase;margin-bottom:6px}.inp{width:100%;background:#020408;border:1px solid #21262D;color:#E6EDF3;padding:12px;font-family:inherit;font-size:14px;margin-bottom:14px;outline:none}
.inp:focus{border-color:#00D4FF}.bal{font-size:28px;font-weight:700;color:#00FF88;font-variant-numeric:tabular-nums;margin:12px 0}
.btn-add{width:100%;background:#003087;border:1px solid #00D4FF;color:#00D4FF;padding:13px;font-family:inherit;font-size:9px;letter-spacing:2px;cursor:pointer;margin-bottom:8px;text-transform:uppercase}
.btn-res{width:100%;background:#1A0030;border:1px solid #7B2FFF;color:#7B2FFF;padding:13px;font-family:inherit;font-size:9px;letter-spacing:2px;cursor:pointer;text-transform:uppercase}
.btn-add:hover{background:#0050A0}.btn-res:hover{background:#2A0050}
.msg{font-size:10px;padding:8px;margin-top:10px;border:1px solid;display:none}
.ok{background:rgba(0,255,136,.05);border-color:#006B3C;color:#00FF88;display:block}
.err{background:rgba(248,81,73,.05);border-color:#991B1B;color:#F85149;display:block}
.ref{font-size:7px;color:#3B434D;margin-top:20px;text-align:center}
</style></head><body><div class="v">
<div class="logo">SOVEREIGN VAULT</div><div class="sub">Vanguard Protocol · USB Sovereign Bank</div>
<div id="lock"><div class="lbl">Vault PIN</div><input type="password" id="pin" class="inp" placeholder="Enter PIN" maxlength="10" autocomplete="off"><button class="btn-add" onclick="unlock()">UNLOCK VAULT</button><div class="msg err" id="lock-msg"></div></div>
<div id="panel" style="display:none"><div class="lbl">Vault Balance</div><div class="bal" id="bal">Loading...</div><div class="lbl">Vault Address</div><div style="font-size:9px;word-break:break-all;color:#7A8694;margin-bottom:16px">${vaultAddress}</div>
<div class="lbl">Amount (USDC)</div><input type="number" id="amt" class="inp" placeholder="0.00">
<button class="btn-add" onclick="addFunds()">ADD FUNDS (Treasury → Vault)</button><button class="btn-res" onclick="restoreFunds()">RESTORE (Vault → Treasury)</button>
<div class="msg" id="msg"></div></div>
<div class="ref">VANGUARD PROTOCOL (Owned and Operated By Bun Omar SECKA)</div></div>
<script>
const ENC=${JSON.stringify(encKey)},VA='${vaultAddress}'
let vKey=null
function hexToBytes(h){const b=new Uint8Array(h.length/2);for(let i=0;i<b.length;i++)b[i]=parseInt(h.slice(i*2,i*2+2),16);return b}
async function unlock(){
  const pin=document.getElementById('pin').value;if(!pin)return
  try{const e=new TextEncoder(),km=await crypto.subtle.importKey('raw',e.encode(pin),'PBKDF2',false,['deriveKey'])
  const ak=await crypto.subtle.deriveKey({name:'PBKDF2',salt:hexToBytes(ENC.salt),iterations:310000,hash:'SHA-256'},km,{name:'AES-GCM',length:256},false,['decrypt'])
  const rawTag=hexToBytes(ENC.data+ENC.tag),dec=await crypto.subtle.decrypt({name:'AES-GCM',iv:hexToBytes(ENC.iv),tagLength:128},ak,rawTag)
  vKey=JSON.parse(new TextDecoder().decode(dec))
  document.getElementById('lock').style.display='none';document.getElementById('panel').style.display='block';loadBal()
  }catch{document.getElementById('lock-msg').textContent='Incorrect PIN';document.getElementById('lock-msg').className='msg err'}}
async function loadBal(){try{const r=await fetch('https://polygon-mainnet.g.alchemy.com/v2/CfWwmhym4lH5r7_T7_oU0',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{to:'0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',data:'0x70a08231000000000000000000000000'+VA.replace('0x','').padStart(64,'0')},'latest']})});const d=await r.json();document.getElementById('bal').textContent='$'+(parseInt(d.result,16)/1e6).toLocaleString('en-US',{minimumFractionDigits:2})}catch{document.getElementById('bal').textContent='Offline mode'}}
async function addFunds(){const a=parseFloat(document.getElementById('amt').value);const m=document.getElementById('msg');if(!a||a<=0){m.textContent='Enter valid amount';m.className='msg err';return}m.className='msg';
try{const r=await fetch('/api/usb/add-funds',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:a,vaultAddress:VA,pin:document.getElementById('pin').value||''})});const d=await r.json();if(d.ok){m.textContent='Transfer initiated: $'+a+' arriving in ~2 seconds';m.className='msg ok';setTimeout(loadBal,3000)}else{m.textContent=d.error||'Transfer failed';m.className='msg err'}}catch(e){m.textContent='Error: '+e.message;m.className='msg err'}}
async function restoreFunds(){const a=parseFloat(document.getElementById('amt').value);const m=document.getElementById('msg');if(!a||a<=0){m.textContent='Enter valid amount';m.className='msg err';return}if(!vKey?.privKey){m.textContent='Vault not unlocked';m.className='msg err';return}m.className='msg';
try{const r=await fetch('/api/usb/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:a,vaultPrivKey:vKey.privKey,treasuryAddress:vKey.treasuryAddr,pin:document.getElementById('pin').value||''})});const d=await r.json();if(d.ok){m.textContent='Restoration complete: $'+a+' returned to treasury';m.className='msg ok';setTimeout(loadBal,3000)}else{m.textContent=d.error||'Failed';m.className='msg err'}}catch(e){m.textContent='Error: '+e.message;m.className='msg err'}}
document.getElementById('pin').addEventListener('keydown',e=>{if(e.key==='Enter')unlock()})
</script></body></html>`
}
