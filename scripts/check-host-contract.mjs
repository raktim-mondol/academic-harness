#!/usr/bin/env node
/**
 * Verify the host seams the plugin's approval and trust code relies on, against
 * an installed DSH. Usage: node scripts/check-host-contract.mjs <profile-or-prefix-dir>
 *
 * The plugin's tests drive its listeners with a fake host, so they cannot see
 * the host change underneath them. This reads the installed host's own type
 * declarations and pipeline instead, and fails when a seam moved:
 *
 *   - tools/pre-execute may return { kind: 'ask', reason }
 *   - an `approval` service exists, is read with ctx.get('approval'), and its
 *     request() resolves to one of allowed-once | rejected | cancelled | unavailable
 *
 * Run daily by .github/workflows/dsh-compat.yml against `latest` and `next`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(process.argv[2] ?? '.')

function findPackage(name) {
  const candidates = [
    join(root, 'node_modules', '@deepseek-ai', name),
    join(root, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', name),
    join(root, '@deepseek-ai', name),
    join(root, '..', name), // hoisted global layout: <prefix>/@deepseek-ai/{dsh,dsh-tools,...}
    join(root, 'node_modules', '.pnpm', 'node_modules', '@deepseek-ai', name),
  ]
  const found = candidates.find((dir) => existsSync(join(dir, 'package.json')))
  if (!found) throw new Error(`@deepseek-ai/${name} not found under ${root}`)
  return found
}

function read(dir, rel) {
  const file = join(dir, rel)
  if (!existsSync(file)) throw new Error(`missing ${file}`)
  return readFileSync(file, 'utf8')
}

function readAll(dir, rel, pattern) {
  const base = join(dir, rel)
  if (!existsSync(base)) throw new Error(`missing ${base}`)
  return readdirSync(base).filter((name) => pattern.test(name)).sort().map((name) => readFileSync(join(base, name), 'utf8')).join('\n')
}

const failures = []
function expect(label, condition) {
  if (condition) console.log(`ok    ${label}`)
  else {
    failures.push(label)
    console.error(`FAIL  ${label}`)
  }
}

let tools
let approval
try {
  tools = findPackage('dsh-tools')
  approval = findPackage('dsh-user-approval')
} catch (error) {
  console.error(`cannot check the host contract: ${error.message}`)
  process.exit(2)
}
const toolsVersion = JSON.parse(read(tools, 'package.json')).version
console.log(`host dsh-tools ${toolsVersion}`)

// The declaration moved between host builds (lib/types/contracts.d.ts on
// 0.2.2, lib/types/index.d.ts on 0.2.1), so read every declaration file.
const contracts = readAll(tools, 'lib/types', /\.d\.ts$/)
const decision = contracts.slice(Math.max(contracts.indexOf('export type PreToolDecision'), 0))
expect("PreToolDecision allows kind: 'ask'", /kind:\s*'ask'/.test(decision.slice(0, 900)))
expect("PreToolDecision 'ask' carries an optional reason", /kind:\s*'ask';\s*reason\?: string/.test(decision.slice(0, 900)))

const pipeline = readAll(tools, 'lib', /\.js$/)
expect("the tool pipeline reads the approval service with ctx.get('approval')", /\.get\(["']approval["']\)/.test(pipeline))
expect('an ask runs only on allowed-once', /allowed-once/.test(pipeline))

const outcomes = readAll(approval, 'lib/types', /\.d\.ts$/)
expect('ApprovalOutcome lists the four outcomes the plugin handles', ['allowed-once', 'rejected', 'cancelled', 'unavailable'].every((o) => outcomes.includes(`'${o}'`)))
const service = outcomes
expect('ApprovalService.request() resolves to an ApprovalOutcome', /request\(req: ApprovalRequest\): Promise<ApprovalOutcome>/.test(service))
expect('ApprovalRequest carries agent, toolName and callId', /readonly agent: Agent/.test(service) && /readonly toolName: string/.test(service) && /callId/.test(service))

if (failures.length > 0) {
  console.error(`\nhost contract changed: ${failures.length} check(s) failed. The approval code in academic-harness-hooks.js and paper-mcp.js assumes these seams.`)
  process.exit(1)
}
console.log('host contract intact')
