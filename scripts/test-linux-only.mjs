// The plugin is supported on Linux only. This pins the install-time platform
// declaration and the user-facing scope so a future change cannot quietly
// re-advertise Windows or macOS support without also changing the docs.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => readFileSync(join(root, path), 'utf8')
const pkg = JSON.parse(read('package.json'))

assert.equal(process.platform, 'linux', 'the plugin test suite is supported on Linux only')
assert.deepEqual(pkg.os, ['linux'], 'package.json must declare the Linux-only install constraint')
assert.match(read('README.md'), /platform-Linux/, 'README must show the Linux-only platform badge')
assert.match(read('README.md'), /Linux-only plugin/, 'README must state the Linux-only scope')
assert.match(read('docs/INSTALL.md'), /Linux-only plugin/, 'INSTALL must state the Linux-only scope')
assert.match(read('docs/TEST-GAPS.md'), /## 0\. Scope decisions/, 'TEST-GAPS must record the accepted scope')
assert.match(read('docs/TEST-GAPS.md'), /Linux-only/, 'TEST-GAPS must state the Linux-only scope')

console.log('Linux-only scope OK')
