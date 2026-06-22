// X7-SV · compiler.js — compile X7.sol on boot, cache bytecode
import { readFileSync, existsSync } from 'fs'
import { createRequire } from 'module'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

let _artifact = null

export async function compile() {
  if (_artifact) return _artifact

  const solcPath = join(__dir, '../contracts/X7.sol')
  if (!existsSync(solcPath)) {
    console.error('[COMPILER] X7.sol not found at', solcPath)
    return null
  }

  try {
    const solc = require('solc')
    const source = readFileSync(solcPath, 'utf8')

    const input = {
      language: 'Solidity',
      sources: { 'X7.sol': { content: source } },
      settings: {
        outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
        optimizer: { enabled: true, runs: 200 }
      }
    }

    const output = JSON.parse(solc.compile(JSON.stringify(input)))

    if (output.errors?.some(e => e.severity === 'error')) {
      output.errors.filter(e => e.severity === 'error').forEach(e => console.error('[COMPILER]', e.message))
      return null
    }

    const contract = output.contracts['X7.sol']['X7']
    _artifact = {
      abi: contract.abi,
      bytecode: '0x' + contract.evm.bytecode.object
    }

    console.log('[COMPILER] X7.sol compiled — bytecode:', _artifact.bytecode.length / 2, 'bytes')
    return _artifact
  } catch (e) {
    console.error('[COMPILER] Failed:', e.message)
    return null
  }
}

export function getArtifact() { return _artifact }
