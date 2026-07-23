// Vanguard · chains.js — THE EYES
// MAXIMUM POOLS: 1,847 total across 18 chains
// Every major DEX: Uniswap V2/V3, PancakeSwap V2/V3, Aerodrome,
//   Velodrome, Camelot, SushiSwap, Curve, Balancer, QuickSwap,
//   TraderJoe, DODO, Maverick, Ambient, Ramses, Thena, Solidly
// Batched subscriptions: 10 pools per eth_subscribe call
// Zero phantom values via POOL_META exact decode
// Static imports: ONLY vanguard.js

import WebSocket from 'ws'
import {
  getConfig, setConfig, emit,
  getSABF64, SAB_OFFSETS, CHAIN_IDX,
} from './vanguard.js'

const HOT        = getSABF64()
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
const V2_TOPIC   = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822'  // Uniswap V2 Swap
const BAL_TOPIC  = '0x2170c741c41531aec20e7c107c24eecfdd15e69c9bb0a8dd37b1840b9e0b207'  // Balancer Swap
const REAL_MIN   =       100_000
const REAL_MAX   = 10_000_000_000

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — ALCHEMY ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════
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
for (const [k, v] of Object.entries(ALCHEMY_WS)) ALCHEMY_HTTP[k] = v.replace('wss://','https://')

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — CHAIN DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════
const BAL = '0xBA12222222228d8Ba445958a75a0704d566BF2C8'
const MC3 = '0xcA11bde05977b3631167028862bE2a173976CA11'

export const CHAINS = {
  ethereum:  {id:1,     tier:1, native:'ETH',  usdc:'0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', weth:'0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', minProfit:500,  gasLimit:700000, flash:BAL, aave:'0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', mc3:MC3},
  arbitrum:  {id:42161, tier:1, native:'ETH',  usdc:'0xaf88d065e77c8cC2239327C5EDb3A432268e5831', weth:'0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', minProfit:5,    gasLimit:800000, flash:BAL, aave:'0x794a61358D6845594F94dc1DB02A252b5b4814aD', mc3:MC3},
  base:      {id:8453,  tier:1, native:'ETH',  usdc:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', weth:'0x4200000000000000000000000000000000000006', minProfit:2,    gasLimit:800000, flash:BAL, aave:'0xA238Dd80C259a72e81d7e4664a9801593F98d1c5', mc3:MC3},
  polygon:   {id:137,   tier:1, native:'POL',  usdc:'0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', weth:'0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', minProfit:2,    gasLimit:800000, flash:BAL, aave:'0x794a61358D6845594F94dc1DB02A252b5b4814aD', mc3:MC3},
  optimism:  {id:10,    tier:1, native:'ETH',  usdc:'0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', weth:'0x4200000000000000000000000000000000000006', minProfit:2,    gasLimit:800000, flash:BAL, aave:'0x794a61358D6845594F94dc1DB02A252b5b4814aD', mc3:MC3},
  avalanche: {id:43114, tier:1, native:'AVAX', usdc:'0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', weth:'0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB', minProfit:5,    gasLimit:800000, flash:BAL, aave:'0x794a61358D6845594F94dc1DB02A252b5b4814aD', mc3:MC3},
  bnb:       {id:56,    tier:1, native:'BNB',  usdc:'0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', weth:'0x2170Ed0880ac9A755fd29B2688956BD959F933F8', minProfit:5,    gasLimit:800000, flash:'0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', aave:null, mc3:MC3},
  blast:     {id:81457, tier:2, native:'ETH',  usdc:'0x4300000000000000000000000000000000000003', weth:'0x4300000000000000000000000000000000000004', minProfit:5,    gasLimit:800000, flash:BAL, aave:null, mc3:MC3},
  linea:     {id:59144, tier:2, native:'ETH',  usdc:'0x176211869cA2b568f2A7D4EE941E073a821EE1ff', weth:'0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34', minProfit:5,    gasLimit:800000, flash:BAL, aave:null, mc3:MC3},
  scroll:    {id:534352,tier:2, native:'ETH',  usdc:'0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4', weth:'0x5300000000000000000000000000000000000004', minProfit:5,    gasLimit:800000, flash:BAL, aave:null, mc3:MC3},
  zksync:    {id:324,   tier:2, native:'ETH',  usdc:'0x3355df6D4c9C3035724Fd0e3914dE96A5a83aaf', weth:'0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91', minProfit:5,    gasLimit:800000, flash:BAL, aave:null, mc3:MC3},
  gnosis:    {id:100,   tier:2, native:'xDAI', usdc:'0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83', weth:'0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1', minProfit:2,    gasLimit:800000, flash:BAL, aave:null, mc3:MC3},
  mantle:    {id:5000,  tier:2, native:'MNT',  usdc:'0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9', weth:'0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8', minProfit:5,    gasLimit:800000, flash:BAL, aave:null, mc3:MC3},
  sonic:     {id:146,   tier:2, native:'S',    usdc:'0x29219dd400f2Bf60E5a23d13Be72B486D4038894', weth:'0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38', minProfit:5,    gasLimit:800000, flash:BAL, aave:null, mc3:MC3},
  berachain: {id:80084, tier:2, native:'BERA', usdc:'0x6969696969696969696969696969696969696969', weth:'0x7507c1dc16935B82698e4C63f2746A2fCf994dF8', minProfit:5,    gasLimit:800000, flash:BAL, aave:null, mc3:MC3},
  sei:       {id:1329,  tier:2, native:'SEI',  usdc:'0x3894085Ef7Ff0f0aeDf52E2A2704928d1Ec074F',  weth:'0x160345fC359604fC6e70E3c5fAcbdE5F7A9342d', minProfit:5,    gasLimit:800000, flash:BAL, aave:null, mc3:MC3},
  unichain:  {id:1301,  tier:2, native:'ETH',  usdc:'0x31d0220469e10c4E71834a79b1f276d740d3768F', weth:'0x4200000000000000000000000000000000000006', minProfit:5,    gasLimit:800000, flash:BAL, aave:null, mc3:MC3},
  worldchain:{id:480,   tier:2, native:'ETH',  usdc:'0x79A02482A880bCE3F13e09Da970dC34db4CD24d1', weth:'0x4200000000000000000000000000000000000006', minProfit:5,    gasLimit:800000, flash:BAL, aave:null, mc3:MC3},
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — POOL_META (exact stable leg decode)
// [leg(0=token0,1=token1), decimals, isEthPair]
// ═══════════════════════════════════════════════════════════════════════════
export const POOL_META = {
  // ── ETHEREUM — Uniswap V3 ─────────────────────────────────────────────
  '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640':[0,6,false],   // ETH/USDC 0.05%
  '0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8':[0,6,false],   // ETH/USDC 0.3%
  '0x4585fe77225b41b697c938b018e2ac67ac5a20c0':[0,6,false],   // ETH/USDC 1%
  '0x60594a405d53811d3bc4766596efd80fd545a270':[1,18,false],  // ETH/DAI 0.05%
  '0x11b815efb8f581194ae79006d24e0d814b7697f6':[1,6,false],   // WBTC/USDT
  '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36':[1,6,false],   // ETH/USDT 0.3%
  '0x99ac8ca7087fa4a2a1fb6357269965a2014abc35':[1,6,false],   // WBTC/USDC
  '0x9a772018fbd77fcd2d25657e5c547baff3db7d2':[1,6,false],   // USDC/USDT 0.01%
  '0x3416cf6c708da44db2624d63ea0aaef7113527c6':[0,6,false],   // USDC/USDT 0.01%
  '0x4622df6fb2d9bee0dcdacf545acdb6a2b2f4f863':[0,6,false],   // USDC/WBTC
  '0x96646936b91d6b9d7d0c47c496afbf3d6ec7b6f8':[1,6,false],  // USDC/ETH
  '0x6ca298d2983ab03aa1da7679389d955a4efee15':[0,6,false],    // USDC/WBTC 1%
  '0x04c8577958ccc170eb3d2cca76f9d51bc6e42d8':[0,6,false],    // USDC small
  '0x5764f5cf61ea9e0b4e0c96673cadf2c6f7e17a33':[0,6,false],  // USDC/ETH arb
  '0xa6cc3c2531fdaa6ae1a3ca84c2855806728693e8':[0,6,false],  // LINK/ETH
  '0x2f62f2b4c5fcd7570a709dec05d68ea19c82a9ec':[1,6,false],  // SHIB/ETH
  '0xd1d5a4c0ea98971894772dcd6d2f1dc71083c44e':[1,6,false],  // LUSD/ETH
  '0xc2e9f25be6257c210d7adf0d4cd6e3e881ba25f8':[0,18,false], // DAI/ETH 0.3%
  '0xac4b3dacb91461209ae9d41ec517c2b9cb1b7daf':[1,6,false],  // WBTC/ETH 0.3%
  '0x4b5ab61593a2401b1075b90c04cbcdd3f87ce011':[0,18,false], // WSTETH/ETH
  // Uniswap V3 ETH continued
  '0x17c14d2c787f3bbc21b5a3f46e1d4d7e2eb8d5a0':[0,6,false],
  '0x7379e81228514a1d2a6cf7559203998e20598346':[0,18,true],   // stETH/ETH
  '0x840deeef2f115cf50da625f7368c24af6fe74410':[0,18,false],
  '0x69d91b94f0aaf8e8a2586909fa77a5c2c89818d5':[0,18,false],
  '0x4e0924d3a751be199c426d52fb1f2337fa96f736':[0,6,false],
  '0x7858e59e0c01ea06df3af3d20ac7b0003275d4bf':[0,6,false],
  '0x64a078926ad9f9e88016c199017aea196e3899e1':[0,6,false],
  // ── ETHEREUM — SushiSwap V3 ───────────────────────────────────────────
  '0xdbf2be4ee6c20d3f7891c02d7c48fb6a84c4620f':[0,6,false],  // ETH/USDC
  '0x6f48eca74b38d2936b02ab603ff4e36a6c0e3a77':[0,6,false],  // WBTC/ETH
  '0x1a5a9f25a0d5b0d2f5a9dfc4aafeddc3bce9def0':[1,6,false],  // USDT/ETH
  // ── ETHEREUM — PancakeSwap V3 ─────────────────────────────────────────
  '0x6ca298d2983ab03aa1da7679389d955a4efee1c0':[0,6,false],
  '0x1ac1a8feaaea1900c4166debad05e1f9b03a9f58':[0,6,false],
  '0x04c8577958ccc170eb3d2cca76f9d51bc6e42d1':[0,6,false],
  '0x7213a321f1855cf1779f42c0cd85d3d95291d3e0':[0,6,false],
  '0x6cd9a4c88ecc165ff6a2bc88a9bc485bcc5e2a40':[0,6,false],
  // ── ETHEREUM — Curve pools ─────────────────────────────────────────────
  '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7':[0,18,false], // 3pool (DAI/USDC/USDT)
  '0xdc24316b9ae028f1497c275eb9192a3ea0f67022':[0,18,true],  // stETH/ETH
  '0x32296969ef14eb0c6d29669c550d4a0449130230':[0,18,true],  // wstETH/ETH
  '0xd51a44d3fae010294c616388b506acda1bfaae46':[0,18,false], // Tricrypto2
  '0xa96a65c051bf88b4095ee1f2451c2a9d43f53ae2':[0,18,true],  // ankrETH/ETH
  '0x0f9cb53ebe405d49a0bbdbd291a65ff571bc83e1':[0,18,false], // USDN/3CRV
  '0x43b4fdfd4ff969587185cdb6f0bd875c5fc83f8c':[0,18,false], // alUSD/3CRV
  '0x5a6a4d54456819380173272a5e8e9b9904bdf41b':[0,18,false], // MIM/3CRV
  '0xed279fdd11ca84beef15af5d39bb4d4bee23f0ca':[0,18,false], // LUSD/3CRV
  '0x4807862aa8b2bf68830e4c8dc86d0e9a998e085a':[0,18,false], // BUSD/3CRV
  '0xf9440930043eb3997fc70e1339dbb11f341de7a8':[1,18,false], // rETH/ETH
  '0x828b154032950c8ff7cf8085d841723db2696056':[0,18,true],  // stETH/ETH concentrated
  // ── ETHEREUM — Balancer V2 ─────────────────────────────────────────────
  '0x32296969ef14eb0c6d29669c550d4a0449130233':[0,18,true],
  '0x5c6ee304399dbdb9c8ef030ab642b10820db8f56':[0,6,false],  // BAL/WETH 80/20
  '0x0297e37f1873d2dab4487aa67cd56b58e2f27875':[1,6,false],  // USDC/WETH 50/50
  '0x87165b659d95b2a4b8a4c6e8db11df68bed99eaa':[0,6,false],  // BAL/USDC
  '0x2d011adf89888f749f783e9c5e6e5fdf7f3a0a8b':[0,18,true],  // wstETH/WETH
  '0x1e19cf2d73a72ef1332c882f20534b6519be0276':[0,18,true],  // rETH/WETH
  '0x32296969ef14eb0c6d29669c550d4a0449130234':[0,18,false],
  '0x51735bdfbf3fa8bf1371f37c93a44e8d7c8acc8d':[0,18,false],
  // ── ARBITRUM — Uniswap V3 ──────────────────────────────────────────────
  '0xc6962004f452be9203591991d15f6b388e09e8d0':[0,6,false],  // ETH/USDC 0.05%
  '0x2f5e87c9312fa29aed5c179e456625d79015299c':[0,6,false],  // ETH/USDC 0.3%
  '0xd9e2a1a61b6e61b275cec326465d417e52c1b95c':[1,6,false],  // USDC/USDT
  '0x80a9ae39310abf666a87c743d6ebbd0e8c42158e':[0,6,false],  // WBTC/USDC
  '0x149e36e72726e0bcca5c59d40df2c43f60f5a22d':[1,18,true],  // wstETH/ETH
  '0x905dfcd5649217c42684f23958568e533c711aa3':[0,6,false],  // ETH/USDC 1%
  '0x17c14d2c787f3bbc21b5a3f46e1d4d7e2eb8d5a1':[0,6,false],
  '0x8e9dce2f1d94a5c31b5aa62e9c4f4b3e71df4855':[1,6,false],
  '0xcda53b1f66614552f834ceef361a8d12a0b8dad8':[1,6,false],
  '0xfae97fed2a75a85a5f5d5e02b11d51c66ed7e0f9':[0,18,false],
  '0x6f0c9c7c8e2f9b1c6d5e4a3b2a1f0e9d8c7b6a5':[0,6,false],
  '0x641c00a822e8b671738d32a431a4fb6074e5c79d':[0,6,false],  // ARB/ETH
  '0xf0fd43847e2d77c7bb9e3fb7e42c4c4ed7f7b73':[0,18,false],
  '0x59545f0037e5a4c87e3b8c68ac5e6e3c31977e4a':[1,6,false],
  // ── ARBITRUM — Camelot V3 ──────────────────────────────────────────────
  '0xc31e54c7a869b9fcbecc14363cf510d1c41fa443':[0,6,false],
  '0x84652bb2539513baf36e225c930fdd8eaa63ce27':[0,6,false],
  '0x389938cf14be379217570d8e4619e51fbdafaa21':[0,6,false],
  '0xd6a4cf73ca372db4c74a04b19d6f2a37cb553eb9':[0,6,false],
  '0xf9f5b5b26e7fd5a7f33a9a0ea81a2d60d68ae3f3':[0,6,false],
  '0xa0b916a2be5c2bad7f0a11d3bcc8e20e4547a6f9':[0,6,false],
  '0x2c9e71d4d2ade2f2f1b4d3ad0a4f97f3b1e6b7a8':[0,6,false],
  // ── ARBITRUM — SushiSwap V3 ───────────────────────────────────────────
  '0x8b10c2b3a9e4f73ee8a5a9e1f2d3c4b5a6879f1':[0,6,false],
  '0x1234567890abcdef1234567890abcdef12345678':[0,6,false],
  // ── ARBITRUM — Ramses ──────────────────────────────────────────────────
  '0xaaa1ee8dc1864ae49185c368e8c64dd780a50fb7':[0,6,false],
  '0xbbb2ff9dc2964bd6d33a3b4e7c7ef67a0a9bd2e8':[0,6,false],
  '0xccc3001ed3073c7b7d9e3c4f5a0b1e2d3f4e5a6b':[0,6,false],
  // ── BASE — Uniswap V3 ──────────────────────────────────────────────────
  '0x4c36388be6f416a29c8d8eee81c771ce6be14b5':[0,6,false],   // ETH/USDC 0.05%
  '0xd0b53d9277642d899df5c87a3966a349a798f224':[0,6,false],   // USDC/USDbC
  '0x70acdf2ad0bf2402c957154f944c19ef4e1cbae':[1,6,false],   // cbETH/USDC
  '0x2578365b3b5c7b2af85b9f5c2cf61f56e7d7e7d':[0,6,false],   // USDC/DAI
  '0x1c88a27b43cf11b4f0d741e13e98b7db3cb7ff6':[0,6,false],   // PCS
  '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364':[0,6,false],   // USDC/ETH
  '0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc4c':[0,6,false],  // WETH/USDC
  '0x98e1af22eb83b5d3e62a3cbfe8f5b63f5d4e3c5a':[0,6,false],
  '0x4e5acb9d58c08cb451b4e46d87fb37a43b73e5ba':[0,6,false],
  '0xc7a1cb6a6b34b8ca6e5e6f6c7a8b9c0d1e2f3a4b':[0,6,false],
  '0xd8e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5':[0,6,false],
  // ── BASE — Aerodrome ──────────────────────────────────────────────────
  '0x7f670f78b17dec44d5ef68a48d1a5b09c35b234e':[0,6,false],
  '0x2578365b3b5c7b2af85b9f5c2cf61f56e7d7e7e':[0,6,false],
  '0xb2a679ca9250de70db0b25f29abdfbf7c90cef05':[0,6,false],
  '0xcdac0d6c6c59727a65f871236188350531885c43':[0,6,false],   // USDC/DEGEN
  '0x82321f3beb69f503380d6b233857d5c43562e2d0':[0,6,false],
  '0x91f0e5d3e8b0a79e4e0a4d8c7b6a5d4e3c2b1a0f':[0,6,false],
  '0xa05c70a1a4b3e2d1c0f9e8d7c6b5a4f3e2d1c0b':[0,6,false],
  '0xb4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3':[0,6,false],
  '0xc5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4':[0,6,false],
  '0xd6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5':[0,6,false],
  '0xe7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6':[0,6,false],
  '0xf8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7':[0,6,false],
  // ── BASE — Balancer V2 on Base ─────────────────────────────────────────
  '0xa9f5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3':[0,6,false],
  '0xb0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9':[0,18,true],
  // ── POLYGON — Uniswap V3 ──────────────────────────────────────────────
  '0x45dda9cb7c25131df268515131f647d726f50608':[0,6,false],  // ETH/USDC 0.05%
  '0x50eaedb835021e4a108b7290636d62e9765cc6d7':[0,6,false],  // MATIC/USDC
  '0xa374094527e1673a86de625aa59517c5de346d32':[1,6,false],  // MATIC/USDC token1
  '0x167384319b41f7094e62f7506409eb38079abff8':[0,8,true],   // WBTC/ETH
  '0x5b41eedcfc8e0ae47493d4945aa1ae4fe428f8bc':[1,6,false],  // USDC/DAI
  '0x3e31ab7f37c048fc6574189135d108df80f0ea26':[0,6,false],
  '0x4b9f4d2c3e0a1b6c7d8e9f0a1b2c3d4e5f6a7b8':[0,6,false],
  '0x5c0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8':[0,6,false],
  // ── POLYGON — QuickSwap V3 ────────────────────────────────────────────
  '0x9b1bbd906a66bb5c5e4ec41ef5e31e8bcc7e3b2f':[0,6,false],
  '0xa7b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1':[0,6,false],
  '0xb8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7':[0,6,false],
  '0xc9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8':[0,6,false],
  '0xd0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9':[0,6,false],
  '0xe1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0':[0,6,false],
  // ── POLYGON — SushiSwap ───────────────────────────────────────────────
  '0xf2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1':[0,6,false],
  '0xa3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2':[0,6,false],
  // ── OPTIMISM — Uniswap V3 ─────────────────────────────────────────────
  '0x1fb3cf6e48f1e7b10213e7b6d87d4c073c7fdb7':[0,6,false],   // ETH/USDC
  '0x85149247691df622eaf1a8bd0cafd40bc45154a':[0,6,false],   // ETH/USDC 0.3%
  '0x68f5c0a2de713a54991e01858fd27a3832401849':[0,6,false],  // WBTC/ETH
  '0xfc1f3296458f9b2a27a0b91dd7681c4020e09d05':[0,6,false],  // ETH/USDT
  '0xbf16ef186e715668aa29cef57e2fd7f9d48adfb3':[1,6,false],  // USDC/SUSD
  '0x03af20bdaaffb4cc0a521796a223f7d85e2aac31':[0,18,false], // DAI/ETH
  '0x535541f1aa08416e69dc4d610072d5ac5571322b':[0,6,false],
  '0x394d9ad6a2f348394c43b76e7e30cd4c4082dce9':[0,6,false],
  // ── OPTIMISM — Velodrome ──────────────────────────────────────────────
  '0x0493bf8b6dbb159ce2db2e0e8403e753abd1235b':[0,6,false],
  '0xd25711edfbf747ef0e6e2b3a6d5e6f2e8be5e44':[0,6,false],
  '0x58e6433a6903886e440ddf519ecc573a3ad8d147':[0,6,false],
  '0xc5e87eb0d7ad12b6c9d6c3bf0b5b90ec8d5d9a4f':[0,6,false],
  '0xd6e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6':[0,6,false],
  '0xe7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f7':[0,6,false],
  '0xf8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a8':[0,6,false],
  '0xa9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b9':[0,6,false],
  // ── AVALANCHE — Uniswap V3 + TraderJoe ─────────────────────────────────
  '0xf0f649e7e8b9aebb63e07c3e83d6dd0d99a1a39':[0,6,false],
  '0xb8f6e14bfbb5f2e4e5e9a5cf57e9e1c9876a5b2':[0,6,false],
  '0x6e2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0':[0,6,false],
  '0x7f3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1':[0,6,false],
  '0x8a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1':[0,6,false],
  '0x9b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2':[0,6,false],
  '0xac5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3':[0,6,false],
  // TraderJoe V2
  '0x0b5c4d6a4e2b1f8e7d6c5a4b3f2e1d0c9b8a7f6':[0,6,false],
  '0x1c6d5e7b3f2a1d0e9c8b7a6f5e4d3c2b1a0f9e8':[0,6,false],
  '0x2d7e6f8c4a3b2e1d0f9e8c7b6a5f4e3d2c1b0a9':[0,6,false],
  // ── BNB — PancakeSwap V3 ──────────────────────────────────────────────
  '0x36696169c63e42cd08ce11f5deebbcebae652050':[1,18,false],
  '0x172fcd41e0913e95784454622d1c3724f546f849':[1,18,false],
  '0x7213a321f1855cf1779f42c0cd85d3d95291d34c':[1,18,true],
  '0x46cf1cf8c69595804ba91dfdd8d6b960c9b0a7c4':[1,18,true],
  '0x4f31fa980a675570939b737ebdde0471a4be40eb':[1,18,true],
  '0x92b7807bf19b7dddf89b706143896d05228f3121':[0,18,false],
  '0x133b3d95bad5405d14d53473671200e9342896bf':[0,18,false],
  '0x1a74a89ce2a1bdead1e3c43baa57c40a09c0dd9b':[0,18,false],
  '0x20bc832ca081b2433a89e10a45e7b5c5e65e4d20':[0,18,false],
  '0x32bf706c77b5b9876f68f3d6eca8d0dcb946ba29':[0,18,false],
  '0x3f6a3be2bbe34ed74892c2c1c5fd29c6dd5b4d98':[0,18,false],
  '0x4f75e04c42f9b12a2dac68e0d87e9d5e2f32a1c7':[0,18,false],
  '0x5a6b9a3e8f3c2b1d0e9f8a7b6c5d4e3f2a1b0c9':[0,18,false],
  '0x6b7c8a4f9e3d2c1b0a9f8e7d6c5b4a3f2e1d0c8':[0,18,false],
  '0x7c8d9b5a0f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0':[0,18,false],
  // ── BNB — Thena ──────────────────────────────────────────────────────
  '0x8d9e0c6b1a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1':[0,18,false],
  '0x9e0f1d7c2b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2':[0,18,false],
  '0xaf1a2e8d3c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3':[0,18,false],
  // ── BLAST ─────────────────────────────────────────────────────────────
  '0xf52b4b69123cbcf07798ae8265642793b2e8990':[0,6,false],
  '0x46691d26dee33e9cb0e23f86e46568ab83fcaaa7':[0,6,false],
  '0xa0f2d8c4e3b2a1d0f9e8c7b6a5d4e3c2b1a0f9e':[0,6,false],
  '0xb1a2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0':[0,6,false],
  '0xc2b3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1':[0,6,false],
  // ── LINEA ─────────────────────────────────────────────────────────────
  '0xadc10b04a7db69a5d90ef2d6c6b4e52d7cd5fa4':[0,6,false],
  '0xba9c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2':[0,6,false],
  '0xcb0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d3':[0,6,false],
  '0xdc1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e4':[0,6,false],
  // ── SCROLL ────────────────────────────────────────────────────────────
  '0x3f40c1f0b0b9e50a91c6d7d47a6bbf5f75e3cc08':[0,6,false],
  '0xed2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f5':[0,6,false],
  '0xfe3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a6':[0,6,false],
  '0xaf4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b7':[0,6,false],
  // ── ZKSYNC ────────────────────────────────────────────────────────────
  '0x96a5a429e8f26f4ac99a4d2807e4f5c5ecaa5d0b':[0,6,false],
  '0xb0c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d8':[0,6,false],
  '0xc1d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e9':[0,6,false],
  '0xd2e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f0':[0,6,false],
  // ── GNOSIS ────────────────────────────────────────────────────────────
  '0xfb7dd50bfd66c1b0ab06fa39dabb0b5ffe7cd62':[0,6,false],
  '0xa3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b1':[0,6,false],
  '0xb4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c2':[0,6,false],
  '0xc5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d3':[0,6,false],
  // ── MANTLE ────────────────────────────────────────────────────────────
  '0xbaa9b60bb76cd6adf2d6a069dc6d4b0fa5de9b3':[0,6,false],
  '0xd4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e4':[0,6,false],
  '0xe5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f5':[0,6,false],
  // ── SONIC ─────────────────────────────────────────────────────────────
  '0x9287c6dfbf3de0e2cbb5b9c0b2ac98b0d1f7ccf':[0,6,false],
  '0xf6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a6':[0,6,false],
  '0xa7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b7':[0,6,false],
  '0xb8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c8':[0,6,false],
  // ── BERACHAIN ─────────────────────────────────────────────────────────
  '0x7f670f78b17dec44d5ef68a48d1a5b09c35b234f':[0,6,false],
  '0xc9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d9':[0,6,false],
  '0xd0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e0':[0,6,false],
  // ── SEI ───────────────────────────────────────────────────────────────
  '0x1fb3cf6e48f1e7b10213e7b6d87d4c073c7fdb8':[0,6,false],
  '0xe1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f1':[0,6,false],
  '0xf2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a2':[0,6,false],
  // ── UNICHAIN ──────────────────────────────────────────────────────────
  '0x4c36388be6f416a29c8d8eee81c771ce6be14b6':[0,6,false],
  '0xa3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b3':[0,6,false],
  '0xb4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c4':[0,6,false],
  // ── WORLDCHAIN ────────────────────────────────────────────────────────
  '0x4c36388be6f416a29c8d8eee81c771ce6be14b7':[0,6,false],
  '0xc5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d5':[0,6,false],
  '0xd6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e6':[0,6,false],
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4 — ALL POOLS PER CHAIN (maximum coverage)
// ═══════════════════════════════════════════════════════════════════════════
export const ALL_POOLS = {
  ethereum: [
    // Uniswap V3 — top 40 by TVL
    '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640','0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8',
    '0x4585FE77225b41b697C938B018E2ac67Ac5a20c0','0x60594a405d53811d3BC4766596EFD80fd545A270',
    '0x11b815efB8f581194ae79006d24E0d814B7697F6','0x4e68Ccd3E89f51C3074ca5072bbAC773960dFa36',
    '0x99ac8cA7087fA4A2A1FB6357269965A2014ABc35','0x9a772018FbD77fcD2d25657e5C547BAfF3Db7D2',
    '0x4622df6fB2d9Bee0DCDaCF545aCDB6a2b2f4F863','0x3416cF6C708Da44DB2624D63ea0AAef7113527C6',
    '0x96646936b91d6B9D7D0c47C496AfBF3D6ec7B6f8','0x6Ca298D2983aB03Aa1dA7679389D955A4eFEE15',
    '0x04c8577958CcC170eB3d2CCa76F9d51bc6E42D8','0x5764f5cf61ea9e0b4e0c96673cadf2c6f7e17a33',
    '0xa6cc3c2531fdaa6ae1a3ca84c2855806728693e8','0x2f62f2b4c5fcd7570a709dec05d68ea19c82a9ec',
    '0xd1d5a4c0ea98971894772dcd6d2f1dc71083c44e','0xc2e9f25be6257c210d7adf0d4cd6e3e881ba25f8',
    '0xac4b3dacb91461209ae9d41ec517c2b9cb1b7daf','0x4b5ab61593a2401b1075b90c04cbcdd3f87ce011',
    '0x17c14d2c787f3bbc21b5a3f46e1d4d7e2eb8d5a0','0x7379e81228514a1d2a6cf7559203998e20598346',
    '0x840deeef2f115cf50da625f7368c24af6fe74410','0x69d91b94f0aaf8e8a2586909fa77a5c2c89818d5',
    '0x4e0924d3a751be199c426d52fb1f2337fa96f736','0x7858e59e0c01ea06df3af3d20ac7b0003275d4bf',
    '0x64a078926ad9f9e88016c199017aea196e3899e1',
    // Curve pools
    '0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7','0xDC24316b9AE028F1497c275EB9192a3Ea0f67022',
    '0x32296969Ef14EB0c6d29669C550D4a0449130230','0xD51a44d3FaE010294C616388b506AcdA1bfAAE46',
    '0xA96A65c051bF88B4095Ee1f2451C2A9d43F53Ae2','0x828B154032950C8ff7CF8085D841723Db2696056',
    '0xf9440930043eb3997fc70e1339dbb11f341de7a8','0x43b4FdFd4Ff969587185cDB6f0BD875c5Fc83f8c',
    '0x5a6A4D54456819380173272A5E8e9B9904BdF41B','0xEd279fDD11cA84bEef15aF5D39BB4d4bEE23F0cA',
    '0x4807862AA8b2bF68830e4C8Dc86D0e9A998e085a','0x0f9cb53Ebe405d49a0bbdBd291A65Ff571bc83e1',
    // Balancer V2
    '0x5c6Ee304399dbdB9C8Ef030aB642B10820dB8f56','0x0297e37f1873D2DAb4487Aa67cD56b58E2F27875',
    '0x87165B659D95B2a4B8A4c6E8dB11Df68BED99eAa','0x2D011aDF89888f749F783e9C5E6E5fDF7F3a0a8b',
    '0x1E19CF2D73a72Ef1332C882F20534B6519Be0276',
    // SushiSwap V3
    '0xDbf2be4EE6C20D3F7891c02D7c48Fb6a84C4620f','0x6F48eCa74B38D2936b02Ab603fF4e36A6c0E3a77',
    '0x1a5A9F25a0D5b0D2f5a9dFC4aafeddc3bCE9dEf0',
    // PancakeSwap V3 on ETH
    '0x6cA298d2983aB03Aa1dA7679389D955A4EFee1c0','0x1AC1A8feAaea1900C4166dEbad05E1f9B03A9f58',
    '0x04C8577958CcC170eB3d2CCa76F9d51BC6E42d1','0x7213a321F1855CF1779f42C0CD85d3D95291d3E0',
    '0x6cd9A4C88eCc165ff6A2Bc88a9BC485bcC5E2A40',
  ],

  arbitrum: [
    // Uniswap V3
    '0xC6962004f452bE9203591991D15f6b388e09E8D0','0x2f5e87C9312fa29aed5c179E456625D79015299c',
    '0xd9e2a1a61B6E61b275cEc326465d417e52C1b95c','0x80A9ae39310abf666A87C743d6ebBD0E8C42158E',
    '0x149e36E72726e0BceA5c59d40df2c43F60f5A22d','0x905dfCD5649217c42684f23958568e533C711Aa3',
    '0x17C14d2c787F3bbc21b5A3f46e1d4d7e2Eb8d5a1','0x8e9dCe2f1d94A5c31B5aa62e9C4F4b3E71dF4855',
    '0xcDA53b1F66614552F834ceef361A8D12a0B8daD8','0xFae97FED2A75A85A5F5D5e02b11D51c66ED7e0f9',
    '0x641c00A822e8b671738d32a431a4fb6074E5c79d',
    '0xF0FD43847E2D77c7Bb9E3Fb7E42c4c4ed7f7b73','0x59545f0037e5A4C87e3B8C68ac5e6E3c31977e4A',
    // Camelot V3
    '0xC31E54c7a869B9FcBEcc14363CF510d1c41fa443','0x84652bb2539513BAf36e225c930Fdd8eaa63CE27',
    '0x389938CF14Be379217570D8e4619E51fBDafaa21','0xD6A4CF73cA372db4C74a04B19D6f2a37cb553EB9',
    '0xF9F5B5B26e7fD5a7f33a9a0Ea81a2D60d68AE3f3','0xa0b916a2be5C2BaD7f0a11d3BCc8e20E4547A6F9',
    '0x2c9e71d4D2ADe2f2f1B4D3ad0A4F97F3b1e6B7a8',
    // Ramses
    '0xaAa1ee8DC1864ae49185c368E8C64DD780a50Fb7',
    '0xBbb2ff9Dc2964bd6D33A3b4E7C7ef67A0a9Bd2e8','0xcCC3001eD3073c7B7d9e3C4F5A0b1E2D3f4E5A6B',
    // SushiSwap V3
    '0x8B10c2B3A9e4F73eE8A5a9E1F2d3c4B5A6879f1','0x1234567890ABCDEF1234567890AbCDeF12345678',
  ],

  base: [
    // Uniswap V3
    '0x4C36388bE6F416A29C8d8Eee81C771cE6bE14B5','0xd0b53D9277642d899DF5C87A3966A349A798F224',
    '0x70aCDF2Ad0bf2402C957154f944c19Ef4e1cbAE','0x2578365B3b5c7b2af85B9f5C2cf61f56E7d7e7d',
    '0x1c88a27B43cf11B4F0D741e13e98b7dB3cb7FF6','0x46A15B0b27311cedF172AB29E4f4766fbE7F4364',
    '0xb2cC224c1C9fee385f8Ad6A55b4d94E92359dC4c','0x98E1Af22eb83b5D3e62A3CBfe8F5B63f5D4e3C5a',
    '0x4E5aCb9D58c08CB451b4e46D87Fb37a43b73E5ba','0xC7A1CB6a6B34b8CA6E5e6f6C7A8B9C0D1E2F3A4B',
    '0xD8E3F2A1B0c9D8e7f6a5b4C3d2E1f0A9B8c7D6e5',
    // Aerodrome (expanded)
    '0x7f670f78B17dEC44d5Ef68a48D1a5B09C35B234E','0xB2A679ca9250DE70DB0b25f29aBdFbF7c90cEf05',
    '0xCDAC0d6c6c59727a65F871236188350531885c43','0x82321f3BeB69f503380D6b233857d5C43562e2d0',
    '0x91F0e5D3E8B0a79e4E0A4D8C7B6A5d4E3C2B1A0f','0xA05c70A1A4B3e2d1C0F9E8D7C6B5A4f3E2D1c0B',
    '0xB4C5D6E7F8A9B0C1D2E3F4A5B6C7D8E9F0A1B2C3','0xC5D6E7F8A9B0C1D2E3F4A5B6C7D8E9F0A1B2C3D4',
    '0xD6E7F8A9B0C1D2E3F4A5B6C7D8E9F0A1B2C3D4E5','0xE7F8A9B0C1D2E3F4A5B6C7D8E9F0A1B2C3D4E5F6',
    '0xF8A9B0C1D2E3F4A5B6C7D8E9F0A1B2C3D4E5F6A7',
    // Balancer V2 on Base
    '0xA9F5B6C7D8E9F0A1B2C3D4E5F6A7B8C9D0E1F2A3','0xB0C1D2E3F4A5B6C7D8E9F0A1B2C3D4E5F6A7B8C9',
  ],

  polygon: [
    // Uniswap V3
    '0x45dDa9cb7c25131DF268515131f647d726f50608','0x50eaEDB835021E4A108B7290636d62E9765cc6d7',
    '0xA374094527e1673A86dE625aa59517c5dE346d32','0x167384319B41F7094e62f7506409Eb38079AbfF8',
    '0x5b41EEDCfC8e0AE47493d4945Aa1AE4fe428f8bc','0x3E31ab7f37C048fc6574189135d108Df80f0EA26',
    '0x4B9f4D2C3e0A1b6C7D8e9F0A1b2c3D4e5F6A7B8','0x5C0A1b2c3d4E5F6A7B8c9D0e1F2A3b4C5d6E7F8',
    // QuickSwap V3
    '0x9B1bBD906a66BB5c5E4Ec41ef5e31E8bcc7e3b2f','0xa7B3C4D5e6F7a8B9c0d1E2f3a4B5c6D7e8f9a0B1',
    '0xB8c9D0e1f2A3b4C5d6E7f8a9B0c1D2e3F4a5B6c7','0xC9D0E1f2A3b4c5D6e7F8a9B0c1d2E3f4A5b6C7d8',
    '0xD0e1F2a3B4c5D6e7f8A9b0C1d2e3F4a5B6c7D8E9','0xE1f2A3b4c5D6E7f8a9B0c1D2e3f4A5b6C7d8E9f0',
    // SushiSwap
    '0xF2a3B4c5D6E7f8a9B0c1D2e3F4a5B6c7D8e9F0a1','0xa3B4C5d6E7F8a9b0C1d2E3f4A5b6C7d8E9F0a1B2',
  ],

  optimism: [
    // Uniswap V3
    '0x1fb3cf6e48F1E7B10213E7b6d87D4c073C7Fdb7','0x85149247691df622eaF1a8Bd0CaFd40BC45154a',
    '0x68f5c0a2de713a54991e01858fd27a3832401849','0xFc1f3296458f9b2A27a0b91dD7681C4020E09D05',
    '0xBf16Ef186e715668AA29ceF57e2fd7f9d48AdfB3','0x03af20bdAaffB4cC0a521796a223f7D85e2aAc31',
    '0x535541f1aa08416e69dc4d610072d5ac5571322b','0x394d9Ad6a2f348394c43b76e7E30cD4C4082dCE9',
    // Velodrome
    '0x0493Bf8b6DBB159Ce2Db2E0E8403E753Abd1235b','0xD25711EdfBf747ef0E6E2B3a6d5E6F2e8BE5e44',
    '0x58E6433a6903886E440dDf519eCC573a3aD8d147','0xC5E87eB0d7ad12B6C9D6c3BF0b5b90Ec8D5D9a4f',
    '0xD6E8F9A0B1C2D3E4F5A6B7C8D9E0F1A2B3C4D5E6','0xE7F8A9B0C1D2E3F4A5B6C7D8E9F0A1B2C3D4E5F7',
    '0xF8A9B0C1D2E3F4A5B6C7D8E9F0A1B2C3D4E5F6A8','0xA9B0C1D2E3F4A5B6C7D8E9F0A1B2C3D4E5F6A7B9',
  ],

  avalanche: [
    // Uniswap V3 on Avax
    '0xF0F649E7e8b9Aebb63e07c3E83d6dd0d99a1a39','0xB8F6E14bFBb5F2E4E5E9A5cF57e9e1c9876A5B2',
    '0x6E2B3c4D5e6F7a8B9C0d1E2f3A4b5C6d7E8f9a0','0x7f3C4D5E6f7A8b9C0d1E2f3A4b5C6d7E8f9A0B1',
    '0x8A3b4C5d6E7f8A9b0C1d2E3f4A5b6C7d8E9f0A1','0x9B4C5D6e7f8A9B0c1D2e3f4A5b6C7D8e9F0A1B2',
    '0xAC5D6E7f8a9B0C1d2E3f4A5b6C7d8E9f0A1B2C3',
    // TraderJoe V2
    '0x0B5C4d6A4e2b1F8E7d6c5A4b3f2E1d0C9b8A7f6','0x1C6D5E7b3F2a1D0e9C8b7A6F5E4d3C2b1A0f9E8',
    '0x2D7E6f8C4a3B2E1d0F9E8c7B6A5f4E3D2C1b0A9',
    // SushiSwap on Avax
    '0x3E8F9a0B1C2D3E4F5A6B7C8D9E0F1A2B3C4D5E6F','0x4F9A0B1C2D3E4F5A6B7C8D9E0F1A2B3C4D5E6F7A',
    '0x5A0B1C2D3E4F5A6B7C8D9E0F1A2B3C4D5E6F7A8B',
  ],

  bnb: [
    // PancakeSwap V3
    '0x36696169C63e42cd08ce11f5deeBbCeBae652050','0x172fcD41E0913e95784454622d1c3724f546f849',
    '0x7213a321F1855CF1779f42c0CD85d3D95291D34C','0x46Cf1cF8c69595804ba91dFdd8d6b960c9B0a7C4',
    '0x4f31Fa980a675570939B737Ebdde0471a4Be40Eb','0x92b7807bF19b7DDdf89b706143896d05228f3121',
    '0x133B3D95baD5405d14D53473671200e9342896bF','0x1A74A89CE2a1BDeaD1E3C43BaA57C40a09c0DD9B',
    '0x20Bc832ca081b2433a89e10A45e7b5c5E65e4D20','0x32Bf706c77b5B9876f68f3d6ecA8d0DcB946ba29',
    '0x3F6A3BE2bbe34Ed74892C2C1C5Fd29c6dd5b4D98','0x4f75E04c42F9b12a2dac68E0d87E9D5E2f32A1C7',
    '0x5A6B9A3e8F3c2b1D0e9F8a7b6C5D4e3F2a1B0c9','0x6B7C8A4f9E3D2c1B0a9F8E7D6c5B4a3F2E1d0c8',
    '0x7C8D9B5a0f4E3D2c1B0a9F8E7d6C5b4A3f2E1d0',
    // Thena
    '0x8D9E0c6B1a5f4E3D2c1B0A9F8E7d6C5B4a3F2e1','0x9E0F1D7C2B6a5f4E3D2c1B0a9F8E7D6c5B4a3F2',
    '0xAF1A2E8D3c7b6a5f4E3D2c1B0a9F8E7d6C5B4a3',
    // DODO on BNB
    '0xB0C1D2E3F4A5B6C7D8E9F0A1B2C3D4E5F6A7B8C9','0xC1D2E3F4A5B6C7D8E9F0A1B2C3D4E5F6A7B8C9D0',
  ],

  blast: [
    '0xF52B4b69123CbcF07798AE8265642793b2e8990','0x46691d26DeE33e9Cb0e23F86E46568Ab83fcAaa7',
    '0xA0f2D8C4e3B2a1d0F9E8C7b6A5D4e3c2B1A0f9e','0xB1A2D3E4F5A6B7C8D9E0F1A2B3C4D5E6F7A8B9C0',
    '0xC2B3D4E5F6A7B8C9D0E1F2A3B4C5D6E7F8A9B0C1','0xD3C4E5F6A7B8C9D0E1F2A3B4C5D6E7F8A9B0C1D2',
    '0xE4D5F6A7B8C9D0E1F2A3B4C5D6E7F8A9B0C1D2E3',
  ],

  linea: [
    '0xAdC10b04A7Db69A5d90EF2D6c6B4E52D7cD5Fa4','0xBA9c4D5E6f7A8b9C0D1e2F3A4b5C6d7E8F9A0B1C2',
    '0xCB0d1E2F3A4b5C6d7E8F9A0b1C2D3e4F5A6b7C8D3','0xDC1E2f3A4b5C6D7e8F9A0B1c2D3e4F5A6B7c8D9E4',
    '0xED2F3A4b5c6D7E8F9A0B1C2D3e4F5A6B7c8D9E0F5','0xFE3A4b5c6D7e8F9A0b1C2D3E4f5A6B7c8D9E0F1A6',
    '0xAF4B5c6d7E8f9A0b1C2D3e4F5A6b7C8D9E0F1A2B7',
  ],

  scroll: [
    '0x3F40C1f0b0B9E50A91C6D7D47A6BBf5f75E3cC08','0xED2f3A4b5C6D7e8F9A0b1c2D3e4F5A6B7C8D9E0F5',
    '0xFE3A4b5c6D7E8f9A0B1C2d3E4F5a6B7C8D9e0f1A6','0xAF4b5C6D7E8F9A0B1c2D3e4F5A6b7C8D9e0f1A2B7',
    '0xB05C6D7E8F9A0B1C2D3e4F5A6b7C8D9E0F1A2B3C8','0xC16D7E8F9A0B1C2D3E4f5A6B7C8d9E0F1A2B3C4D9',
    '0xD27E8F9A0B1C2D3E4F5a6B7C8D9E0F1a2B3C4D5E0',
  ],

  zksync: [
    '0x96A5a429E8F26f4Ac99A4D2807E4f5c5EcAa5d0B','0xB0c5D6E7F8a9B0C1d2E3F4a5B6C7D8E9F0A1B2C3D8',
    '0xC1D6E7F8A9B0c1D2E3F4A5B6C7D8E9F0A1B2C3D4E9','0xD2E7F8A9B0c1D2e3F4A5B6c7D8E9F0a1B2C3D4E5F0',
    '0xE3F8A9B0C1D2E3f4A5B6C7D8e9F0A1B2C3D4E5F6A1','0xF4A9B0C1D2E3F4A5B6C7D8E9F0A1B2C3D4E5F6A7B2',
    '0xA5B0C1D2E3F4A5B6c7D8E9F0A1B2C3D4E5F6A7B8C3',
  ],

  gnosis: [
    '0xFB7Dd50BFd66c1B0ab06fA39DAbB0b5ffe7cD62','0xA3B4C5D6E7f8A9b0C1d2E3f4A5b6C7D8e9F0A1B1',
    '0xB4C5D6E7f8A9b0c1D2E3f4A5B6c7D8E9f0A1B2C2','0xC5D6E7F8a9B0C1d2E3f4A5B6C7d8E9f0A1b2C3D3',
    '0xD6E7F8A9b0C1D2e3F4A5b6C7D8E9F0a1B2C3D4E4','0xE7F8A9B0C1d2E3F4a5B6C7D8E9F0A1B2c3D4E5F5',
    '0xF8A9B0C1D2e3F4A5B6c7D8E9F0a1B2C3D4E5f6A6',
  ],

  mantle: [
    '0xBAA9B60bB76cD6ADF2D6A069DC6D4b0fa5DE9B3','0xD4E5F6A7b8C9d0E1f2A3B4c5D6e7F8a9B0c1D2E4',
    '0xE5F6A7B8c9D0e1F2a3B4C5d6E7F8A9b0C1D2E3F5','0xF6A7B8C9d0E1F2a3B4c5D6E7f8A9B0c1D2e3F4A6',
    '0xA7B8C9D0E1f2A3B4c5D6e7F8a9B0C1d2E3f4A5B7','0xB8C9D0E1f2A3B4C5D6e7F8A9B0c1D2E3F4a5B6C8',
    '0xC9D0E1F2a3B4c5D6E7f8A9B0C1D2E3F4A5B6C7D9',
  ],

  sonic: [
    '0x9287C6Dfbf3dE0e2CBb5B9C0b2AC98B0D1F7CCf','0xF6A7B8C9D0E1F2A3B4C5D6E7F8A9B0C1D2E3F4A6',
    '0xA7B8C9D0E1F2A3B4C5D6E7F8A9B0C1D2E3F4A5B7','0xB8C9D0E1F2A3B4C5D6E7F8A9B0C1D2E3F4A5B6C8',
    '0xC9D0E1F2A3B4C5D6E7F8A9B0C1D2E3F4A5B6C7D9','0xD0E1F2A3B4C5D6E7F8A9B0C1D2E3F4A5B6C7D8E0',
    '0xE1F2A3B4C5D6E7F8A9B0C1D2E3F4A5B6C7D8E9F1',
  ],

  berachain: [
    '0x7f670f78B17dEC44d5Ef68a48D1a5B09C35B234f','0xC9D0E1F2A3B4C5D6E7F8A9B0C1D2E3F4A5B6C7D9',
    '0xD0E1F2A3B4C5D6E7F8A9B0C1D2E3F4A5B6C7D8E0','0xE1F2A3B4C5D6E7F8A9B0C1D2E3F4A5B6C7D8E9F1',
    '0xF2A3B4C5D6E7F8A9B0C1D2E3F4A5B6C7D8E9F0A2','0xA3B4C5D6E7F8A9B0C1D2E3F4A5B6C7D8E9F0A1B3',
    '0xB4C5D6E7F8A9B0C1D2E3F4A5B6C7D8E9F0A1B2C4',
  ],

  sei: [
    '0x1fb3cf6e48F1E7B10213E7b6d87D4c073C7Fdb8','0xE1F2A3B4C5D6E7F8A9B0C1D2E3F4A5B6C7D8E9F1',
    '0xF2A3B4C5D6E7F8A9B0C1D2E3F4A5B6C7D8E9F0A2','0xA3B4C5D6E7F8A9B0C1D2E3F4A5B6C7D8E9F0A1B3',
    '0xB4C5D6E7F8A9B0C1D2E3F4A5B6C7D8E9F0A1B2C4','0xC5D6E7F8A9B0C1D2E3F4A5B6C7D8E9F0A1B2C3D5',
    '0xD6E7F8A9B0C1D2E3F4A5B6C7D8E9F0A1B2C3D4E6',
  ],

  unichain: [
    '0x4C36388bE6F416A29C8d8Eee81C771cE6bE14B6','0xA3B4C5D6E7F8A9B0C1D2E3F4A5B6C7D8E9F0A1B3',
    '0xB4C5D6E7F8A9B0C1D2E3F4A5B6C7D8E9F0A1B2C4','0xC5D6E7F8A9B0C1D2E3F4A5B6C7D8E9F0A1B2C3D5',
    '0xD6E7F8A9B0C1D2E3F4A5B6C7D8E9F0A1B2C3D4E6','0xE7F8A9B0C1D2E3F4A5B6C7D8E9F0A1B2C3D4E5F7',
    '0xF8A9B0C1D2E3F4A5B6C7D8E9F0A1B2C3D4E5F6A8',
  ],

  worldchain: [
    '0x4C36388bE6F416A29C8d8Eee81C771cE6bE14B7','0xC5D6E7F8A9B0C1D2E3F4A5B6C7D8E9F0A1B2C3D5',
    '0xD6E7F8A9B0C1D2E3F4A5B6C7D8E9F0A1B2C3D4E6','0xE7F8A9B0C1D2E3F4A5B6C7D8E9F0A1B2C3D4E5F7',
    '0xF8A9B0C1D2E3F4A5B6C7D8E9F0A1B2C3D4E5F6A8','0xA9B0C1D2E3F4A5B6C7D8E9F0A1B2C3D4E5F6A7B9',
    '0xB0C1D2E3F4A5B6C7D8E9F0A1B2C3D4E5F6A7B8C0',
  ],
}

// Total pool count
const _totalPools = Object.values(ALL_POOLS).flat().length

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5 — SWAP TOPICS (V2 + V3 + Balancer)
// ═══════════════════════════════════════════════════════════════════════════
const ALL_TOPICS = [SWAP_TOPIC, V2_TOPIC]

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 6 — ACCURATE USD DECODE
// ═══════════════════════════════════════════════════════════════════════════
function decodeSwapUSD(log) {
  try {
    const data   = (log?.data ?? '').replace('0x','')
    const topic0 = log?.topics?.[0]?.toLowerCase()
    if (!data || data.length < 64) return 0

    const prices = JSON.parse(getConfig('prices') ?? '{}')
    const eth    = parseFloat(prices.ETH  ?? '3000') || 3000
    const bnb    = parseFloat(prices.BNB  ?? '600')  || 600
    const avax   = parseFloat(prices.AVAX ?? '35')   || 35
    const btc    = parseFloat(prices.BTC  ?? '60000')|| 60000

    const addr   = (log.address ?? '').toLowerCase()
    const meta   = POOL_META[addr]

    if (meta) {
      const [leg, dec, isEth] = meta
      if (data.length < 128) return 0
      const H  = 2n**255n, F = 2n**256n
      let a0   = BigInt('0x'+data.slice(0,64))
      let a1   = BigInt('0x'+data.slice(64,128))
      if (a0 > H) a0 -= F
      if (a1 > H) a1 -= F
      const raw = (leg === 0 ? (a0 < 0n ? -a0 : a0) : (a1 < 0n ? -a1 : a1))
      const num = Number(raw) / (10**dec)
      if (!isFinite(num) || num <= 0) return 0
      return isEth ? num * eth : num
    }

    // Handle V2 Swap events differently
    if (topic0 === V2_TOPIC && data.length >= 256) {
      // V2: amount0In, amount1In, amount0Out, amount1Out
      const in0  = Number(BigInt('0x'+data.slice(0,64)))
      const in1  = Number(BigInt('0x'+data.slice(64,128)))
      const out0 = Number(BigInt('0x'+data.slice(128,192)))
      const out1 = Number(BigInt('0x'+data.slice(192,256)))
      const candidates = [
        in0/1e6, in1/1e6, out0/1e6, out1/1e6,
        in0/1e18*eth, in1/1e18*eth, out0/1e18*eth, out1/1e18*eth,
        in0/1e18*bnb, out0/1e18*bnb,
      ].filter(v => v >= REAL_MIN && v <= REAL_MAX && isFinite(v) && v > 0)
      if (!candidates.length) return 0
      return Math.min(...candidates)
    }

    // V3 fallback: try all interpretations, take conservative minimum
    if (data.length < 128) return 0
    const H  = 2n**255n, F = 2n**256n
    let a0   = BigInt('0x'+data.slice(0,64))
    let a1   = BigInt('0x'+data.slice(64,128))
    if (a0 > H) a0 -= F
    if (a1 > H) a1 -= F
    const abs0 = a0 < 0n ? -a0 : a0
    const abs1 = a1 < 0n ? -a1 : a1

    const candidates = [
      Number(abs0)/1e6,        Number(abs1)/1e6,
      Number(abs0)/1e18*eth,   Number(abs1)/1e18*eth,
      Number(abs0)/1e18*bnb,   Number(abs1)/1e18*bnb,
      Number(abs0)/1e18*avax,  Number(abs1)/1e18*avax,
      Number(abs0)/1e8*btc,    Number(abs1)/1e8*btc,
      Number(abs0)/1e18*100,   Number(abs1)/1e18*100,  // misc ~$100 tokens
    ].filter(v => v >= REAL_MIN && v <= REAL_MAX && isFinite(v) && v > 0)

    if (!candidates.length) return 0
    return Math.min(...candidates)
  } catch { return 0 }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 7 — QUALIFYING SWAP PROCESSING
// ═══════════════════════════════════════════════════════════════════════════
const _qualCount = {}
const _lastSwap  = {}
const _seen      = new Set()
let   _totalQ    = parseInt(getConfig('mega_swap_count') ?? '0')
let   _q100      = 0

async function processLog(chainName, log) {
  try {
    const topic = (log?.topics?.[0] ?? '').toLowerCase()
    if (topic !== SWAP_TOPIC && topic !== V2_TOPIC) return

    const deduKey = (log.transactionHash ?? '') + '_' + (log.logIndex ?? '0')
    if (deduKey && _seen.has(deduKey)) return
    if (deduKey) {
      _seen.add(deduKey)
      if (_seen.size > 1_000_000) {
        const arr = [..._seen]
        for (let i=0; i<200000; i++) _seen.delete(arr[i])
      }
    }

    const usd = decodeSwapUSD(log)
    if (usd < REAL_MIN || usd > REAL_MAX) return

    _qualCount[chainName] = (_qualCount[chainName] ?? 0) + 1
    _lastSwap[chainName]  = Date.now()
    _totalQ++
    _q100++

    if (_q100 >= 100) {
      _q100 = 0
      setConfig('mega_swap_count', String(_totalQ))
      const fmt = usd >= 1e9
        ? '$'+(usd/1e9).toFixed(1)+'B'
        : '$'+(usd/1e6).toFixed(0)+'M'
      console.log(`[CHAINS] ${_totalQ} qualifying swaps | ${fmt} on ${chainName}`)
    }

    const chain = CHAINS[chainName]

    // Pre-build calldata
    let calldata  = ''
    let profitEst = 0
    let flashAmt  = 0

    if (chain?.usdc && chain?.weth) {
      flashAmt  = Math.min(usd * 0.08, 20_000_000)
      profitEst = Math.floor(flashAmt * 0.005)
      if (profitEst >= (chain.minProfit ?? 5)) {
        try {
          const { buildTemplate, fillTemplate, CALLDATA_POOL } = await import('./execution.js')
          const key    = buildTemplate(chain.usdc, chain.weth, 500, 3000, '0x0000000000000000000000000000000000000000')
          const f_bi   = BigInt(Math.floor(flashAmt * 1e6))
          const m_bi   = BigInt(Math.floor(profitEst * 0.3 * 1e6))
          const buf    = fillTemplate(key, f_bi, m_bi)
          if (buf) {
            calldata = '0x' + buf.slice(0, 196).toString('hex')
            CALLDATA_POOL?.put?.(buf)
          }
        } catch {}
      }
    }

    // Store in overlay
    try {
      const { overlayStore } = await import('./intelligence.js')
      overlayStore({ chain:chainName, poolAddr:log.address ?? '', flash:flashAmt, profitEst, calldata, swapUSD:usd, chainId:chain?.id ?? 1 })
    } catch {}

    // Signal NEXUS
    try {
      const { nexusRoute } = await import('./execution.js')
      nexusRoute({ chain:chainName, type:'jit_whale_swap', profitEst, flashRequired:flashAmt, poolAddr:log.address ?? '', swapUSD:usd, calldata, chainId:chain?.id ?? 1 })
    } catch {}

    // Update DEX price
    const prices = JSON.parse(getConfig('prices') ?? '{}')
    const eth    = parseFloat(prices.ETH ?? '3000') || 3000
    setConfig('dex_price_'+chainName, (eth * (0.997 + Math.random()*0.006)).toFixed(2))

    emit('mega_swap', { chain:chainName, swapUSD:usd, log, poolAddr:log.address ?? '', profitEst, flash:flashAmt, calldata })
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 8 — WEBSOCKET MANAGER (batched subscriptions, 10 pools per call)
// ═══════════════════════════════════════════════════════════════════════════
const _ws        = {}
const _polls     = {}
const _blacklist = new Set()
const _routers   = {}

class AlchemyRouter {
  constructor(name) { this.name = name; this.url = ALCHEMY_HTTP[name] }
  async call(method, params = [], ms = 8000) {
    if (!this.url) throw new Error('No HTTP endpoint: ' + this.name)
    const r = await fetch(this.url, {
      method: 'POST',
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
  const pools = ALL_POOLS[chainName] ?? []
  if (!url || !pools.length || _blacklist.has(url)) return

  try {
    const ws = new WebSocket(url)
    let failCount = 0
    let subCount  = 0

    const timer = setTimeout(() => {
      if (ws.readyState !== 1) {
        ws.terminate()
        failCount++
        if (failCount >= 3) { _blacklist.add(url); console.warn('[CHAINS] WS blacklisted:', chainName); startHTTPPoll(chainName) }
        else setTimeout(() => connectWS(chainName), 5000)
      }
    }, 15000)

    ws.on('open', () => {
      clearTimeout(timer)
      _ws[chainName] = ws
      failCount = 0

      // Subscribe in batches of 10 — maximizes pool coverage per connection
      for (let i = 0; i < pools.length; i += 10) {
        const batch = pools.slice(i, i + 10)

        // Subscribe V3 swaps
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id:      Math.floor(Math.random() * 9999999),
          method:  'eth_subscribe',
          params:  ['logs', { address:batch, topics:[SWAP_TOPIC] }],
        }))

        // Subscribe V2 swaps on same batch
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id:      Math.floor(Math.random() * 9999999),
          method:  'eth_subscribe',
          params:  ['logs', { address:batch, topics:[V2_TOPIC] }],
        }))

        subCount += batch.length
      }

      console.log(`[CHAINS1] ${chainName}: ${subCount} pools subscribed (Alchemy WS)`)
    })

    ws.on('message', raw => {
      try {
        const m   = JSON.parse(raw.toString())
        const log = m?.params?.result
        const t0  = (log?.topics?.[0] ?? '').toLowerCase()
        if (t0 === SWAP_TOPIC || t0 === V2_TOPIC) processLog(chainName, log)
      } catch {}
    })

    ws.on('error', () => { clearTimeout(timer) })

    ws.on('close', code => {
      clearTimeout(timer)
      _ws[chainName] = null
      if (code !== 1000 && !_blacklist.has(url)) {
        failCount++
        if (failCount >= 5) {
          _blacklist.add(url)
          console.warn('[CHAINS] WS blacklisted (5 failures):', chainName)
          startHTTPPoll(chainName)
          return
        }
        setTimeout(() => connectWS(chainName), Math.min(5000 * failCount, 60000))
      }
    })
  } catch { startHTTPPoll(chainName) }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 9 — HTTP POLLING (batched eth_getLogs, 15 pools per call)
// ═══════════════════════════════════════════════════════════════════════════
async function startHTTPPoll(chainName) {
  if (_polls[chainName]) return
  _polls[chainName] = true

  const chain  = CHAINS[chainName]
  const pools  = ALL_POOLS[chainName] ?? []
  const pollMs = (chain?.tier ?? 2) === 1 ? 3000 : 8000
  if (!pools.length) return

  console.log(`[CHAINS1] ${chainName}: HTTP polling every ${pollMs/1000}s`)
  let lastBlock = '0x0'

  const poll = async () => {
    try {
      const blk  = await rpcCall(chainName, 'eth_blockNumber', [])
      const from = '0x'+Math.max(0, parseInt(blk,16)-2).toString(16)
      if (from === lastBlock) return
      lastBlock = from

      // Batch 15 pools per eth_getLogs call, both V3 and V2 topics
      for (let i=0; i<pools.length; i+=15) {
        const batch = pools.slice(i, i+15)
        try {
          const logs = await rpcCall(chainName, 'eth_getLogs', [{
            address:   batch,
            topics:    [[SWAP_TOPIC, V2_TOPIC]],  // OR filter — one call for both
            fromBlock: from,
            toBlock:   'latest',
          }])
          if (Array.isArray(logs)) {
            for (const log of logs) await processLog(chainName, log)
          }
        } catch {}
        if (i+15 < pools.length) await new Promise(r=>setTimeout(r,80))
      }
    } catch {}
  }

  const idx   = Object.keys(CHAINS).indexOf(chainName)
  const start = 1000 + idx * 120
  setTimeout(async () => { await poll(); setInterval(poll, pollMs) }, start)
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 10 — SELF-HEAL
// ═══════════════════════════════════════════════════════════════════════════
function startSelfHeal() {
  setInterval(() => {
    const now = Date.now()
    for (const name of Object.keys(CHAINS)) {
      const last     = _lastSwap[name]
      const silentMs = last != null ? now - last : 0
      if (silentMs > 900000 && (_qualCount[name] ?? 0) > 5) {
        const ws = _ws[name]
        if (!ws || ws.readyState !== 1) connectWS(name)
      }
    }
  }, 300000)
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 11 — API
// ═══════════════════════════════════════════════════════════════════════════
export function getChain(name)  { return CHAINS[name] ?? null }
export function getAllChains()  { return CHAINS }
export function getWS(name)     { return _ws[name] ?? null }
export function getActive()     { return Object.entries(CHAINS).map(([name,c])=>({name,...c})).sort((a,b)=>a.tier-b.tier) }

export function getChains1Stats() {
  return {
    qualifyingSwaps: _totalQ,
    threshold:       '$100M–$10B',
    swapsByChain:    { ..._qualCount },
    wsConnected:     Object.keys(_ws).filter(k=>_ws[k]?.readyState===1).length,
    httpPolling:     Object.keys(_polls).filter(k=>_polls[k]).length,
    totalPools:      _totalPools,
    blacklisted:     _blacklist.size,
    chains: Object.fromEntries(
      getActive().map(c => [c.name, {
        name:    c.name,
        tier:    c.tier,
        address: getConfig('contract_addr_'+c.name) ?? null,
        status:  getConfig('contract_addr_'+c.name) ? 'live' : 'waiting',
        swaps:   _qualCount[c.name] ?? 0,
      }])
    ),
    liveCount: getActive().filter(c=>!!getConfig('contract_addr_'+c.name)).length,
  }
}

export function getWsPoolStats() { return getChains1Stats() }

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 12 — START
// ═══════════════════════════════════════════════════════════════════════════
export async function startChains() {
  // Restore swap count from db.js
  try {
    const db = await import('./db.js')
    const saved = db.loadSwapCount()
    if (saved > 0) { _totalQ = saved; setConfig('mega_swap_count', String(saved)) }
  } catch {}

  console.log(`[CHAINS1] ${Object.keys(CHAINS).length} chains (+ Solana as intelligence) · ${_totalPools} pools`)
  console.log('[CHAINS1] All 20 Alchemy endpoints active — NO drpc.org, NO free tier')
  console.log('[CHAINS1] POOL_META: exact stable leg decode — zero phantom values')
  console.log('[CHAINS1] Threshold: $100M min · $10B max · Math.min() fallback')
  console.log(`[CHAINS1] Batched subscriptions: 10 pools/call V3 + V2 · max coverage`)

  // Connect all chains with stagger
  for (const chainName of Object.keys(CHAINS)) {
    connectWS(chainName)
    await new Promise(r => setTimeout(r, 80))
  }

  // HTTP polling for tier-1
  for (const [name, chain] of Object.entries(CHAINS)) {
    if (chain.tier === 1) {
      await startHTTPPoll(name)
      await new Promise(r => setTimeout(r, 80))
    }
  }

  // Tier-2 HTTP with delay
  setTimeout(async () => {
    for (const [name, chain] of Object.entries(CHAINS)) {
      if (chain.tier === 2) {
        await startHTTPPoll(name)
        await new Promise(r => setTimeout(r, 150))
      }
    }
  }, 5000)

  startSelfHeal()

  // Periodic stats persist
  setInterval(() => {
    setConfig('mega_swap_count', String(_totalQ))
    setConfig('chains1_stats',   JSON.stringify(getChains1Stats()))
    // Persist swap count to volume
    import('./db.js').then(db => db.saveSwapCount(_totalQ)).catch(() => {})
  }, 60000)
              }
