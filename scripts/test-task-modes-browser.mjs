/** Opt-in, keyless Chromium interaction checks. Uses production UI/claims, not a live model. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { build } from 'esbuild'

if (process.env.AH_TASK_BROWSER_TEST !== '1') {
  console.log('SKIP task browser checks: set AH_TASK_BROWSER_TEST=1 (requires agent-browser and Chromium)')
  process.exit(0)
}
const bundle = await build({ entryPoints: [new URL('./fixtures/task-modes-browser.js', import.meta.url).pathname], bundle: true, write: false, format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } })
const server = createServer((req, res) => {
  if (req.url === '/app.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(bundle.outputFiles[0].text); return }
  res.setHeader('Content-Type', 'text/html')
  res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Task selector test</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const run = promisify(execFile)
const browserSession = `ah-tasks-${process.pid}`
async function browser(...args) {
  const { stdout } = await run('agent-browser', ['--session', browserSession, ...args], { timeout: 45_000, maxBuffer: 1024 * 1024 })
  return stdout
}
async function evaluate(code) {
  return browser('eval', '-b', Buffer.from(code).toString('base64'))
}
try {
  await browser('open', `http://127.0.0.1:${server.address().port}`)
  await browser('wait', '--fn', '!!document.querySelector("[data-ah-task-selector] button:not([disabled])")')
  await browser('fill', '#prompt', 'What evidence supports this method?')
  await browser('find', 'role', 'button', 'click', '--name', 'Deep Research')
  await browser('wait', '--fn', 'document.querySelector("[data-ah-task-selector] button").getAttribute("aria-pressed") === "true"')
  assert.notEqual(await evaluate('getComputedStyle(document.querySelector("[data-ah-task-selector] > span")).backgroundColor'), 'rgba(0, 0, 0, 0)', 'selected chip must have a visible fill')
  assert.match(await browser('get', 'text', '[data-ah-task-selector] button'), /✓/u, 'selected chip carries a check')
  await browser('find', 'role', 'button', 'click', '--name', 'Deep Research')
  assert.match(await browser('get', 'value', '#prompt'), /What evidence supports this method\?/u)
  assert.match(await browser('get', 'attr', '[data-ah-task-selector] button', 'aria-pressed'), /false/u)
  await browser('find', 'role', 'button', 'click', '--name', 'Deep Research')
  await browser('click', '[data-ah-effort-menu] > button')
  await browser('wait', '--fn', 'document.querySelector("[role=menu]") !== null')
  assert.match(await evaluate('(() => { const m=document.querySelector("[role=menu]"); const r=m.getBoundingClientRect(); return m.parentElement===document.body && getComputedStyle(m).position==="fixed" && r.width<=220 && r.top>=0 && r.bottom<=innerHeight; })()'), /true/u)
  await browser('find', 'role', 'menuitemradio', 'click', '--name', 'High')
  assert.match(await browser('get', 'text', '[data-ah-effort-menu] > button'), /High/u)
  await browser('find', 'role', 'button', 'click', '--name', 'Send', '--exact')
  await browser('wait', '--text', 'Research task accepted')
  await browser('wait', '--text', 'Deep Research started')
  assert.match(await browser('get', 'text', '[data-ah-task-run]'), /What evidence supports this method\?/u)
  assert.match(await browser('get', 'text', '[data-ah-task-run]'), /Background tasks/u)
  assert.match(await evaluate('window.fixture.submissions[0].request.options.effort'), /high/u)
  assert.match(await browser('get', 'value', '#prompt'), /^\s*$/u)
  assert.match(await browser('get', 'attr', '[data-ah-task-selector] button', 'aria-pressed'), /false/u)
  await browser('fill', '#prompt', 'An ordinary follow-up')
  await browser('focus', '#prompt')
  await browser('press', 'Enter')
  await browser('wait', '--text', 'Chat: An ordinary follow-up')
  assert.match(await evaluate('window.fixture.submissions.length'), /1/u)
  await evaluate('window.fixture.setFailure(true)')
  await browser('find', 'role', 'button', 'click', '--name', 'Deep Research')
  await browser('fill', '#prompt', 'Quickly give a comprehensive review')
  await browser('find', 'role', 'button', 'click', '--name', 'Send', '--exact')
  await browser('wait', '--text', 'Choose an explicit effort')
  assert.match(await browser('get', 'value', '#prompt'), /Quickly give a comprehensive review/u)
  await browser('find', 'role', 'button', 'click', '--name', 'Send', '--exact')
  assert.match(await evaluate('window.fixture.submissions[1].request.request_id === window.fixture.submissions[2].request.request_id'), /true/u)
  await evaluate('window.fixture.switchSession("two")')
  await browser('wait', '--text', 'Session two')
  assert.match(await browser('get', 'attr', '[data-ah-task-selector] button', 'aria-pressed'), /false/u)
  await evaluate('window.fixture.setPlan(true)')
  await browser('wait', '--fn', 'document.querySelector("[data-ah-task-selector] button").disabled')
  await browser('set', 'viewport', '390', '844')
  assert.match(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), /true/u)
  console.log('PASS browser: select → effort → Send, one-shot reset, Enter chat, error retention, retry identity, session isolation, Plan lock, mobile width')
} finally {
  try { await browser('close') } finally { await new Promise((resolve) => server.close(resolve)) }
}
