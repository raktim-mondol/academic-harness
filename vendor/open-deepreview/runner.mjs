#!/usr/bin/env node
/**
 * Node entry point for the vendored engine. The upstream cli.ts only invokes
 * runCli() under `import.meta.main`, which is false here, so call it directly.
 * This keeps the entry independent of Bun and of Node's import.meta.main
 * support (absent before Node 24.2).
 */
import { runCli } from './src/cli.ts'

runCli(process.argv.slice(2)).then(
  (code) => {
    if (code !== 0) process.exit(code)
  },
  (error) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  },
)
