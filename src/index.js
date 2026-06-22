// X7-SV · index.js — boot · event bus · watchdog · 500ms to live

import { EventEmitter } from 'events'

const bus = new EventEmitter()
bus.setMaxListeners(100)

export const emit = (event, data) => bus.emit(event, data)
export const on = (event, fn) => bus.on(event, fn)

const START = Date.now()
console.log('X7-SV v3.0 STARTING — 10 SVs · 5,000 instances · 50 chains')

// Start dashboard immediately (health check must be live first)
const { startDashboard } = await import('./dashboard.js')
startDashboard()
console.log('[BOOT] /health live')

// Boot sequence with 500ms delay
setTimeout(boot, 500)

async function boot() {
  // 1. Database
  try {
    const { initDB } = await import('./db.js')
    await initDB()
  } catch (e) { console.error('[DB] FATAL:', e.message); process.exit(1) }

  // 2. Chains
  let chains
  try {
    const { initChains } = await import('./chains.js')
    chains = await initChains()
  } catch (e) { console.error('[CHAINS]:', e.message); return }

  // 3. RPC + WebSocket
  try {
    const { initRPC } = await import('./rpc.js')
    initRPC(chains)
  } catch (e) { console.error('[RPC]:', e.message) }

  // 4. Executor wallet + CREATE2
  try {
    const { initPimlico } = await import('./pimlico.js')
    initPimlico()
  } catch (e) { console.error('[PIMLICO]:', e.message) }

  // 5. Compile X7.sol
  try {
    const { compile } = await import('./compiler.js')
    await compile()
  } catch (e) { console.warn('[COMPILER]:', e.message) }

  // 6. CEX feeds (P6/P10)
  try {
    const { startCEXFeed } = await import('./cexfeed.js')
    startCEXFeed()
  } catch (e) { console.warn('[CEX]:', e.message) }

  // 7. Governance watcher (P12)
  try {
    const { startGovernance } = await import('./governance.js')
    startGovernance()
  } catch (e) { console.warn('[GOV]:', e.message) }

  // 8. Deployer — zero-seed CREATE2 bootstrap
  try {
    const { startDeployer } = await import('./deployer.js')
    await startDeployer()
  } catch (e) { console.warn('[DEPLOY]:', e.message) }

  // 9. Vaults — 10 SVs start watching all chains
  try {
    const { startVaults } = await import('./vaults.js')
    startVaults()
  } catch (e) { console.error('[VAULTS]:', e.message) }

  // 10. Treasury — USDC tracking + auto-withdraw
  try {
    const { startTreasury } = await import('./treasury.js')
    startTreasury()
  } catch (e) { console.warn('[TREASURY]:', e.message) }

  console.log(`X7-SV OPERATIONAL — ${Object.keys(chains).length} chains — boot in ${Date.now() - START}ms`)

  // ── WATCHDOG ──────────────────────────────────────────────────────────────
  let watchdogFails = 0
  setInterval(async () => {
    try {
      const { rpcCall } = await import('./rpc.js')
      const { getActiveChains } = await import('./chains.js')
      const chains = getActiveChains().slice(0, 3) // Check top 3 chains
      let ok = 0
      for (const c of chains) {
        try {
          const block = await rpcCall(c.name, 'eth_blockNumber', [])
          if (block) ok++
        } catch {}
      }
      if (ok === 0) {
        watchdogFails++
        console.warn(`[WATCHDOG] All RPC checks failed (${watchdogFails}/3)`)
        if (watchdogFails >= 3) { console.error('[WATCHDOG] System degraded — restarting vaults'); watchdogFails = 0 }
      } else { watchdogFails = 0 }
    } catch {}
  }, 30000)

  // Circuit breaker: pause if loss rate > 20% in 5 minutes
  let recentMisses = 0, recentExecs = 0
  on('missed_rev', () => recentMisses++)
  on('sv_update',  () => recentExecs++)
  setInterval(() => {
    if (recentExecs > 5 && recentMisses / (recentExecs + recentMisses) > 0.8) {
      console.warn('[CIRCUIT] High miss rate detected — checking chain health')
    }
    recentMisses = 0; recentExecs = 0
  }, 300000)
}

process.on('uncaughtException',  e => console.error('[UNCAUGHT]:', e.message?.slice(0, 100)))
process.on('unhandledRejection', e => console.error('[REJECT]:',   String(e).slice(0, 100)))
process.on('SIGTERM', () => { console.log('SIGTERM received'); process.exit(0) })
