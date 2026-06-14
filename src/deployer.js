// X7 PROTOCOL — DEPLOYER
// Deploys via Pimlico verifying paymaster — Pimlico pays gas free
// Manual override: set CONTRACT_POLYGON=0x... in Railway Variables

import { encodeDeployData } from 'viem'
import { CHAINS, ACTIVE_CHAINS } from './config.js'
import { getConfig, setConfig } from './db.js'
import { sendViaPimlico, getPublicClient } from './pimlico.js'
import { compile } from './compiler.js'

export function loadManualContracts() {
  const map = {
    polygon:   process.env.CONTRACT_POLYGON,
    arbitrum:  process.env.CONTRACT_ARBITRUM,
    ethereum:  process.env.CONTRACT_ETHEREUM,
    avalanche: process.env.CONTRACT_AVALANCHE
  }
  for (const [chain, addr] of Object.entries(map)) {
    if (addr?.startsWith('0x') && addr.length === 42) {
      setConfig('contract_' + chain, addr)
      console.log('[DEPLOY] ' + chain + ': manual contract set: ' + addr)
    }
  }
}

export async function deployToChain(chainName) {
  const existing = getConfig('contract_' + chainName)
  if (existing && existing.startsWith('0x') && existing !== 'failed') {
    console.log('[DEPLOY] ' + chainName + ': already deployed at ' + existing)
    return existing
  }

  const chain = CHAINS[chainName]
  if (!chain) return null

  const artifact = await compile()
  if (!artifact) { console.error('[DEPLOY] compile failed'); return null }

  console.log('[DEPLOY] ' + chainName + ': deploying (Pimlico pays gas)...')

  try {
    const client     = getPublicClient(chainName)
    const deployData = encodeDeployData({
      abi:      artifact.abi,
      bytecode: artifact.bytecode,
      args: [
        chain.aavePool || '0x0000000000000000000000000000000000000001',
        chain.router,
        chain.usdc
      ]
    })

    // null = contract creation (to address is null)
    const txHash = await sendViaPimlico(chainName, null, deployData)
    if (!txHash) throw new Error('no tx hash')

    const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 120000 })
    const addr    = receipt.contractAddress
    if (!addr) throw new Error('no contract address in receipt')

    setConfig('contract_' + chainName, addr)
    console.log('[DEPLOY] ' + chainName + ': SUCCESS at ' + addr)
    return addr
  } catch (e) {
    console.log('[DEPLOY] ' + chainName + ': failed — ' + e.message?.slice(0, 150))
    return null
  }
}

export async function deployAll() {
  console.log('[DEPLOY] Deploying all chains via Pimlico (free credits)...')
  for (const chainName of ['polygon', 'arbitrum', 'avalanche', 'ethereum']) {
    if (!CHAINS[chainName]?.active || !ACTIVE_CHAINS.includes(chainName)) continue
    await deployToChain(chainName).catch(e =>
      console.log('[DEPLOY] ' + chainName + ': ' + e.message?.slice(0, 80))
    )
    await new Promise(r => setTimeout(r, 3000))
  }
}
