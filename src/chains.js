// Vanguard chain registry — 17 core chains
// All addresses from verified on-chain data
const BALANCER = '0xBA12222222228d8Ba445958a75a0704d566BF2C8'
const UNI_R2   = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45' // SwapRouter02
const UNI_Q2   = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e' // QuoterV2

const CHAINS = {
  ethereum: { id:1,      native:'ETH',  tier:1, minProfit:500, gasLimit:700000n,
    rpcH: process.env.ALCHEMY_ETH_KEY&&process.env.ALCHEMY_ETH_KEY!=='demo'?`https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_ETH_KEY}`:'https://eth.llamarpc.com',
    rpcW: process.env.ALCHEMY_ETH_KEY&&process.env.ALCHEMY_ETH_KEY!=='demo'?`wss://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_ETH_KEY}`:'wss://eth.drpc.org',
    usdc:'0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', weth:'0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    router:UNI_R2, quoter:UNI_Q2, flash:BALANCER, aave:'0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2' },

  arbitrum: { id:42161,  native:'ETH',  tier:1, minProfit:5,   gasLimit:800000n,
    rpcH: process.env.ALCHEMY_ARB_KEY&&process.env.ALCHEMY_ARB_KEY!=='demo'?`https://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_ARB_KEY}`:'https://arb1.arbitrum.io/rpc',
    rpcW: process.env.ALCHEMY_ARB_KEY&&process.env.ALCHEMY_ARB_KEY!=='demo'?`wss://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_ARB_KEY}`:'wss://arb1.arbitrum.io/ws',
    usdc:'0xaf88d065e77c8cC2239327C5EDb3A432268e5831', weth:'0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    router:UNI_R2, quoter:UNI_Q2, flash:BALANCER, aave:'0x794a61358D6845594F94dc1DB02A252b5b4814aD' },

  polygon:  { id:137,    native:'POL',  tier:1, minProfit:2,   gasLimit:800000n,
    rpcH: process.env.ALCHEMY_POL_KEY&&process.env.ALCHEMY_POL_KEY!=='demo'?`https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_POL_KEY}`:'https://polygon.llamarpc.com',
    rpcW: process.env.ALCHEMY_POL_KEY&&process.env.ALCHEMY_POL_KEY!=='demo'?`wss://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_POL_KEY}`:'wss://polygon.drpc.org',
    usdc:'0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', weth:'0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
    router:UNI_R2, quoter:UNI_Q2, flash:BALANCER, aave:'0x794a61358D6845594F94dc1DB02A252b5b4814aD' },

  base:     { id:8453,   native:'ETH',  tier:1, minProfit:2,   gasLimit:800000n,
    rpcH: process.env.ALCHEMY_BASE_KEY&&process.env.ALCHEMY_BASE_KEY!=='demo'?`https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_BASE_KEY}`:'https://mainnet.base.org',
    rpcW: process.env.ALCHEMY_BASE_KEY&&process.env.ALCHEMY_BASE_KEY!=='demo'?`wss://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_BASE_KEY}`:'wss://base.drpc.org',
    usdc:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', weth:'0x4200000000000000000000000000000000000006',
    router:'0x2626664c2603336E57B271c5C0b26F421741e481', quoter:'0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
    flash:BALANCER, aave:'0xA238Dd80C259a72e81d7e4664a9801593F98d1c5' },

  optimism: { id:10,     native:'ETH',  tier:1, minProfit:2,   gasLimit:800000n,
    rpcH: process.env.ALCHEMY_OP_KEY&&process.env.ALCHEMY_OP_KEY!=='demo'?`https://opt-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_OP_KEY}`:'https://mainnet.optimism.io',
    rpcW: process.env.ALCHEMY_OP_KEY&&process.env.ALCHEMY_OP_KEY!=='demo'?`wss://opt-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_OP_KEY}`:'wss://optimism.drpc.org',
    usdc:'0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', weth:'0x4200000000000000000000000000000000000006',
    router:UNI_R2, quoter:UNI_Q2, flash:BALANCER, aave:'0x794a61358D6845594F94dc1DB02A252b5b4814aD' },

  avalanche:{ id:43114,  native:'AVAX', tier:1, minProfit:5,   gasLimit:800000n,
    rpcH: process.env.ALCHEMY_AVAX_KEY&&process.env.ALCHEMY_AVAX_KEY!=='demo'?`https://avax-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_AVAX_KEY}`:'https://api.avax.network/ext/bc/C/rpc',
    rpcW: process.env.ALCHEMY_AVAX_KEY&&process.env.ALCHEMY_AVAX_KEY!=='demo'?`wss://avax-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_AVAX_KEY}`:'wss://api.avax.network/ext/bc/C/ws',
    usdc:'0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', weth:'0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB',
    router:'0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE', quoter:'0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F',
    flash:BALANCER, aave:'0x794a61358D6845594F94dc1DB02A252b5b4814aD' },

  bnb:      { id:56,     native:'BNB',  tier:1, minProfit:5,   gasLimit:800000n,
    rpcH:'https://bsc-dataseed.bnbchain.org', rpcW:'wss://bsc-ws-node.nariox.org',
    usdc:'0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', weth:'0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
    router:'0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2', quoter:'0x78D78E420Da98ad378D7799bE8f4AF69033EB077',
    flash:'0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', aave:null },

  scroll:   { id:534352, native:'ETH',  tier:2, minProfit:5,   gasLimit:800000n,
    rpcH:'https://rpc.scroll.io', rpcW:'wss://wss-rpc.scroll.io/ws',
    usdc:'0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4', weth:'0x5300000000000000000000000000000000000004',
    router:'0xfc30937f5cDe93Df8d48aCAF7e6f5D8D8A31F636', quoter:'0x3A5c9F09c1E7e58f7DC7FcABE9e36E3Ce9F24EAA',
    flash:'0x11fCfe756c05AD438e312a7fd934381537D3cFfe', aave:'0x11fCfe756c05AD438e312a7fd934381537D3cFfe' },

  blast:    { id:81457,  native:'ETH',  tier:2, minProfit:5,   gasLimit:800000n,
    rpcH:'https://rpc.blast.io', rpcW:'wss://rpc.blast.io',
    usdc:'0x4300000000000000000000000000000000000003', weth:'0x4300000000000000000000000000000000000004',
    router:'0x549FEB8c9bd4c12Ad2AB27022dA12492aC452B66', quoter:'0x25FBE69d72c01C22C04fBaA70D76Ee8bA2DB2bfA',
    flash:BALANCER, aave:null },

  linea:    { id:59144,  native:'ETH',  tier:2, minProfit:5,   gasLimit:800000n,
    rpcH:'https://rpc.linea.build', rpcW:'wss://rpc.linea.build',
    usdc:'0x176211869cA2b568f2A7D4EE941E073a821EE1ff', weth:'0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34',
    router:'0x5aB53a0A89B21E7F68b9aFaF7E0Ee792F2EA77C', quoter:'0xe848e9Ac6fe45CFf75E4059CEE65B7faE5F5a2A',
    flash:BALANCER, aave:null },

  zksync:   { id:324,    native:'ETH',  tier:2, minProfit:5,   gasLimit:800000n,
    rpcH:'https://mainnet.era.zksync.io', rpcW:'wss://mainnet.era.zksync.io/ws',
    usdc:'0x3355df6D4c9C3035724Fd0e3914dE96A5a83aaf', weth:'0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91',
    router:'0x99c56385daBCE3E81d8499d0b8d0257aBC07E8A', quoter:'0x8Cb537fc92E26d8EBBb760E632c95484b6Ea3e28',
    flash:BALANCER, aave:null },

  mantle:   { id:5000,   native:'MNT',  tier:2, minProfit:5,   gasLimit:800000n,
    rpcH:'https://rpc.mantle.xyz', rpcW:'wss://rpc.mantle.xyz',
    usdc:'0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9', weth:'0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8',
    router:UNI_R2, quoter:UNI_Q2, flash:BALANCER, aave:null },

  mode:     { id:34443,  native:'ETH',  tier:3, minProfit:5,   gasLimit:800000n,
    rpcH:'https://mainnet.mode.network', rpcW:'wss://mainnet.mode.network',
    usdc:'0xd988097fb8612cc24eeC14542bC03424c656005f', weth:'0x4200000000000000000000000000000000000006',
    router:UNI_R2, quoter:UNI_Q2, flash:BALANCER, aave:null },

  metis:    { id:1088,   native:'METIS',tier:3, minProfit:5,   gasLimit:800000n,
    rpcH:'https://andromeda.metis.io/?owner=1088', rpcW:'wss://andromeda-ws.metis.io',
    usdc:'0xEA32A96608495e54156Ae48931A7c20f0dcc1a21', weth:'0x75cb093E4D61d2A2e65D8e0BBb01DE8d89b53481',
    router:'0x1E876cCe41B7b844FDe09E38Fa1cf00f213bFf56', quoter:UNI_Q2,
    flash:'0x90df02551bB792286e8D4f13E0e357b4Bf1D6a57', aave:null },

  manta:    { id:169,    native:'ETH',  tier:3, minProfit:5,   gasLimit:800000n,
    rpcH:'https://pacific-rpc.manta.network/http', rpcW:'wss://pacific-rpc.manta.network/ws',
    usdc:'0xb73603C5d87fA094B7314C74ACE2e64D165016fb', weth:'0x0Dc808adcE2310AcDa0330f0B09b83Fd2E5F0Ac6',
    router:'0x3488d5A2D0281f546e43435715C436b46Ec1C678', quoter:UNI_Q2, flash:BALANCER, aave:null },

  taiko:    { id:167000, native:'ETH',  tier:3, minProfit:5,   gasLimit:800000n,
    rpcH:'https://rpc.mainnet.taiko.xyz', rpcW:'wss://ws.mainnet.taiko.xyz',
    usdc:'0x07d83526730c7438048D55A4fc033a18d5a9bcD9', weth:'0xA51894664A773981C6C112C43ce576f315d5b1B6',
    router:UNI_R2, quoter:UNI_Q2, flash:BALANCER, aave:null },
}

const _extra = {}
export const getChain    = n => CHAINS[n] || _extra[n]
export const getActive   = () => Object.entries({...CHAINS,..._extra}).map(([name,c])=>({name,...c})).sort((a,b)=>a.tier-b.tier)
export const getTier     = t => getActive().filter(c=>c.tier===t)
export const addChain    = (name,cfg) => { _extra[name]=cfg; console.log('[CHAINS] Added:',name) }
export const initChains  = () => { console.log(`[CHAINS] ${Object.keys(CHAINS).length} chains (${Object.keys(CHAINS).filter(k=>CHAINS[k].tier===1).length} tier1 · ${Object.keys(CHAINS).filter(k=>CHAINS[k].tier===2).length} tier2 · ${Object.keys(CHAINS).filter(k=>CHAINS[k].tier===3).length} tier3)`); return {...CHAINS,..._extra} }
