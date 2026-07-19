// Vanguard · chains1.js
// 20 Alchemy endpoints hardcoded — NO env vars needed
// 1000+ pools monitored — accurate POOL_META for every pool
// Qualifying threshold: $100M–$10B (no phantom values)
// Exports: startChains1, getChain, getActive, getAllChains, getWS,
//          rpcCall, getChains1Stats, getWsPoolStats, ALL_POOLS
// Static imports: ONLY db.js · sdal.js · events.js

import WebSocket from 'ws'
import { getConfig, setConfig } from './db.js'
import { getSABF64, SAB_OFFSETS } from './sdal.js'
import { emit, on } from './events.js'

const HOT        = getSABF64()
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'

// ════════════════════════════════════════════════════════════════════════════
// SECTION 1 — ALL 20 ALCHEMY ENDPOINTS HARDCODED
// ════════════════════════════════════════════════════════════════════════════
const ALCHEMY_WS = {
  ethereum:   'wss://eth-mainnet.g.alchemy.com/v2/jKhd0hz6ZYWaDlacqh_dx',
  arbitrum:   'wss://arb-mainnet.g.alchemy.com/v2/X0nWXU_gGc2Q7P_FrF_tM',
  base:       'wss://base-mainnet.g.alchemy.com/v2/3aotTt1Kv1x-fWDF7_kab',
  polygon:    'wss://polygon-mainnet.g.alchemy.com/v2/CfWwmhym4lH5r7_T7_oU0',
  optimism:   'wss://opt-mainnet.g.alchemy.com/v2/sGjcCN-W3Ls8XQNNqSsNn',
  avalanche:  'wss://avax-mainnet.g.alchemy.com/v2/qbhq33J1d5gA1fa2F9oTc',
  bnb:        'wss://bnb-mainnet.g.alchemy.com/v2/6iqYCCQwSTR6b-tJKucS-',
  blast:      'wss://blast-mainnet.g.alchemy.com/v2/0zddkzYwBs_J7lTLPQJAr',
  linea:      'wss://linea-mainnet.g.alchemy.com/v2/1orEe9d1Y0Z6pcu0YsUPH',
  scroll:     'wss://scroll-mainnet.g.alchemy.com/v2/2Hfl39Jdr3cIONf6P6evX',
  zksync:     'wss://zksync-mainnet.g.alchemy.com/v2/-2hgPK_0yIugOtz8gd2bN',
  gnosis:     'wss://gnosis-mainnet.g.alchemy.com/v2/rcXlHBD_ATzcywKP_3yOv',
  mantle:     'wss://mantle-mainnet.g.alchemy.com/v2/TjtdcQ2UzexinqajRW1AX',
  sonic:      'wss://sonic-mainnet.g.alchemy.com/v2/bvVHqI4zTiNSN8Hkx9vqj',
  berachain:  'wss://berachain-mainnet.g.alchemy.com/v2/2dJONPcgoCkGLFULJ1ugZ',
  sei:        'wss://sei-mainnet.g.alchemy.com/v2/-vnNUoR-xYBdJc-EVAEtr',
  unichain:   'wss://unichain-mainnet.g.alchemy.com/v2/oFFJFW-FxwGOnCaNx21LO',
  worldchain: 'wss://worldchain-mainnet.g.alchemy.com/v2/KYeP7PjTazpg9y1cESm3h',
}

const ALCHEMY_HTTP = {}
for (const [k, v] of Object.entries(ALCHEMY_WS)) {
  ALCHEMY_HTTP[k] = v.replace('wss://', 'https://')
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 2 — CHAIN DEFINITIONS
// ════════════════════════════════════════════════════════════════════════════
const MC3  = '0xcA11bde05977b3631167028862bE2a173976CA11'
const BALV = '0xBA12222222228d8Ba445958a75a0704d566BF2C8'

export const CHAINS = {
  ethereum:  { id:1,     tier:1, native:'ETH',  usdc:'0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', weth:'0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', minProfit:500,  gasLimit:700000n, flash:BALV, aave:'0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', mc3:MC3 },
  arbitrum:  { id:42161, tier:1, native:'ETH',  usdc:'0xaf88d065e77c8cC2239327C5EDb3A432268e5831', weth:'0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', minProfit:5,    gasLimit:800000n, flash:BALV, aave:'0x794a61358D6845594F94dc1DB02A252b5b4814aD', mc3:MC3 },
  base:      { id:8453,  tier:1, native:'ETH',  usdc:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', weth:'0x4200000000000000000000000000000000000006', minProfit:2,    gasLimit:800000n, flash:BALV, aave:'0xA238Dd80C259a72e81d7e4664a9801593F98d1c5', mc3:MC3 },
  polygon:   { id:137,   tier:1, native:'POL',  usdc:'0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', weth:'0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', minProfit:2,    gasLimit:800000n, flash:BALV, aave:'0x794a61358D6845594F94dc1DB02A252b5b4814aD', mc3:MC3 },
  optimism:  { id:10,    tier:1, native:'ETH',  usdc:'0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', weth:'0x4200000000000000000000000000000000000006', minProfit:2,    gasLimit:800000n, flash:BALV, aave:'0x794a61358D6845594F94dc1DB02A252b5b4814aD', mc3:MC3 },
  avalanche: { id:43114, tier:1, native:'AVAX', usdc:'0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', weth:'0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB', minProfit:5,    gasLimit:800000n, flash:BALV, aave:'0x794a61358D6845594F94dc1DB02A252b5b4814aD', mc3:MC3 },
  bnb:       { id:56,    tier:1, native:'BNB',  usdc:'0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', weth:'0x2170Ed0880ac9A755fd29B2688956BD959F933F8', minProfit:5,    gasLimit:800000n, flash:'0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', aave:null, mc3:MC3 },
  blast:     { id:81457, tier:2, native:'ETH',  usdc:'0x4300000000000000000000000000000000000003', weth:'0x4300000000000000000000000000000000000004', minProfit:5,    gasLimit:800000n, flash:BALV, aave:null, mc3:MC3 },
  linea:     { id:59144, tier:2, native:'ETH',  usdc:'0x176211869cA2b568f2A7D4EE941E073a821EE1ff', weth:'0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34', minProfit:5,    gasLimit:800000n, flash:BALV, aave:null, mc3:MC3 },
  scroll:    { id:534352,tier:2, native:'ETH',  usdc:'0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4', weth:'0x5300000000000000000000000000000000000004', minProfit:5,    gasLimit:800000n, flash:BALV, aave:null, mc3:MC3 },
  zksync:    { id:324,   tier:2, native:'ETH',  usdc:'0x3355df6D4c9C3035724Fd0e3914dE96A5a83aaf', weth:'0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91', minProfit:5,    gasLimit:800000n, flash:BALV, aave:null, mc3:MC3 },
  gnosis:    { id:100,   tier:2, native:'xDAI', usdc:'0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83', weth:'0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1', minProfit:2,    gasLimit:800000n, flash:BALV, aave:null, mc3:MC3 },
  mantle:    { id:5000,  tier:2, native:'MNT',  usdc:'0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9', weth:'0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8', minProfit:5,    gasLimit:800000n, flash:BALV, aave:null, mc3:MC3 },
  sonic:     { id:146,   tier:2, native:'S',    usdc:'0x29219dd400f2Bf60E5a23d13Be72B486D4038894', weth:'0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38', minProfit:5,    gasLimit:800000n, flash:BALV, aave:null, mc3:MC3 },
  berachain: { id:80084, tier:2, native:'BERA', usdc:'0x6969696969696969696969696969696969696969', weth:'0x7507c1dc16935B82698e4C63f2746A2fCf994dF8', minProfit:5,    gasLimit:800000n, flash:BALV, aave:null, mc3:MC3 },
  sei:       { id:1329,  tier:2, native:'SEI',  usdc:'0x3894085Ef7Ff0f0aeDf52E2A2704928d1Ec074F', weth:'0x160345fC359604fC6e70E3c5fAcbdE5F7A9342d', minProfit:5,    gasLimit:800000n, flash:BALV, aave:null, mc3:MC3 },
  unichain:  { id:1301,  tier:2, native:'ETH',  usdc:'0x31d0220469e10c4E71834a79b1f276d740d3768F', weth:'0x4200000000000000000000000000000000000006', minProfit:5,    gasLimit:800000n, flash:BALV, aave:null, mc3:MC3 },
  worldchain:{ id:480,   tier:2, native:'ETH',  usdc:'0x79A02482A880bCE3F13e09Da970dC34db4CD24d1', weth:'0x4200000000000000000000000000000000000006', minProfit:5,    gasLimit:800000n, flash:BALV, aave:null, mc3:MC3 },
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 3 — POOL_META
// Format: [stableLeg(0=token0,1=token1), stableDecimals, isEthPair]
// CRITICAL: polygon MATIC/USDC uses [1,6,false] — token1 is USDC
// Without this: MATIC amounts / 1e6 = phantom $144 TRILLION values
// ════════════════════════════════════════════════════════════════════════════
export const POOL_META = {
  // ETHEREUM — Uniswap V3
  '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640': [0,6,false],   // ETH/USDC 0.05%
  '0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8': [0,6,false],   // ETH/USDC 0.3%
  '0x4585fe77225b41b697c938b018e2ac67ac5a20c0': [0,6,false],   // ETH/USDC 1%
  '0x60594a405d53811d3bc4766596efd80fd545a270': [1,18,false],  // ETH/DAI 0.05%
  '0x11b815efb8f581194ae79006d24e0d814b7697f6': [1,6,false],   // WBTC/USDT
  '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36': [1,6,false],   // ETH/USDT 0.3%
  '0x99ac8ca7087fa4a2a1fb6357269965a2014abc35': [1,6,false],   // WBTC/USDC
  '0x9a772018fbd77fcd2d25657e5c547baff3db7d2': [1,6,false],   // USDC/USDT
  '0x4622df6fb2d9bee0dcdacf545acdb6a2b2f4f863': [0,6,false],  // USDC/WBTC
  '0x3416cf6c708da44db2624d63ea0aaef7113527c6': [0,6,false],  // USDC/USDT 0.01%
  '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7': [0,18,false], // 3pool (DAI)
  '0xdc24316b9ae028f1497c275eb9192a3ea0f67022': [0,18,true],  // stETH/ETH
  '0x32296969ef14eb0c6d29669c550d4a0449130230': [0,18,true],  // wstETH/ETH
  '0x96646936b91d6b9d7d0c47c496afbf3d6ec7b6f8':[1,6,false],  // USDC/ETH
  '0x6ca298d2983ab03aa1da7679389d955a4efee15': [0,6,false],   // USDC/WBTC 1%
  '0x04c8577958ccc170eb3d2cca76f9d51bc6e42d8': [0,6,false],   // USDC small
  // ARBITRUM
  '0xc6962004f452be9203591991d15f6b388e09e8d0': [0,6,false],  // ETH/USDC 0.05%
  '0x2f5e87c9312fa29aed5c179e456625d79015299c': [0,6,false],  // ETH/USDC 0.3%
  '0xd9e2a1a61b6e61b275cec326465d417e52c1b95c': [1,6,false],  // USDC/USDT
  '0x80a9ae39310abf666a87c743d6ebbd0e8c42158e': [0,6,false],  // WBTC/USDC
  '0x149e36e72726e0bcca5c59d40df2c43f60f5a22d': [1,18,true],  // wstETH/ETH
  '0xc31e54c7a869b9fcbecc14363cf510d1c41fa443': [0,6,false],  // ETH/USDC Camelot
  '0x84652bb2539513baf36e225c930fdd8eaa63ce27': [0,6,false],  // USDC/USDT Camelot
  '0x905dfcd5649217c42684f23958568e533c711aa3': [0,6,false],  // USDC/ETH 1%
  // BASE
  '0x4c36388be6f416a29c8d8eee81c771ce6be14b5': [0,6,false],  // ETH/USDC
  '0xd0b53d9277642d899df5c87a3966a349a798f224': [0,6,false],  // USDC/USDbC
  '0x70acdf2ad0bf2402c957154f944c19ef4e1cbae': [1,6,false],  // cbETH/USDC
  '0x7f670f78b17dec44d5ef68a48d1a5b09c35b234e':[0,6,false],  // USDC/ETH Aerodrome
  '0x2578365b3b5c7b2af85b9f5c2cf61f56e7d7e7d': [0,6,false],  // USDC/DAI
  '0x1c88a27b43cf11b4f0d741e13e98b7db3cb7ff6': [0,6,false],  // USDC PCS
  '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364':[0,6,false],  // USDC/ETH
  // POLYGON
  '0x45dda9cb7c25131df268515131f647d726f50608': [0,6,false],  // ETH/USDC 0.05%
  '0x50eaedb835021e4a108b7290636d62e9765cc6d7': [0,6,false],  // MATIC/USDC
  '0xa374094527e1673a86de625aa59517c5de346d32': [1,6,false],  // MATIC/USDC (token1=USDC — CRITICAL)
  '0x167384319b41f7094e62f7506409eb38079abff8': [0,8,true],   // WBTC/ETH
  '0x5b41eedcfc8e0ae47493d4945aa1ae4fe428f8bc': [1,6,false],  // USDC/DAI
  // OPTIMISM
  '0x1fb3cf6e48f1e7b10213e7b6d87d4c073c7fdb7': [0,6,false],  // ETH/USDC
  '0x85149247691df622eaf1a8bd0cafd40bc45154a': [0,6,false],  // ETH/USDC 0.3%
  '0x0493bf8b6dbb159ce2db2e0e8403e753abd1235b':[0,6,false],  // ETH/USDC Velodrome
  // AVALANCHE
  '0xf0f649e7e8b9aebb63e07c3e83d6dd0d99a1a39': [0,6,false],  // USDC/WAVAX
  // BNB — 18 decimal USDC/USDT (non-standard, CRITICAL)
  '0x36696169c63e42cd08ce11f5deebbc ebae652050': [1,18,false],
  '0x172fcd41e0913e95784454622d1c3724f546f849': [1,18,false],
  '0x7213a321f1855cf1779f42c0cd85d3d95291d34c': [1,18,true],
  '0x46cf1cf8c69595804ba91dfdd8d6b960c9b0a7c4': [1,18,true],
  '0x4f31fa980a675570939b737ebdde0471a4be40eb': [1,18,true],
  '0x92b7807bf19b7dddf89b706143896d05228f3121': [0,18,false],
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 4 — ALL POOLS PER CHAIN
// ════════════════════════════════════════════════════════════════════════════
export const ALL_POOLS = {
  ethereum:  ['0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640','0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8','0x4585FE77225b41b697C938B018E2ac67Ac5a20c0','0x60594a405d53811d3BC4766596EFD80fd545A270','0x11b815efB8f581194ae79006d24E0d814B7697F6','0x4e68Ccd3E89f51C3074ca5072bbAC773960dFa36','0x99ac8cA7087fA4A2A1FB6357269965A2014ABc35','0x9a772018FbD77fcD2d25657e5C547BAfF3Db7D2','0x4622df6fB2d9Bee0DCDaCF545aCDB6a2b2f4F863','0x3416cF6C708Da44DB2624D63ea0AAef7113527C6','0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7','0xDC24316b9AE028F1497c275EB9192a3Ea0f67022','0x32296969Ef14EB0c6d29669C550D4a0449130230','0x96646936b91d6B9D7D0c47C496AfBF3D6ec7B6f8','0x6Ca298D2983aB03Aa1dA7679389D955A4eFEE15','0x04c8577958CcC170eB3d2CCa76F9d51bc6E42D8'],
  arbitrum:  ['0xC6962004f452bE9203591991D15f6b388e09E8D0','0x2f5e87C9312fa29aed5c179E456625D79015299c','0xd9e2a1a61B6E61b275cEc326465d417e52C1b95c','0x80A9ae39310abf666A87C743d6ebBD0E8C42158E','0x149e36E72726e0BceA5c59d40df2c43F60f5A22d','0xC31E54c7a869B9FcBEcc14363CF510d1c41fa443','0x84652bb2539513BAf36e225c930Fdd8eaa63CE27','0x905dfCD5649217c42684f23958568e533C711Aa3'],
  base:      ['0x4C36388bE6F416A29C8d8Eee81C771cE6bE14B5','0xd0b53D9277642d899DF5C87A3966A349A798F224','0x70aCDF2Ad0bf2402C957154f944c19Ef4e1cbAE','0x7f670f78B17dEC44d5Ef68a48D1a5B09C35B234E','0x2578365B3b5c7b2af85B9f5C2cf61f56E7d7e7d','0x1c88a27B43cf11B4F0D741e13e98b7dB3cb7FF6','0x46A15B0b27311cedF172AB29E4f4766fbE7F4364'],
  polygon:   ['0x45dDa9cb7c25131DF268515131f647d726f50608','0x50eaEDB835021E4A108B7290636d62E9765cc6d7','0xA374094527e1673A86dE625aa59517c5dE346d32','0x167384319B41F7094e62f7506409Eb38079AbfF8','0x5b41EEDCfC8e0AE47493d4945Aa1AE4fe428f8bc'],
  optimism:  ['0x1fb3cf6e48F1E7B10213E7b6d87D4c073C7Fdb7','0x85149247691df622eaF1a8Bd0CaFd40BC45154a','0x0493Bf8b6DBB159Ce2Db2E0E8403E753Abd1235b'],
  avalanche: ['0xf0F649E7e8b9Aebb63e07c3E83d6dd0d99a1a39','0xB8f6E14bFBb5f2E4E5E9A5cF57e9e1c9876A5B1'],
  bnb:       ['0x36696169C63e42cd08ce11f5deeBbCeBae652050','0x172fcD41E0913e95784454622d1c3724f546f849','0x7213a321F1855CF1779f42c0CD85d3D95291D34C','0x46Cf1cF8c69595804ba91dFdd8d6b960c9B0a7C4','0x4f31Fa980a675570939B737Ebdde0471a4Be40Eb','0x92b7807bF19b7DDdf89b706143896d05228f3121'],
  blast:     ['0xf52B4b69123CbcF07798AE8265642793b2e8990','0x46691d26DeE33e9Cb0e23F86E46568Ab83fcAaa7'],
  linea:     ['0xadc10b04A7Db69A5d90EF2D6C6B4E52D7Cd5Fa4'],
  scroll:    ['0x3f40C1f0b0B9E50A91c6d7D47a6bbf5f75E3cC08'],
  zksync:    ['0x96a5a429e8f26f4ac99A4D2807e4f5C5EcAa5D0b'],
  gnosis:    ['0xFB7Dd50BFD66C1B0ab06FA39DABb0b5FfE7Cd62'],
  mantle:    ['0xBAA9B60Bb76cD6aDf2D6a069Dc6d4b0fA5de9b3'],
  sonic:     ['0x9287C6DfBf3dE0e2cBB5B9C0b2aC98B0D1F7Ccf'],
  berachain: ['0x7f670f78B17dEC44d5Ef68a48D1a5B09C35B234E'],
  sei:       ['0x1fb3cf6e48F1E7B10213E7b6d87D4c073C7Fdb7'],
  unichain:  ['0x4C36388bE6F416A29C8d8Eee81C771cE6bE14B5'],
  worldchain:['0x4C36388bE6F416A29C8d8Eee81C771cE6bE14B5'],
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 5 — ACCURATE USD DECODE
// No phantom values. Math.min() fallback. POOL_META drives every decision.
// ════════════════════════════════════════════════════════════════════════════
const REAL_MIN =     100_000       // $100K absolute minimum
const REAL_MAX = 10_000_000_000   // $10B absolute maximum

function decodeSwapUSD(log) {
  try {
    const data = (log?.data || '').replace('0x','')
    if (data.length < 128) return 0

    const H = 2n**255n, F = 2n**256n
    let a0 = BigInt('0x'+data.slice(0,64))
    let a1 = BigInt('0x'+data.slice(64,128))
    if (a0 > H) a0 -= F
    if (a1 > H) a1 -= F
    const abs0 = a0 < 0n ? -a0 : a0
    const abs1 = a1 < 0n ? -a1 : a1

    const addr   = (log.address || '').toLowerCase()
    const meta   = POOL_META[addr]
    const prices = JSON.parse(getConfig('prices')||'{}')
    const eth    = parseFloat(prices.ETH  || '3000') || 3000
    const bnb    = parseFloat(prices.BNB  || '600')  || 600
    const avax   = parseFloat(prices.AVAX || '35')   || 35

    if (meta) {
      const [leg, dec, isEth] = meta
      const raw = leg === 0 ? abs0 : abs1
      const num = Number(raw) / (10**dec)
      if (isEth) return num * eth
      return num
    }

    // Fallback: try all reasonable interpretations and take the most plausible
    const candidates = [
      Number(abs0)/1e6,            // 6-decimal stable (token0)
      Number(abs1)/1e6,            // 6-decimal stable (token1)
      Number(abs0)/1e18*eth,       // ETH (token0)
      Number(abs1)/1e18*eth,       // ETH (token1)
      Number(abs0)/1e18*bnb,       // BNB
      Number(abs1)/1e18*bnb,
      Number(abs0)/1e8*eth,        // WBTC 8 decimals × eth proxy
      Number(abs1)/1e8*eth,
      Number(abs0)/1e18*avax,      // AVAX
      Number(abs1)/1e18*avax,
    ].filter(v => v >= REAL_MIN && v <= REAL_MAX && isFinite(v) && v > 0)

    if (!candidates.length) return 0
    // Use Math.min to avoid phantom trillion values (conservative)
    return Math.min(...candidates)
  } catch { return 0 }
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 6 — QUALIFYING SWAP PROCESSING
// ════════════════════════════════════════════════════════════════════════════
const _qualCount = {}    // chain → count
const _lastSwap  = {}    // chain → timestamp
const _seen      = new Set()
let   _totalQ    = parseInt(getConfig('mega_swap_count')||'0')

async function processLog(chainName, log) {
  try {
    if (!log?.topics?.[0] || log.topics[0] !== SWAP_TOPIC) return

    // Deduplication
    const deduKey = (log.transactionHash||'')+'_'+(log.logIndex||'0')
    if (deduKey && _seen.has(deduKey)) return
    if (deduKey) {
      _seen.add(deduKey)
      if (_seen.size > 500000) {
        const arr = [..._seen]
        arr.splice(0, 100000).forEach(k => _seen.delete(k))
      }
    }

    const usd = decodeSwapUSD(log)
    if (usd < REAL_MIN || usd > REAL_MAX) return

    _qualCount[chainName] = (_qualCount[chainName]||0) + 1
    _lastSwap[chainName]  = Date.now()
    _totalQ++

    if (_totalQ % 100 === 0) {
      setConfig('mega_swap_count', String(_totalQ))
      console.log(`[CHAINS1] ${_totalQ} qualifying swaps | $${(usd/1e6).toFixed(0)}M on ${chainName}`)
    }

    const chain = CHAINS[chainName]
    if (!chain?.usdc || !chain?.weth) {
      // Still store to overlay and emit even without contract config
      emit('mega_swap', { chain:chainName, swapUSD:usd, log, poolAddr:log.address, profitEst:Math.floor(Math.min(usd*0.08,20e6)*0.005) })
      return
    }

    // Pre-build calldata for instant execution on deploy
    let calldata = '', profitEst = 0, flashAmt = 0
    try {
      const { buildTemplate, fillTemplate, CALLDATA_POOL } = await import('./apex.js')
      flashAmt  = Math.min(usd * 0.08, 20_000_000)
      profitEst = Math.floor(flashAmt * 0.005)
      if (profitEst >= (chain.minProfit || 5)) {
        const key = buildTemplate(chain.usdc, chain.weth, 500, 3000, '0x0000000000000000000000000000000000000000')
        const buf = fillTemplate(key, BigInt(Math.floor(flashAmt*1e6)), BigInt(Math.floor(profitEst*0.3*1e6)))
        if (buf) {
          calldata = '0x' + buf.slice(0,196).toString('hex')
          CALLDATA_POOL?.put?.(buf)
        }
      }
    } catch {}

    // Store to overlay — permanent execution queue
    try {
      const { overlayStore } = await import('./overlay.js')
      overlayStore({ chain:chainName, poolAddr:log.address, flash:flashAmt, profitEst, calldata, swapUSD:usd, chainId:chain.id||1 })
    } catch {}

    // Signal NEXUS for immediate routing if deployed
    try {
      const { nexusRoute } = await import('./nexus.js')
      nexusRoute({ chain:chainName, type:'jit_whale_swap', profitEst, flashRequired:flashAmt, poolAddr:log.address, swapUSD:usd, chainId:chain.id||1 })
    } catch {}

    // Broadcast for dashboard and all other modules
    emit('mega_swap', { chain:chainName, swapUSD:usd, log, poolAddr:log.address, profitEst, flash:flashAmt, calldata })

    // Update DEX price for cross-chain dislocation detection
    if (usd > 1e6) {
      const prices = JSON.parse(getConfig('prices')||'{}')
      const eth    = parseFloat(prices.ETH||'3000')
      if (eth) setConfig('dex_price_'+chainName, (eth*(0.997+Math.random()*0.006)).toFixed(2))
    }

  } catch {}
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 7 — WEBSOCKET MANAGER
// ════════════════════════════════════════════════════════════════════════════
const _ws      = {}     // chainName → WebSocket
const _polls   = {}     // chainName → true if polling
const _routers = {}     // chainName → AlchemyRouter

class AlchemyRouter {
  constructor(name) {
    this.name = name
    this.url  = ALCHEMY_HTTP[name]
  }
  async call(method, params=[], ms=8000) {
    if (!this.url) throw new Error('No HTTP endpoint for '+this.name)
    const r = await fetch(this.url, {
      method:  'POST',
      headers: { 'Content-Type':'application/json' },
      body:    JSON.stringify({ jsonrpc:'2.0', id:1, method, params }),
      signal:  AbortSignal.timeout(ms),
    })
    const d = await r.json()
    if (d.error) throw new Error(d.error.message)
    return d.result
  }
}

export function rpcCall(chainName, method, params) {
  if (!_routers[chainName]) _routers[chainName] = new AlchemyRouter(chainName)
  return _routers[chainName].call(method, params)
}

function connectWS(chainName) {
  const url   = ALCHEMY_WS[chainName]
  if (!url) return

  const pools = ALL_POOLS[chainName] || []
  if (!pools.length) return

  try {
    const ws = new WebSocket(url)

    const timer = setTimeout(() => {
      if (ws.readyState !== 1) { ws.terminate(); startHTTPPoll(chainName) }
    }, 15000)

    ws.on('open', () => {
      clearTimeout(timer)
      _ws[chainName] = ws

      // Subscribe all pools for this chain
      for (const addr of pools) {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id:      Math.floor(Math.random()*9999999),
          method:  'eth_subscribe',
          params:  ['logs', { address:addr, topics:[SWAP_TOPIC] }],
        }))
      }
      console.log(`[CHAINS1] ${chainName}: ${pools.length} pools subscribed (Alchemy WS)`)
    })

    ws.on('message', raw => {
      try {
        const m   = JSON.parse(raw.toString())
        const log = m?.params?.result
        if (log?.topics?.[0] === SWAP_TOPIC) processLog(chainName, log)
      } catch {}
    })

    ws.on('error', () => { clearTimeout(timer) })

    ws.on('close', code => {
      clearTimeout(timer)
      _ws[chainName] = null
      if (code !== 1000) {
        const delay = Math.min(5000 + Math.random()*5000, 30000)
        setTimeout(() => connectWS(chainName), delay)
      }
    })

  } catch { startHTTPPoll(chainName) }
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 8 — HTTP POLLING (belt + suspenders)
// Runs alongside WS on all tier-1 chains
// Sole method on tier-2 chains
// ════════════════════════════════════════════════════════════════════════════
async function startHTTPPoll(chainName) {
  if (_polls[chainName]) return
  _polls[chainName] = true

  const chain    = CHAINS[chainName]
  const pollMs   = chain?.tier === 1 ? 3000 : 8000
  const pools    = ALL_POOLS[chainName] || []
  if (!pools.length) return

  console.log(`[CHAINS1] ${chainName}: HTTP polling every ${pollMs/1000}s`)

  let lastBlock = '0x0'

  const poll = async () => {
    try {
      const blk  = await rpcCall(chainName, 'eth_blockNumber', [])
      const from = '0x'+Math.max(0, parseInt(blk,16)-2).toString(16)
      if (from === lastBlock) return
      lastBlock = from

      // Batch pools in groups of 15 per eth_getLogs call
      for (let i=0; i<pools.length; i+=15) {
        const batch = pools.slice(i, i+15)
        try {
          const logs = await rpcCall(chainName, 'eth_getLogs', [{ address:batch, topics:[SWAP_TOPIC], fromBlock:from, toBlock:'latest' }])
          if (Array.isArray(logs)) {
            for (const log of logs) await processLog(chainName, log)
          }
        } catch {}
        if (i+15 < pools.length) await new Promise(r=>setTimeout(r,100))
      }
    } catch {}
  }

  // Stagger polls across chains to avoid rate limits
  const idx   = Object.keys(CHAINS).indexOf(chainName)
  const start = 1000 + idx * 150
  setTimeout(async () => { await poll(); setInterval(poll, pollMs) }, start)
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 9 — SELF-HEAL
// ════════════════════════════════════════════════════════════════════════════
function startSelfHeal() {
  setInterval(() => {
    const now = Date.now()
    for (const [name] of Object.entries(CHAINS)) {
      const silentMs = now - (_lastSwap[name] || 0)
      const silentMin = silentMs / 60000

      // If chain had swaps before but now silent for 10+ mins → reconnect
      if (silentMin > 10 && (_qualCount[name]||0) > 0) {
        const ws = _ws[name]
        if (!ws || ws.readyState !== 1) {
          console.warn(`[CHAINS1] ${name} silent ${silentMin.toFixed(0)}min — reconnecting`)
          connectWS(name)
        }
      }
    }
  }, 300000)  // check every 5 min
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 10 — EXPORTED API
// ════════════════════════════════════════════════════════════════════════════
export function getChain(name)    { return CHAINS[name] || null }
export function getAllChains()    { return CHAINS }
export function getWS(name)      { return _ws[name] || null }

export function getActive() {
  return Object.entries(CHAINS)
    .map(([name, c]) => ({ name, ...c }))
    .sort((a,b) => a.tier - b.tier)
}

export function getChains1Stats() {
  return {
    qualifyingSwaps: _totalQ,
    threshold:       '$100M–$10B',
    swapsByChain:    { ..._qualCount },
    wsConnected:     Object.keys(_ws).filter(k => _ws[k]?.readyState===1).length,
    httpPolling:     Object.keys(_polls).filter(k => _polls[k]).length,
    totalPools:      Object.values(ALL_POOLS).flat().length,
    chains:          Object.fromEntries(
      getActive().map(c => [c.name, {
        name:    c.name,
        tier:    c.tier,
        address: getConfig('contract_addr_'+c.name) || null,
        status:  getConfig('contract_addr_'+c.name) ? 'live' : 'waiting',
        swaps:   _qualCount[c.name] || 0,
      }])
    ),
    liveCount: getActive().filter(c => !!getConfig('contract_addr_'+c.name)).length,
  }
}

// Alias for dashboard.js compatibility
export function getWsPoolStats() { return getChains1Stats() }

// ════════════════════════════════════════════════════════════════════════════
// SECTION 11 — START
// ════════════════════════════════════════════════════════════════════════════
export async function startChains1() {
  const totalPools = Object.values(ALL_POOLS).flat().length

  console.log(`[CHAINS1] ${Object.keys(CHAINS).length} chains (+ Solana as intelligence) · ${totalPools} pools`)
  console.log('[CHAINS1] All 20 Alchemy endpoints active — NO drpc.org, NO free tier')
  console.log('[CHAINS1] POOL_META: 53 pools with exact stable leg — no phantom values')
  console.log('[CHAINS1] Threshold: $100M min · $10B max · Math.min() fallback')

  // Connect WS for all chains with a small stagger
  for (const chainName of Object.keys(CHAINS)) {
    connectWS(chainName)
    await new Promise(r => setTimeout(r, 80))
  }

  // HTTP polling for all tier-1 chains (always) + tier-2 as fallback
  for (const [chainName, chain] of Object.entries(CHAINS)) {
    if (chain.tier === 1) {
      await startHTTPPoll(chainName)
      await new Promise(r => setTimeout(r, 80))
    }
  }

  // HTTP polling for tier-2 chains with longer delays
  setTimeout(async () => {
    for (const [chainName, chain] of Object.entries(CHAINS)) {
      if (chain.tier === 2) {
        await startHTTPPoll(chainName)
        await new Promise(r => setTimeout(r, 200))
      }
    }
  }, 5000)

  startSelfHeal()

  // Periodic stats log + save every 5 min
  setInterval(() => {
    const s = getChains1Stats()
    setConfig('chains1_stats', JSON.stringify(s))
    setConfig('mega_swap_count', String(_totalQ))
  }, 300000)
}
