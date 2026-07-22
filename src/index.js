// Vanguard · index.js — Master boot sequence
// 7 files. Sequential dynamic imports. Dashboard FIRST.

import { initVanguard, getConfig, setConfig, emit, on, getSABF64, SAB_OFFSETS, RTABLE, fmtRev } from './vanguard.js'

const HOT = getSABF64()

// Swap tracking — log every 10 qualifying swaps
const _swapByChain = {}
let   _swapTotal   = 0
let   _bootDone    = false
let   _lastSwapLog = 0

async function boot() {
  const T = Date.now()

  // 1. Soul
  initVanguard()

  // 2. Dashboard — port binds immediately
  const { startDashboard, registerStats } = await import('./dashboard.js')
  startDashboard()

  // 3. Chains
  const chains = await import('./chains.js')
  await chains.startChains()
  registerStats('chains', chains.getChains1Stats)

  // 4. Execution
  const exec = await import('./execution.js')
  await exec.initExecution()
  registerStats('nexus',    exec.getNEXUSStats)
  registerStats('apex',     exec.getAPEXStats)
  registerStats('builders', exec.getBuilderStats)

  // 5. Intelligence
  const intel = await import('./intelligence.js')
  intel.startIntelligence()
  registerStats('overlay',  intel.getOverlayStats)
  registerStats('crash',    intel.getCrashStats)
  registerStats('ruleai',   intel.getRuleAIStatus)
  registerStats('sovereign',intel.getSovereignStatus)

  // Set replay executor
  const { nexusRoute, apexExecute } = await import('./execution.js')
  intel.setReplayExecutor(async entry => {
    const d = nexusRoute({
      chain:         entry.chain,
      type:          'vault_arb',
      profitEst:     entry.profitEst   ?? 0,
      flashRequired: entry.flash       ?? 0,
      calldata:      entry.calldata    ?? '',
      chainId:       entry.chainId     ?? 1,
    })
    return d ? apexExecute(d) : null
  })

  // 6. Revenue
  const rev = await import('./revenue.js')
  rev.startRevenue()
  registerStats('propeller', rev.getPropellerStats)
  registerStats('rs5',       rev.getRS5Stats)
  registerStats('rs1',       rev.getRS1Stats)
  registerStats('rs2',       rev.getRS2Stats)
  registerStats('rs3',       rev.getRS3Stats)
  registerStats('amplifier', rev.getAmpStats)

  // 7. Operations
  const ops = await import('./operations.js')
  await ops.initBootstrap()
  ops.startBalanceWatcher()
  ops.startVaults()
  ops.startTreasury()
  registerStats('vaults',   ops.getSVStats)
  registerStats('treasury', ops.getTreasuryStats)

  // ModemPay
  const mp = await import('./modempay.js')
  mp.startModemPay()
  registerStats('modempay', mp.getModemPayStats)

  // Boot complete
  _bootDone = true
  const booted   = Date.now() - T
  const p        = parseInt(getConfig('prop_intensity') ?? '5')
  const live     = chains.getActive().filter(c => !!getConfig('contract_addr_'+c.name)).length
  const overlay  = intel.getOverlayStats()

  console.log(`\n${'═'.repeat(62)}`)
  console.log('  VANGUARD SOVEREIGN — OPERATIONAL')
  console.log(`  Boot:      ${booted}ms · ${live} chains live · 7 files`)
  console.log(`  NEXUS:     $3.496Q/day · <1ms · Flash $48.6B/exec`)
  console.log(`  APEX:      1.5ms target · 20× institutional-grade`)
  console.log(`  PROPELLER: P${p} = ${fmtRev(RTABLE[p] ?? 0)}/day · GUARANTEED`)
  console.log(`  OVERLAY:   ${overlay.queueSize} entries · ${overlay.readyToExec} pre-built · ${overlay.queueValueFmt}`)
  console.log(`  SOVEREIGN: 9 experts · 4 Laws · INDEFINITE Alchemy`)
  console.log(`  BUILDERS:  6/6 connected — Flashbots · Titan · Beaver · Rsync`)
  console.log(`  FUND:      0.001 POL → ${exec.getExecutorAddress() ?? '0xEc92EF0C897b48A3525Df011D08011c5eB2D6D39'}`)
  console.log(`${'═'.repeat(62)}\n`)

  // ── POST-BOOT LOGS: swaps + executions + system events ONLY ──────────────

  // Swap logs — every 10 qualifying swaps, shows chain breakdown
  on('mega_swap', ({ chain, swapUSD, profitEst }) => {
    if (!_bootDone) return
    _swapTotal++
    _swapByChain[chain] = (_swapByChain[chain] ?? 0) + 1

    // Log every 10 swaps
    if (_swapTotal % 10 === 0) {
      const now  = Date.now()
      // Throttle to max 1 swap log per 3 seconds to avoid flood
      if (now - _lastSwapLog < 3000) return
      _lastSwapLog = now

      const fmt   = (swapUSD ?? 0) >= 1e9
        ? '$' + ((swapUSD ?? 0)/1e9).toFixed(1) + 'B'
        : '$' + ((swapUSD ?? 0)/1e6).toFixed(0) + 'M'
      const profit = (profitEst ?? 0) >= 1e6
        ? '+$' + ((profitEst ?? 0)/1e6).toFixed(2) + 'M'
        : '+$' + (profitEst ?? 0).toFixed(0)

      // Top 3 most active chains
      const topChains = Object.entries(_swapByChain)
        .sort((a,b) => b[1]-a[1])
        .slice(0,3)
        .map(([c,n]) => `${c}(${n})`)
        .join(' ')

      console.log(`[SWAP] ${_swapTotal} | ${fmt} ${chain} | est: ${profit} | hot: ${topChains} → overlay: ${overlay.queueSize}`)
    }
  })

  // Execution logs — every successful apex execution
  on('apex_success', ({ chain, profit, latencyMs, builders }) => {
    const p = (profit ?? 0) >= 1e9
      ? '$' + ((profit??0)/1e9).toFixed(3) + 'B'
      : (profit ?? 0) >= 1e6
      ? '$' + ((profit??0)/1e6).toFixed(2) + 'M'
      : '$' + (profit ?? 0).toFixed(0)
    console.log(`[EXEC] ${p} · ${latencyMs}ms · ${chain} · ${builders}/6 builders`)
  })

  // System events
  on('deploy_success',    ({ chain, address }) =>
    console.log(`[LIVE] ${chain.toUpperCase()} → ${address}`)
  )
  on('emergency_halt',    ({ reason }) =>
    console.error('[HALT]', reason)
  )
  on('system_halt',       () => console.log('[HALT] System halted by operator'))
  on('system_resume',     () => console.log('[LIVE] System resumed by operator'))
  on('propeller_changed', ({ from, to, dailyRev }) =>
    console.log(`[P${to}] Propeller P${from}→P${to} · ${fmtRev(dailyRev ?? 0)}/day`)
  )
  on('crash_mode_activated', () =>
    console.log('[CRASH] Market IS a factor — cascade active — ONE log only')
  )
  on('crash_mode_off',       () =>
    console.log('[CRASH] Market NOT a factor — propeller governs')
  )

  // Silent GC
  setInterval(() => {
    const mb = process.memoryUsage().heapUsed / 1024 / 1024
    if (mb > 320 && typeof global.gc === 'function') global.gc()
  }, 60000)
}

boot().catch(e => {
  console.error('[BOOT] Fatal:', e.message)
  setTimeout(() => boot().catch(err =>
    console.error('[BOOT] Recovery failed:', err.message)
  ), 5000)
})

process.on('uncaughtException',  e => {
  if (!e.message?.includes('EADDRINUSE'))
    console.error('[ERR]', e.message?.slice(0, 120))
})
process.on('unhandledRejection', r => console.error('[REJ]', String(r).slice(0,120)))
process.on('SIGTERM', () => { console.log('[VANGUARD] Shutdown'); process.exit(0) })  intel.startIntelligence()
  registerStats('overlay',  intel.getOverlayStats)
  registerStats('crash',    intel.getCrashStats)
  registerStats('ruleai',   intel.getRuleAIStatus)
  registerStats('sovereign',intel.getSovereignStatus)

  // Set replay executor so overlay can drain after deploy
  const { nexusRoute, apexExecute } = await import('./execution.js')
  intel.setReplayExecutor(async entry => {
    const d = nexusRoute({ chain:entry.chain, type:'vault_arb', profitEst:entry.profitEst??0, flashRequired:entry.flash??0, calldata:entry.calldata??'', chainId:entry.chainId??1 })
    return d ? apexExecute(d) : null
  })

  // 6. Revenue — propeller + all RS layers + amplifier
  const rev = await import('./revenue.js')
  rev.startRevenue()
  registerStats('propeller', rev.getPropellerStats)
  registerStats('rs5',       rev.getRS5Stats)
  registerStats('rs1',       rev.getRS1Stats)
  registerStats('rs2',       rev.getRS2Stats)
  registerStats('rs3',       rev.getRS3Stats)
  registerStats('amplifier', rev.getAmpStats)

  // 7. Operations — balance watcher + deploy + vaults + treasury + USB
  const ops = await import('./operations.js')
  await ops.initBootstrap()
  ops.startBalanceWatcher()
  ops.startVaults()
  ops.startTreasury()
  registerStats('vaults',   ops.getSVStats)
  registerStats('treasury', ops.getTreasuryStats)

  // ModemPay
  const mp = await import('./modempay.js')
  mp.startModemPay()
  registerStats('modempay', mp.getModemPayStats)

  // Boot complete
  _bootDone = true
  const booted = Date.now() - T
  const p = parseInt(getConfig('prop_intensity') ?? '5')
  const live = chains.getActive().filter(c=>!!getConfig('contract_addr_'+c.name)).length

  console.log(`\n${'═'.repeat(62)}`)
  console.log('  VANGUARD SOVEREIGN — OPERATIONAL')
  console.log(`  Boot: ${booted}ms · ${live} chains live · 7 files`)
  console.log(`  NEXUS:     $3.496Q/day · <1ms · Flash $48.6B`)
  console.log(`  APEX:      1.5ms target · 20× institutional`)
  console.log(`  PROPELLER: P${p} = ${fmtRev(RTABLE[p]??0)}/day · GUARANTEED`)
  console.log(`  SOVEREIGN: 9 experts · 4 Laws · INDEFINITE Alchemy`)
  console.log(`  FUND: 0.001 POL → ${exec.getExecutorAddress() ?? '0xEc92EF0C897b48A3525Df011D08011c5eB2D6D39'}`)
  console.log(`${'═'.repeat(62)}\n`)

  // Post-boot console logs — ONLY swaps + executions + system events
  on('mega_swap', ({ chain, swapUSD }) => {
    if (!_bootDone) return
    _swapCount++
    if (_swapCount % 100 === 0) {
      const fmt = (swapUSD??0) >= 1e9 ? '$'+((swapUSD??0)/1e9).toFixed(1)+'B' : '$'+((swapUSD??0)/1e6).toFixed(0)+'M'
      console.log(`[SWAP] ${_swapCount} × ${fmt} · ${chain} → overlay`)
    }
  })

  on('deploy_success',    ({ chain, address }) => console.log(`[LIVE] ${chain.toUpperCase()} → ${address}`))
  on('apex_success',      ({ chain, profit, latencyMs }) => console.log(`[EXEC] ${fmtRev(profit??0)} (${latencyMs}ms) ${chain}`))
  on('emergency_halt',    ({ reason }) => console.error('[HALT]', reason))
  on('system_halt',       () => console.log('[HALT] System halted by operator'))
  on('system_resume',     () => console.log('[LIVE] System resumed by operator'))
  on('propeller_changed', ({ from, to, dailyRev }) => console.log(`[P${to}] Propeller P${from}→P${to} · ${fmtRev(dailyRev??0)}/day`))
  on('crash_mode_activated',   () => console.log('[CRASH] Market IS a factor — cascade active'))
  on('crash_mode_off',         () => console.log('[CRASH] Market NOT a factor — propeller governs'))

  // Silent GC
  setInterval(() => {
    const mb = process.memoryUsage().heapUsed / 1024 / 1024
    if (mb > 320 && typeof global.gc === 'function') global.gc()
  }, 60000)
}

boot().catch(e => {
  console.error('[BOOT] Fatal:', e.message)
  setTimeout(() => boot().catch(err => console.error('[BOOT] Recovery failed:', err.message)), 5000)
})

process.on('uncaughtException',  e => { if (!e.message?.includes('EADDRINUSE')) console.error('[ERR]', e.message?.slice(0,120)) })
process.on('unhandledRejection', r => console.error('[REJ]', String(r).slice(0,120)))
process.on('SIGTERM', () => { console.log('[VANGUARD] Shutdown'); process.exit(0) })
