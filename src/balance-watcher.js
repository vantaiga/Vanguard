// Watches executor balance every 500ms on all chains
// First chain with enough native for gas → triggers deploy
// This IS the deploy trigger. No Flashbots needed. No ETH required at start.
import { getActive } from './chains.js'
import { getExecutorAddress } from './pimlico.js'
import { rpcCall } from './rpc.js'
import { emit } from './events.js'
import { setConfig } from './db.js'

const _funded  = new Set()
const _checked = {}

async function checkChain(chain) {
  if (_funded.has(chain.name)) return
  const now = Date.now()
  if (now - (_checked[chain.name]||0) < 450) return
  _checked[chain.name] = now
  const exec = getExecutorAddress()
  if (!exec) return
  try {
    const hex = await rpcCall(chain.name, 'eth_getBalance', [exec, 'latest'])
    const bal = BigInt(hex||'0x0')
    // Minimum: enough for gasLimit × 2gwei
    const min = (chain.gasLimit||800000n) * 2000000000n
    if (bal >= min) {
      _funded.add(chain.name)
      console.log(`[BALANCE] ${chain.name} funded: ${Number(bal)/1e18} ${chain.native}`)
      setConfig('funded_'+chain.name, bal.toString())
      emit('chain_funded', { chain: chain.name, balance: bal })
    }
  } catch {}
}

export function startBalanceWatcher() {
  const exec = getExecutorAddress()
  console.log('[BALANCE] Watching all chains every 500ms')
  console.log('[BALANCE] Fund executor to deploy:', exec)
  console.log('[BALANCE] Cheapest: 0.01 POL on Polygon (~$0.003)')
  setInterval(async () => {
    await Promise.allSettled(getActive().map(checkChain))
  }, 500)
}

export const isFunded  = c => _funded.has(c)
export const getFunded = () => [..._funded]
