/**
 * HTTP-level checks for the remote-compute clients against a local mock.
 *
 * Base URLs are read at module load, so this script sets them before the
 * dynamic imports below. It verifies the Runpod v2 paths/payloads/pagination
 * and the Vast.ai marketplace flow without touching a real account.
 */
import assert from 'node:assert/strict'
import http from 'node:http'

const requests = []
let networkVolumePage = 0

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const url = new URL(req.url, 'http://localhost')
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: body ? JSON.parse(body) : null })
    res.setHeader('Content-Type', 'application/json')

    if (url.pathname === '/v2/pods' && req.method === 'POST') {
      res.end(JSON.stringify({ id: 'pod_test', status: 'PROVISIONING' }))
      return
    }
    if (url.pathname === '/v2/pods/pod_test' && req.method === 'GET') {
      res.end(JSON.stringify({
        id: 'pod_test',
        status: 'RUNNING',
        ssh: {
          proxy: { host: 'ssh.runpod.io', port: 22, username: 'pod_test-token' },
          direct: { host: '1.2.3.4', port: 22022, username: 'root' },
        },
      }))
      return
    }
    if (url.pathname === '/v2/pods/pod_bad' && req.method === 'GET') {
      res.statusCode = 404
      res.setHeader('Content-Type', 'application/problem+json')
      res.end(JSON.stringify({ title: 'Not Found', status: 404, detail: 'pod not found' }))
      return
    }
    if (url.pathname === '/v2/pods/pod_test' && req.method === 'DELETE') {
      res.statusCode = 204
      res.end()
      return
    }
    if (url.pathname === '/v2/network-volumes' && req.method === 'GET') {
      networkVolumePage++
      if (networkVolumePage === 1) {
        res.end(JSON.stringify({
          networkVolumes: [{ id: 'vol_1', name: 'data', dataCenter: 'EU-RO-1' }],
          pagination: { nextCursor: 'cursor-2', hasNextPage: true },
        }))
      } else {
        res.end(JSON.stringify({
          networkVolumes: [{ id: 'vol_2', name: 'other', dataCenter: 'US-TX-3' }],
          pagination: { nextCursor: null, hasNextPage: false },
        }))
      }
      return
    }
    if (url.pathname === '/v2/network-volumes' && req.method === 'POST') {
      res.end(JSON.stringify({ id: 'vol_new', name: 'data', size: 20, dataCenter: 'EU-RO-1', type: 'STANDARD' }))
      return
    }

    if (url.pathname === '/api/v0/bundles/' && req.method === 'POST') {
      res.end(JSON.stringify({
        offers: [
          { id: 222, dph_total: 0.61, gpu_name: 'H100_SXM' },
          { id: 111, dph_total: 0.42, gpu_name: 'H100_SXM' },
        ],
      }))
      return
    }
    if (url.pathname === '/api/v0/asks/111/' && req.method === 'PUT') {
      res.end(JSON.stringify({ success: true, new_contract: 555 }))
      return
    }
    if (url.pathname === '/api/v0/instances/555/' && req.method === 'GET') {
      res.end(JSON.stringify({
        instances: {
          id: 555,
          actual_status: 'running',
          ssh_host: 'ssh9.vast.ai',
          ssh_port: 10882,
          dph_total: 0.42,
          gpu_name: 'H100_SXM',
        },
      }))
      return
    }
    if (url.pathname === '/api/v0/instances/555/' && req.method === 'DELETE') {
      res.end(JSON.stringify({ success: true }))
      return
    }
    if (url.pathname === '/api/v0/instances/999/' && req.method === 'GET') {
      res.end(JSON.stringify({ instances: { id: 999, actual_status: 'exited', status_msg: 'host went offline' } }))
      return
    }
    if (url.pathname === '/api/v0/ssh' && req.method === 'POST') {
      res.end(JSON.stringify({ success: true, key: { id: 9 } }))
      return
    }
    if (url.pathname === '/api/v0/ssh/9' && req.method === 'DELETE') {
      res.end(JSON.stringify({ success: true }))
      return
    }

    res.statusCode = 500
    res.end(JSON.stringify({ detail: `unhandled ${req.method} ${url.pathname}` }))
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
process.env.RUNPOD_API_BASE_URL = `${base}/v2`
process.env.VAST_API_BASE_URL = `${base}/api/v0`

const runpod = await import('../runpod-client.js')
const vast = await import('../vastai-client.js')

let checks = 0
function check(name, fn) {
  return Promise.resolve(fn()).then(() => {
    checks++
    console.log(`ok ${checks} - ${name}`)
  })
}

try {
  await check('runpod v2 create/get/delete use the v2 paths and parse status + ssh', async () => {
    const created = await runpod.createPod('key', { name: 'x' })
    assert.equal(created.id, 'pod_test')
    const pod = await runpod.getPod('key', 'pod_test')
    assert.equal(pod.status, 'RUNNING')
    assert.deepEqual(runpod.resolveSshEndpoint(pod), { host: '1.2.3.4', port: 22022, username: 'root', kind: 'direct' })
    await runpod.deletePod('key', 'pod_test')
    const paths = requests.filter((r) => r.path.startsWith('/v2/pods')).map((r) => `${r.method} ${r.path}`)
    assert.deepEqual(paths, ['POST /v2/pods', 'GET /v2/pods/pod_test', 'DELETE /v2/pods/pod_test'])
  })

  await check('runpod problem+json errors surface title and detail', async () => {
    await assert.rejects(runpod.getPod('key', 'pod_bad'), /404: Not Found: pod not found/)
  })

  await check('runpod network volumes follow cursor pagination', async () => {
    const volumes = await runpod.listNetworkVolumes('key')
    assert.deepEqual(volumes.map((v) => v.id), ['vol_1', 'vol_2'])
    const listCalls = requests.filter((r) => r.method === 'GET' && r.path === '/v2/network-volumes')
    assert.equal(listCalls.length, 2)
    assert.equal(listCalls[1].query.cursor, 'cursor-2')
  })

  await check('runpod volume creation uses the v2 dataCenter field', async () => {
    const vol = await runpod.createNetworkVolume('key', { name: 'data', size: 20, dataCenter: 'EU-RO-1' })
    assert.equal(vol.id, 'vol_new')
    const call = requests.find((r) => r.method === 'POST' && r.path === '/v2/network-volumes' && r.body?.name === 'data')
    assert.deepEqual(call.body, { name: 'data', size: 20, dataCenter: 'EU-RO-1' })
  })

  await check('vast search sorts offers by price and returns the cheapest', async () => {
    const offers = await vast.searchOffers('key', { gpu_name: { in: ['H100_SXM'] }, limit: 8 })
    assert.deepEqual(offers.map((o) => o.id), [111, 222])
  })

  await check('vast create/show/destroy use new_contract and ssh_host/ssh_port', async () => {
    const created = await vast.createInstance('key', 111, { image: 'x', runtype: 'ssh_direct' })
    assert.equal(created.new_contract, 555)
    const { info, ssh } = await vast.waitForInstanceSsh('key', 555, { timeoutMs: 5000, pollMs: 10 })
    assert.equal(info.actual_status, 'running')
    assert.deepEqual(ssh, { host: 'ssh9.vast.ai', port: 10882, username: 'root', kind: 'direct' })
    await vast.destroyInstance('key', 555)
    const paths = requests.filter((r) => r.path.startsWith('/api/v0/asks') || r.path.startsWith('/api/v0/instances')).map((r) => `${r.method} ${r.path}`)
    assert.deepEqual(paths, ['PUT /api/v0/asks/111/', 'GET /api/v0/instances/555/', 'DELETE /api/v0/instances/555/'])
  })

  await check('vast ephemeral ssh key registers and deletes', async () => {
    const id = await vast.registerSshKey('key', 'ssh-ed25519 AAAA test')
    assert.equal(id, 9)
    await vast.deleteSshKey('key', id)
    assert.ok(requests.some((r) => r.method === 'POST' && r.path === '/api/v0/ssh' && r.body.ssh_key.includes('ssh-ed25519')))
    assert.ok(requests.some((r) => r.method === 'DELETE' && r.path === '/api/v0/ssh/9'))
  })

  await check('vast terminal states fail fast instead of polling forever', async () => {
    await assert.rejects(vast.waitForInstanceSsh('key', 999, { timeoutMs: 5000, pollMs: 10 }), /unrecoverable state "exited"/)
  })
} finally {
  server.close()
}

console.log(`\n${checks} HTTP checks passed`)
