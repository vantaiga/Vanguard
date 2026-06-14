// X7 PROTOCOL — PIMLICO
// Verifying paymaster — Pimlico pays gas from 10M free credits
// No paymasterContext = verifying paymaster (NOT ERC-20)
// Zero MATIC, zero ETH, zero USDC needed

import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { polygon, arbitrum, mainnet, avalanche } from 'viem/chains'
import { createSmartAccountClient } from 'permissionless'
import { toSimpleSmartAccount } from 'permissionless/accounts'
import { createPimlicoClient } from 'permissionless/clients/pimlico'
import { entryPoint07Address } from 'viem/account-abstraction'
import { CHAINS, EXEC_KEY } from './config.js'
import { getConfig, setConfig } from './db.js'

const VIEM_CHAINS = { polygon, arbitrum, ethereum: mainnet, avalanche }
const _pub = {}, _wal = {}, _smart = {}, _addrs = {}

function getAccount() {
  if (!EXEC_KEY) throw new Error('EXECUTOR_PRIVATE_KEY not set')
  const k = EXEC_KEY.startsWith('0x') ? EXEC_KEY : '0x' + EXEC_KEY
  return privateKeyToAccount(k)
}

export function getPublicClient(chainName) {
  if (!_pub[chainName]) {
    _pub[chainName] = createPublicClient({
      chain:     VIEM_CHAINS[chainName],
      transport: http(CHAINS[chainName].rpcHttp)
    })
  }
  return _pub[chainName]
}

export function getWalletClient(chainName) {
  if (!_wal[chainName]) {
    _wal[chainName] = createWalletClient({
      account:   getAccount(),
      chain:     VIEM_CHAINS[chainName],
      transport: http(CHAINS[chainName].rpcHttp)
    })
  }
  return _wal[chainName]
}

async function getSmartClient(chainName) {
  if (_smart[chainName]) return _smart[chainName]

  const chain = CHAINS[chainName]
  if (!chain?.pimlico || chain.pimlico.endsWith('apikey=')) {
    console.log('[PIMLICO] ' + chainName + ': no API key')
    return null
  }

  try {
    const pub = getPublicClient(chainName)

    // Deterministic smart account from executor private key
    const smartAccount = await toSimpleSmartAccount({
      client:     pub,
      owner:      getAccount(),
      entryPoint: { address: entryPoint07Address, version: '0.7' }
    })

    _addrs[chainName] = smartAccount.address
    setConfig('smart_addr_' + chainName, smartAccount.address)
    console.log('[PIMLICO] ' + chainName + ' smart account: ' + smartAccount.address)

    // Pimlico handles both bundler and paymaster
    const pimlicoClient = createPimlicoClient({
      transport:  http(chain.pimlico),
      chain:      VIEM_CHAINS[chainName],
      entryPoint: { address: entryPoint07Address, version: '0.7' }
    })

    // VERIFYING PAYMASTER — no paymasterContext = Pimlico pays from free credits
    // This is the key difference from ERC-20 paymaster
    // Your 10M credits sponsor every gas payment
    const smartClient = createSmartAccountClient({
      account:          smartAccount,
      chain:            VIEM_CHAINS[chainName],
      bundlerTransport: http(chain.pimlico),
      paymaster:        pimlicoClient
      // NO paymasterContext here = verifying paymaster = free credits
    })

    _smart[chainName] = smartClient
    return smartClient

  } catch (e) {
    console.log('[PIMLICO] ' + chainName + ' smart client error: ' + e.message?.slice(0, 150))
    return null
  }
}

// Main function called by deployer.js, executor.js, yield.js
// Pimlico verifying paymaster pays gas — zero native tokens ever needed
export async function sendViaPimlico(chainName, to, data, value = 0n) {
  try {
    const client = await getSmartClient(chainName)
    if (client) {
      // to=null would fail — CREATE2 factory provides real address
      if (!to) throw new Error('to address required for UserOp — use CREATE2 factory')
      const hash = await client.sendTransaction({ to, data, value })
      console.log('[PIMLICO] ' + chainName + ': UserOp sent → ' + hash)
      return hash
    }
  } catch (e) {
    console.log('[PIMLICO] ' + chainName + ' error: ' + e.message?.slice(0, 150))
  }

  // Direct EOA fallback — only if Pimlico completely unavailable
  console.log('[PIMLICO] ' + chainName + ': falling back to direct EOA (needs native gas)')
  return sendDirect(chainName, to, data, value)
}

async function sendDirect(chainName, to, data, value = 0n) {
  const w = getWalletClient(chainName)
  const c = getPublicClient(chainName)
  const h = await w.sendTransaction({ to, data, value })
  await c.waitForTransactionReceipt({ hash: h, timeout: 120000 })
  return h
}

export function getExecutorAddress() {
  try { return getAccount().address } catch { return null }
}

export async function getSmartAddress(chainName) {
  if (_addrs[chainName]) return _addrs[chainName]
  const cached = getConfig('smart_addr_' + chainName)
  if (cached) { _addrs[chainName] = cached; return cached }
  await getSmartClient(chainName).catch(() => {})
  return _addrs[chainName] || getExecutorAddress()
}
