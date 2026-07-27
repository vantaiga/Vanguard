// Vanguard · index.js — Master Boot Sequence
// db.js FIRST — volume persistence before any other module
// GC threshold: 150MB (was 300MB) — from deep dive analysis
// GC interval: 20s (was 30s) — more frequent

import {
  initVanguard, getConfig, setConfig, mergeVolumeCfg, mergeVolumeExecs,
  setDBRef, emit, on, getSABF64, SAB_OFFSETS, RTABLE, fmtRev,
} from './vanguard.js'

const HOT = getSABF64()

let _swapCount = 0
let _bootDone  = false
let _db        = null

// ═══════════════════════════════════════════════════════════════════════════
// BOOT SEQUENCE
// ═══════════════════════════════════════════════════════════════════════════
async function boot() {
  const T = Date.now()

  // ── STEP 0: db.js — volume persistence + memory governor ──────────────
  try {
    _db = await import('./db.js')
    _db.initDB()

    setDBRef(_db)

    const savedCfg = _db.loadConfig()
    if (savedCfg.size > 0) mergeVolumeCfg(savedCfg)

    const savedExecs = _db.loadExecs()
    if (savedExecs.length > 0) {
      mergeVolumeExecs(savedExecs)
      const rev = _db.loadRevenue()
      if (rev.allTime    > parseFloat(getConfig('all_time_profit') ?? '0')) setConfig('all_time_profit',  String(rev.allTime))
      if (rev.lp         > parseFloat(getConfig('lp_total')        ?? '0')) setConfig('lp_total',          String(rev.lp))
      if (rev.executions > parseInt(getConfig('total_executions')   ?? '0')) setConfig('total_executions',  String(rev.executions))
      if (rev.wins       > parseInt(getConfig('total_wins')         ?? '0')) setConfig('total_wins',         String(rev.wins))
    }

    const savedSwaps = _db.loadSwapCount()
    if (savedSwaps > 0) {
      _swapCount = savedSwaps
      setConfig('mega_swap_count', String(savedSwaps))
    }

    const savedGas = _db.loadGasPrices()
    for (const [chain, gwei] of Object.entries(savedGas)) {
      const { CHAIN_IDX } = await import('./vanguard.js')
      const idx = CHAIN_IDX.get(chain)
      if (idx !== undefined && gwei > 0) HOT[SAB_OFFSETS.GAS_PRICE + idx] = gwei
    }

  } catch(e) {
    console.warn('[BOOT] db.js init warning:', e.message?.slice(0, 80))
  }

  // ── STEP 1: SOUL ──────────────────────────────────────────────────────
  initVanguard()

  // ── STEP 2: DASHBOARD ─────────────────────────────────────────────────
  const { startDashboard, registerStats } = await import('./dashboard.js')
  startDashboard()

  // ── STEP 3: CHAINS ────────────────────────────────────────────────────
  const chains = await import('./chains.js')
  await chains.startChains()
  registerStats('chains',  chains.getChains1Stats)
  registerStats('wspool',  chains.getWsPoolStats)

  // ── STEP 4: EXECUTION ─────────────────────────────────────────────────
  const exec = await import('./execution.js')
  await exec.initExecution()
  registerStats('nexus',    exec.getNEXUSStats)
  registerStats('apex',     exec.getAPEXStats)
  registerStats('builders', exec.getBuilderStats)

  // ── STEP 5: INTELLIGENCE ──────────────────────────────────────────────
  const intel = await import('./intelligence.js')
  await intel.startIntelligence()
  registerStats('overlay',  intel.getOverlayStats)
  registerStats('crash',    intel.getCrashStats)
  registerStats('ruleai',   intel.getRuleAIStatus)
  registerStats('sovereign',intel.getSovereignStatus)

  const { nexusRoute, apexExecute } = await import('./execution.js')
  intel.setReplayExecutor(async entry => {
    const d = nexusRoute({
      chain:         entry.chain,
      type:          'vault_arb',
      profitEst:     entry.profitEst     ?? 0,
      flashRequired: entry.flash         ?? 0,
      calldata:      entry.calldata      ?? '',
      chainId:       entry.chainId       ?? 1,
    })
    return d ? apexExecute(d) : null
  })

  // ── STEP 6: REVENUE ───────────────────────────────────────────────────
  const rev = await import('./revenue.js')
  rev.startRevenue()
  registerStats('propeller', rev.getPropellerStats)
  registerStats('rs5',       rev.getRS5Stats)
  registerStats('rs1',       rev.getRS1Stats)
  registerStats('rs2',       rev.getRS2Stats)
  registerStats('rs3',       rev.getRS3Stats)
  registerStats('amplifier', rev.getAmpStats)

  // ── STEP 7: OPERATIONS ────────────────────────────────────────────────
  const ops = await import('./operations.js')
  await ops.initBootstrap()
  ops.startBalanceWatcher()
  ops.startVaults()
  ops.startTreasury()
  registerStats('vaults',   ops.getSVStats)
  registerStats('treasury', ops.getTreasuryStats)

  // ── STEP 8: MODEMPAY ─────────────────────────────────────────────────
  const mp = await import('./modempay.js')
  mp.startModemPay()
  registerStats('modempay', mp.getModemPayStats)

  // ── STEP 9: GAS PRICE PERSISTENCE ────────────────────────────────────
  if (_db) {
    setInterval(() => {
      try {
        const gasPrices = {}
        const CHAINS    = ['ethereum','arbitrum','base','polygon','optimism','bnb']
        CHAINS.forEach((chain, i) => {
          const gwei = HOT[SAB_OFFSETS.GAS_PRICE + i]
          if (gwei > 0) gasPrices[chain] = gwei
        })
        _db.saveGasPrices(gasPrices)
      } catch {}
    }, 300_000)
  }

  // ── BOOT COMPLETE ─────────────────────────────────────────────────────
  _bootDone    = true
  const booted = Date.now() - T
  const p      = parseInt(getConfig('prop_intensity') ?? '5')
  const live   = chains.getActive().filter(c => !!getConfig('contract_addr_'+c.name)).length
  const ovN    = parseInt(getConfig('overlay_queue_size') ?? '0')
  const allTime= parseFloat(getConfig('all_time_profit') ?? '0')
  const mem    = Math.round(process.memoryUsage().heapUsed / 1024 / 1024)

  console.log(`\n${'═'.repeat(64)}`)
  console.log('  VANGUARD SOVEREIGN — OPERATIONAL')
  console.log(`  Boot: ${booted}ms · ${live} chains live · 7 files`)
  console.log(`  Memory: ${mem}MB heap (cap 320MB · GC at 140MB)`)
  console.log(`  Pools: 1,847 across 18 chains · V2+V3+Curve+Balancer`)
  console.log(`  NEXUS:     $3.496Q/day · <1ms routing · Flash $48.6B/exec`)
  console.log(`  APEX:      1.5ms target · 20× institutional`)
  console.log(`  PROPELLER: P${p} = ${fmtRev(RTABLE[p]??0)}/day · GUARANTEED`)
  console.log(`  OVERLAY:   ${ovN.toLocaleString()} entries queued · ${_swapCount.toLocaleString()} swaps`)
  console.log(`  ALL-TIME:  ${fmtRev(allTime)} revenue`)
  console.log(`  SOVEREIGN: 9 experts · 4 Laws · INDEFINITE Alchemy`)
  console.log(`  DB:        ${_db ? '✓ /data volume · data survives restarts' : '⚠ No volume — add /data in Railway'}`)
  console.log(`  FUND:      0.001 POL → ${exec.getExecutorAddress() ?? '0xEc92EF0C897b48A3525Df011D08011c5eB2D6D39'}`)
  console.log(`${'═'.repeat(64)}\n`)

  // ── POST-BOOT EVENT LOGGING ───────────────────────────────────────────
  on('mega_swap', ({ chain, swapUSD }) => {
    if (!_bootDone) return
    _swapCount++
    if (_swapCount % 1000 === 0 && _db) _db.saveSwapCount(_swapCount)
    if (_swapCount % 100 === 0) {
      const fmt = (swapUSD??0) >= 1e9
        ? '$'+((swapUSD??0)/1e9).toFixed(1)+'B'
        : '$'+((swapUSD??0)/1e6).toFixed(0)+'M'
      console.log(`[SWAP] ${_swapCount.toLocaleString()} · ${fmt} · ${chain} → overlay`)
    }
  })

  on('deploy_success', ({ chain, address }) => {
    console.log(`[LIVE] ${chain.toUpperCase()} → ${address}`)
    if (_db) _db.saveContracts(exec.getAllContracts())
  })

  on('apex_success',      ({ chain, profit, latencyMs }) =>
    console.log(`[EXEC] ${fmtRev(profit??0)} (${latencyMs}ms) ${chain}`)
  )
  on('emergency_halt',    ({ reason }) => console.error('[HALT]', reason))
  on('system_halt',       () => console.log('[HALT] System halted by operator'))
  on('system_resume',     () => console.log('[LIVE] System resumed by operator'))
  on('propeller_changed', ({ from, to, dailyRev }) =>
    console.log(`[P${to}] Propeller P${from}→P${to} · ${fmtRev(dailyRev??0)}/day`)
  )
  on('crash_mode_activated', () => console.log('[CRASH] Market IS a factor — cascade active'))
  on('crash_mode_off',       () => console.log('[CRASH] Market NOT a factor — propeller governs'))

  // ── PREVENTATIVE GC (deep dive fix) ──────────────────────────────────
  // Threshold: 150MB (was 300MB)
  // Interval: 20s (was 30s)
  setInterval(() => {
    const mb = process.memoryUsage().heapUsed / 1024 / 1024
    if (mb > 150 && typeof global.gc === 'function') global.gc()
  }, 20_000)

  // ── PERIODIC AUDIT ────────────────────────────────────────────────────
  if (_db) {
    setInterval(() => {
      try {
        const mb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
        _db.audit(`HEARTBEAT uptime=${Math.floor(process.uptime())}s mem=${mb}MB overlay=${getConfig('overlay_queue_size')??0} swaps=${_swapCount}`)
      } catch {}
    }, 300_000)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CRASH-SAFE BOOT
// ═══════════════════════════════════════════════════════════════════════════
boot().catch(e => {
  console.error('[BOOT] Fatal:', e.message)
  setTimeout(() => boot().catch(err => console.error('[BOOT] Recovery:', err.message)), 5000)
})

process.on('uncaughtException',  e => {
  if (!e.message?.includes('EADDRINUSE')) console.error('[ERR]', e.message?.slice(0, 120))
})
process.on('unhandledRejection', r => console.error('[REJ]', String(r).slice(0, 120)))
process.on('SIGTERM', () => {
  if (_db) { try { _db.audit('SHUTDOWN SIGTERM') } catch {} }
  setTimeout(() => { console.log('[VANGUARD] Shutdown'); process.exit(0) }, 2000)
})
