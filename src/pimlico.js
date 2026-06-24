// X7-SV · pimlico.js — ERC-4337 via viem · wallet clients · executor

import { createWalletClient, createPublicClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet, arbitrum, polygon, base, optimism, avalanche, bsc, scroll } from 'viem/chains'
import { getChain } from './chains.js'
import { getConfig, setConfig } from './db.js'

const CHAIN_OBJS = {
  ethereum: mainnet, arbitrum, polygon, base,
  optimism, avalanche, bnb: bsc, scroll
}

let _account, _wallets = {}, _public = {}

export function initPimlico() {
  const pk = process.env.EXECUTOR_PRIVATE_KEY
  if (!pk) { console.error('[PIMLICO] No EXECUTOR_PRIVATE_KEY'); return }
  try {
    _account = privateKeyToAccount(pk.startsWith('0x') ? pk : '0x'+pk)
    console.log('[PIMLICO] Executor:', _account.address)
  } catch (e) { console.error('[PIMLICO] Invalid key:', e.message) }
}

export const getExecutorAddress = () => _account?.address

export function getWalletClient(chainName) {
  if (_wallets[chainName]) return _wallets[chainName]
  const chain = getChain(chainName)
  const obj   = CHAIN_OBJS[chainName]
  if (!chain || !obj || !_account) return null
  _wallets[chainName] = createWalletClient({ account: _account, chain: obj, transport: http(chain.rpcHttp) })
  return _wallets[chainName]
}

export function getPublicClient(chainName) {
  if (_public[chainName]) return _public[chainName]
  const chain = getChain(chainName)
  const obj   = CHAIN_OBJS[chainName]
  if (!chain || !obj) return null
  _public[chainName] = createPublicClient({ chain: obj, transport: http(chain.rpcHttp) })
  return _public[chainName]
}

export async function sendTx(chainName, to, data, value = 0n) {
  const wallet = getWalletClient(chainName)
  const client = getPublicClient(chainName)
  if (!wallet || !client) throw new Error('No client: ' + chainName)
  const [nonce, fee] = await Promise.all([
    client.getTransactionCount({ address: _account.address }),
    client.estimateFeesPerGas()
  ])
  const hash = await wallet.sendTransaction({
    to, data, value, nonce,
    maxFeePerGas:         fee.maxFeePerGas * 12n / 10n,
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas * 12n / 10n,
  })
  return hash
}

export async function waitTx(chainName, hash, timeout = 120000) {
  const client = getPublicClient(chainName)
  if (!client) return null
  return client.waitForTransactionReceipt({ hash, timeout })
}

export async function contractExists(chainName, addr) {
  try {
    const client = getPublicClient(chainName)
    if (!client) return false
    const code = await client.getCode({ address: addr })
    return !!(code && code !== '0x' && code.length > 2)
  } catch { return false }
}

export const getContractAddr = chainName => {
  const v = getConfig('contract_' + chainName)
  return v?.startsWith('0x') && v.length === 42 ? v : null
}

export const setContractAddr = (chainName, addr) => setConfig('contract_' + chainName, addr)

// Pimlico bundler URL for ERC-4337 UserOps
export const pimlicoUrl = chainId => {
  const k = process.env.PIMLICO_API_KEY
  return k ? `https://api.pimlico.io/v2/${chainId}/rpc?apikey=${k}` : null
}
