// Vanguard · pimlico.js — Executor wallet management
// FIX: was importing from './chains.js' (deleted) → now './chains1.js'

import { ethers } from 'ethers'
import { getConfig, setConfig } from './db.js'
import { getChain } from './chains1.js'

// ── Executor wallet ────────────────────────────────────────────────────────────
let _wallet    = null
let _addresses = {}   // chainName → deployed contract address

export function initPimlico() {
  const privKey = process.env.EXECUTOR_PRIVATE_KEY
  if (!privKey) {
    console.warn('[PIMLICO] No EXECUTOR_PRIVATE_KEY set — deploy disabled')
    return
  }
  try {
    const key = privKey.startsWith('0x') ? privKey : '0x' + privKey
    _wallet = new ethers.Wallet(key)
    setConfig('executor_address', _wallet.address)
    console.log('[PIMLICO] Executor wallet:', _wallet.address)
    // Restore previously deployed addresses
    restoreAddresses()
  } catch(e) {
    console.error('[PIMLICO] Wallet init error:', e.message?.slice(0, 80))
  }
}

function restoreAddresses() {
  // Load any previously deployed contract addresses from config
  const chains = [
    'ethereum','arbitrum','base','polygon','optimism',
    'avalanche','bnb','blast','linea','scroll',
    'zksync','gnosis','mantle','sonic','berachain',
    'sei','unichain','worldchain','metis','mode'
  ]
  for (const chain of chains) {
    const addr = getConfig('contract_addr_' + chain)
    if (addr) {
      _addresses[chain] = addr
      console.log(`[PIMLICO] Restored ${chain}: ${addr}`)
    }
  }
}

export function getExecutorAddress() {
  return _wallet?.address || getConfig('executor_address') || null
}

export function getWallet(chainName) {
  if (!_wallet) return null
  const chain = getChain(chainName)
  if (!chain?.rpcH && !chain) return _wallet
  try {
    const rpcUrl = chain?.rpcH || 'https://eth.drpc.org'
    const provider = new ethers.JsonRpcProvider(rpcUrl)
    return _wallet.connect(provider)
  } catch {
    return _wallet
  }
}

export function setContractAddr(chainName, address) {
  _addresses[chainName] = address
  setConfig('contract_addr_' + chainName, address)
}

export function getContractAddr(chainName) {
  return _addresses[chainName] || getConfig('contract_addr_' + chainName) || null
}

export function getAllContracts() {
  return { ..._addresses }
}
