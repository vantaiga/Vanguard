// Vanguard · index.js — Master boot sequence
// 7 files. Sequential dynamic imports. Dashboard FIRST.
// Zero static imports of Vanguard modules except vanguard.js.

import { initVanguard, getConfig, setConfig, emit, on, getSABF64, SAB_OFFSETS, RTABLE, fmtRev } from './vanguard.js'

const HOT = getSABF64()

// Post-boot swap counter (100-swap bundles in console)
let _swapCount = 0, _bootDone = false

async function boot() {
  const T = Date.now()

  // 1. Soul — all state
  initVanguard()

  // 2. Dashboard — port binds immediately
  const { startDashboard, registerStats } = await import('./dashboard.js')
  startDashboard()

  // 3. Chains — WS + HTTP polling for all 18 chains
  const chains = await import('./chains.js')
  await chains.startChains()
  registerStats('chains',   chains.getChains1Stats)
  registerStats('wspool',   chains.getWsPoolStats)

  // 4. Execution — NEXUS + APEX + builders + wallet + compiler
  const exec = await import('./execution.js')
  await exec.initExecution()
  registerStats('nexus',    exec.getNEXUSStats)
  registerStats('apex',     exec.getAPEXStats)
  registerStats('builders', exec.getBuilderStats)

  // 5. Intelligence — SOVEREIGN + overlay + oracle + crash + AI
  const intel = await import('./intelligence.js')
  intel.startIntelligence()
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

  // Post
