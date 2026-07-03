// Vanguard v1.0 — Boot sequence
// FIX: dashboard binds port ONCE at step 0 — no close/reopen race
// If main() throws and retries, startDashboard() is guarded so it only
// calls server.listen() once — EADDRINUSE cannot happen on retry.
// Self-heals: uncaughtException never exits the process.

let _dashStarted = false
const T = Date.now()

async function main() {
  // Step 0: Dashboard FIRST — /health + WebSocket live before anything else
  // Railway's healthcheck fires within 30s of container start.
  // Nothing in steps 1-12 should block this from responding.
  if (!_dashStarted) {
    _dashStarted = true
    const { startDashboard } = await import('./dashboard.js')
    startDashboard()
  }

  // Step 1: DB — migrateFirst() runs before any query, cannot crash on schema mismatch
  const { initDB }           = await import('./db.js')
  await initDB()

  // Step 2: Chain registry
  const { initChains }       = await import('./chains.js')
  const chains = initChains()

  // Step 3: RPC pool + WebSocket (chain connections, not dashboard socket)
  const { initRPC }          = await import('./rpc.js')
  initRPC(chains)

  // Step 4: Executor wallet
  const { initPimlico }      = await import('./pimlico.js')
  initPimlico()

  // Step 5: Compile Vanguard.sol (viaIR — no stack too deep)
  const { compile }          = await import('./compiler.js')
  await compile()

  // Step 6: CEX feeds — Binance / OKX / Bybit
  const { startCEXFeed }     = await import('./cexfeed.js')
  startCEXFeed()

  // Step 7: Price gap scanner
  const { startScanner }     = await import('./scanner.js')
  startScanner()

  // Step 8: Balance watcher — polls executor every 500ms, fires deploy on funding
  const { startBalanceWatcher } = await import('./balance-watcher.js')
  startBalanceWatcher()

  // Step 9: Bootstrap — registers chain_funded listener + ETH Flashbots path
  const { initBootstrap }    = await import('./bootstrap.js')
  await initBootstrap()

  // Step 10: Vaults — RS1 MEV, mega-swap detection
  const { startVaults }      = await import('./vaults.js')
  startVaults()

  // Step 11: Revenue — RS2 non-MEV, 5 streams
  const { startRevenue }     = await import('./revenue.js')
  startRevenue()

  // Step 12: Rule-AI — autonomous operations every 5min
  const { startRuleAI }      = await import('./rule-ai.js')
  startRuleAI()

  const { on } = await import('./events.js')

  console.log(`Vanguard OPERATIONAL — ${Object.keys(chains).length} chains — boot ${Date.now()-T}ms`)
  console.log('[BOOT] RS1: MEV · crossPoolArb · Balancer 0% flash')
  console.log('[BOOT] RS2: CEX-DEX · Depeg · Governance · CoW Solver · Intents')
  console.log('[BOOT] RS3: LP Yield · auto-compounds from RS1+RS2 profits')
  console.log('[BOOT] Send 0.01 POL (~$0.003) to executor on any chain to begin')

  // Deploy events
  on('deploy_success', ({ chain, address, method }) =>
    console.log(`[LIVE] ${chain} → ${address} (${method})`))
  on('first_deploy', ({ chain }) =>
    console.log(`[LIVE] First deploy: ${chain} — RS1 active — cascading all chains`))

  // Watchdog 1: RPC health (fires every 30s, not at boot)
  setInterval(async () => {
    let ok = 0
    for (const c of ['base', 'polygon', 'arbitrum']) {
      try {
        const { rpcCall } = await import('./rpc.js')
        if (await rpcCall(c, 'eth_blockNumber', [])) ok++
      } catch {}
    }
    if (!ok) console.warn('[WATCHDOG] All RPCs unreachable — fallbacks active')
  }, 30000)

  // Watchdog 2: Memory (fires every 60s)
  setInterval(() => {
    const mb = process.memoryUsage().heapUsed / 1024 / 1024
    if (mb > 400) {
      console.warn(`[WATCHDOG] Memory ${mb.toFixed(0)}MB — GC`)
      try { global.gc?.() } catch {}
    }
  }, 60000)
}

// Self-healing: retry on any fatal error
// _dashStarted guard means server.listen() is NOT called again on retry
main().catch(e => {
  console.error('[BOOT] Fatal — recovering in 5s:', e.message)
  setTimeout(() => main().catch(() => {}), 5000)
})

process.on('uncaughtException',  e => console.error('[UNCAUGHT]',  e.message?.slice(0, 100)))
process.on('unhandledRejection', r => console.error('[REJECTION]', String(r).slice(0, 100)))
process.on('SIGTERM', () => { console.log('SIGTERM — graceful exit'); process.exit(0) })
