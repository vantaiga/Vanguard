// X7 PROTOCOL — ENTRY POINT
// Boot order: health → DB → strategies → scanner → engine
// All 4 strategies start immediately on boot
// Revenue detection active within seconds

import { startDashboard, broadcast } from './dashboard.js'

console.log('X7 PROTOCOL STARTING')
startDashboard()
console.log('/health live')

setTimeout(boot, 1500)

async function boot() {
  // DB
  try { const {initDB}=await import('./db.js'); await initDB() }
  catch(e) { console.error('DB fatal:',e.message); process.exit(1) }

  const need = ['EXECUTOR_PRIVATE_KEY','MODEM_PAY_SECRET_KEY','MODEM_PAY_WAVE_NUMBER']
  const miss  = need.filter(k=>!process.env[k])
  if (miss.length) console.warn('[BOOT] Missing:', miss.join(', '))

  try {
    const {getExecutorAddress} = await import('./pimlico.js')
    const addr = getExecutorAddress()
    console.log('[BOOT] Executor: ' + addr)
    console.log('[BOOT] Send 0.01 POL to above address on Polygon')
  } catch {}

  // APEX — market intelligence
  try { const {startApex}=await import('./apex.js'); await startApex() }
  catch(e) { console.warn('[APEX]:', e.message) }

  // COMPILE — contract bytecode ready
  try { const {compile}=await import('./compiler.js'); await compile() }
  catch(e) { console.warn('[COMPILE]:', e.message) }

  // DEPLOY RETRY LOOP — deploys the second MATIC arrives
  try {
    const {startDeployRetryLoop} = await import('./deployer.js')
    startDeployRetryLoop()
  } catch(e) { console.warn('[DEPLOY]:', e.message) }

  // STRATEGY 1 — CEX-DEX Arbitrage (starts scanning immediately)
  try {
    const {startCexDex} = await import('./cexdex.js')
    startCexDex()
  } catch(e) { console.warn('[CEX-DEX]:', e.message) }

  // STRATEGY 2 — Atomic Backrun (watches pools from second 1)
  try {
    const {startBackrun} = await import('./backrun.js')
    startBackrun()
  } catch(e) { console.warn('[BACKRUN]:', e.message) }

  // STRATEGY 3 — JIT Liquidity (mempool watcher starts immediately)
  try {
    const {startJIT} = await import('./jit.js')
    startJIT()
  } catch(e) { console.warn('[JIT]:', e.message) }

  // YIELD — passive income on idle USDC
  try { const {startYield}=await import('./yield.js'); startYield() }
  catch(e) { console.warn('[YIELD]:', e.message) }

  // LEARNER — win rate optimization
  try { const {startLearner}=await import('./learner.js'); startLearner() }
  catch(e) { console.warn('[LEARNER]:', e.message) }

  // STRATEGY 4 + SCANNER — liquidation engine with 100K borrowers
  try { await startEngine() }
  catch(e) { console.error('[ENGINE]:', e.message) }

  console.log('X7 PROTOCOL OPERATIONAL — ALL 4 STRATEGIES ACTIVE')
}

async function startEngine() {
  const {startScanner}         = await import('./scanner.js')
  const {executeLiquidation}   = await import('./liquidate.js')
  const {checkAutoWithdraw}    = await import('./treasury.js')
  const {setConfig, getConfig} = await import('./db.js')

  // Three priority tiers
  const tier0 = [] // HF < 0.85 — execute instantly
  const tier1 = [] // HF < 0.95 — 100% close factor
  const tier2 = [] // HF < 1.00 — 50% close factor
  let   busy  = false

  const enqueue = opp => {
    const q = opp.hf < 0.85 ? tier0 : opp.tier1 ? tier1 : tier2
    const exists = q.find(o =>
      o.borrower === opp.borrower && o.chainName === opp.chainName)
    if (!exists) {
      q.push(opp)
      const tier = opp.hf < 0.85 ? 0 : opp.tier1 ? 1 : 2
      console.log('[QUEUE] ' + opp.chainName + ' ' +
        opp.borrower?.slice(0,10) + ' HF=' + opp.hf?.toFixed(4) +
        ' tier' + tier)
      broadcast('opportunity', { chain:opp.chainName, hf:opp.hf, tier })
    }
  }

  // 100ms execution loop — tier0 first, always
  setInterval(async () => {
    if (busy) return
    const opp = tier0.shift() || tier1.shift() || tier2.shift()
    if (!opp) return
    busy = true
    try {
      const result = await executeLiquidation(opp)
      if (result?.success) {
        broadcast('execution', { chain:opp.chainName, profit:result.profitUSD })
        await checkAutoWithdraw().catch(() => {})
        setConfig('cascade_trigger_' + opp.chainName, Date.now())
      }
    } catch(e) { console.error('[QUEUE]:', e.message) }
    finally { busy = false }
  }, 100)

  startScanner(enqueue)
  console.log('[ENGINE] 3-tier queue — 100ms cycle — 100K borrowers loading')
}

process.on('uncaughtException',  e => console.error('[UNCAUGHT]:', e.message))
process.on('unhandledRejection', e => console.error('[REJECTION]:', String(e).slice(0,200)))
process.on('SIGTERM', () => { console.log('SIGTERM'); process.exit(0) })
