// Engine-level behavior of the step cache: a caching node's second identical
// run adopts the recorded output (step status 'cached') without invoking its
// runner, while anything that changes the work — input, config, TTL expiry —
// re-executes. Uses a real local HTTP server so "the runner didn't run" is
// observable as "the API wasn't called".

const http = require('http')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'
process.env.EXEC_RETRY_BASE_MS = '1'

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const { runExecution } = require('../services/executionEngine')

function seedWorkflow(graph) {
  const userId = uuidv4()
  const wsId = uuidv4()
  const wfId = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, `${userId}@test.com`, 'x', 'Test', now)
  db.prepare(
    'INSERT INTO workspaces (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(wsId, 'WS', userId, now, now)
  db.prepare(
    'INSERT INTO workflows (id, workspace_id, name, graph_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(wfId, wsId, 'WF', JSON.stringify(graph), userId, now, now)
  return { wfId, userId }
}

function newExecution(wfId, userId, extra = {}) {
  const execId = uuidv4()
  db.prepare(
    'INSERT INTO executions (id, workflow_id, status, triggered_by, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(execId, wfId, 'pending', userId, new Date().toISOString())
  return { execId, ...extra }
}

function stepFor(execId, nodeId) {
  return db
    .prepare('SELECT * FROM execution_steps WHERE execution_id = ? AND node_id = ?')
    .get(execId, nodeId)
}

const node = (id, type, config = {}, label = id) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label, config },
})
const edge = (source, target) => ({ id: `${source}-${target}`, source, target })

// Tests share one in-memory DB, so cache assertions scope to their workflow.
function cacheCount(wfId) {
  return db.prepare('SELECT COUNT(*) AS n FROM step_cache WHERE workflow_id = ?').get(wfId).n
}

// A counting HTTP server: every test asserts cache behavior through how many
// requests actually arrived.
function startServer(handler) {
  const state = { hits: 0 }
  const server = http.createServer((req, res) => {
    state.hits++
    handler(req, res, state)
  })
  return new Promise((resolve) =>
    server.listen(0, () => resolve({ server, state, port: server.address().port }))
  )
}

const jsonOk = (body) => (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function cachedHttpGraph(port, cache = { enabled: true }) {
  return {
    nodes: [
      node('t1', 'trigger-manual'),
      node('h1', 'action-http', {
        method: 'GET',
        url: `http://127.0.0.1:${port}/`,
        headers: '{}',
        cache,
      }),
      node('o1', 'output-log', { message: 'status {{h1.status}}' }),
    ],
    edges: [edge('t1', 'h1'), edge('h1', 'o1')],
  }
}

describe('step cache in the engine', () => {
  it('second identical run adopts the cached output and skips the call', async () => {
    const { server, state, port } = await startServer(jsonOk({ ok: true }))
    try {
      const { wfId, userId } = seedWorkflow(cachedHttpGraph(port))

      const first = newExecution(wfId, userId)
      await runExecution(first.execId, { publish: () => {} })
      expect(state.hits).toBe(1)
      expect(stepFor(first.execId, 'h1').status).toBe('succeeded')

      const events = []
      const second = newExecution(wfId, userId)
      await runExecution(second.execId, { publish: (p) => events.push(p) })
      expect(state.hits).toBe(1) // no second request
      const cachedStep = stepFor(second.execId, 'h1')
      expect(cachedStep.status).toBe('cached')
      expect(JSON.parse(cachedStep.output_json).body).toEqual({ ok: true })
      // Downstream nodes consume the adopted output like any other.
      expect(JSON.parse(stepFor(second.execId, 'o1').output_json)).toEqual({ message: 'status 200' })
      // The live event stream reports the step as cached, not succeeded.
      expect(events.some((e) => e.kind === 'step' && e.nodeId === 'h1' && e.status === 'cached')).toBe(true)
    } finally {
      server.close()
    }
  })

  it('a changed input is a different key — the node re-executes', async () => {
    const { server, state, port } = await startServer(jsonOk({ ok: true }))
    try {
      const graph = {
        nodes: [
          node('t1', 'trigger-webhook'),
          node('h1', 'action-http', {
            method: 'GET',
            url: `http://127.0.0.1:${port}/?q={{t1.q}}`,
            headers: '{}',
            cache: { enabled: true },
          }),
        ],
        edges: [edge('t1', 'h1')],
      }
      const { wfId, userId } = seedWorkflow(graph)

      const a = newExecution(wfId, userId)
      await runExecution(a.execId, { publish: () => {}, payload: { q: 'alpha' } })
      const b = newExecution(wfId, userId)
      await runExecution(b.execId, { publish: () => {}, payload: { q: 'beta' } })
      expect(state.hits).toBe(2)

      // And the repeat of an already-seen payload hits.
      const c = newExecution(wfId, userId)
      await runExecution(c.execId, { publish: () => {}, payload: { q: 'alpha' } })
      expect(state.hits).toBe(2)
      expect(stepFor(c.execId, 'h1').status).toBe('cached')
    } finally {
      server.close()
    }
  })

  it('an expired entry re-executes and refreshes the cache', async () => {
    const { server, state, port } = await startServer(jsonOk({ ok: true }))
    try {
      const { wfId, userId } = seedWorkflow(cachedHttpGraph(port))
      const first = newExecution(wfId, userId)
      await runExecution(first.execId, { publish: () => {} })

      db.prepare('UPDATE step_cache SET expires_at = ? WHERE workflow_id = ?')
        .run(new Date(Date.now() - 1000).toISOString(), wfId)

      const second = newExecution(wfId, userId)
      await runExecution(second.execId, { publish: () => {} })
      expect(state.hits).toBe(2)
      expect(stepFor(second.execId, 'h1').status).toBe('succeeded')

      const third = newExecution(wfId, userId)
      await runExecution(third.execId, { publish: () => {} })
      expect(state.hits).toBe(2)
      expect(stepFor(third.execId, 'h1').status).toBe('cached')
    } finally {
      server.close()
    }
  })

  it('dry runs neither read nor write the cache', async () => {
    const { server, state, port } = await startServer(jsonOk({ ok: true }))
    try {
      const { wfId, userId } = seedWorkflow(cachedHttpGraph(port))

      // Dry run first: simulated output must not seed the cache.
      const dry = newExecution(wfId, userId)
      await runExecution(dry.execId, { publish: () => {}, dryRun: true })
      expect(state.hits).toBe(0)
      expect(cacheCount(wfId)).toBe(0)

      // Real run populates it; a following dry run still simulates.
      const real = newExecution(wfId, userId)
      await runExecution(real.execId, { publish: () => {} })
      expect(state.hits).toBe(1)

      const dry2 = newExecution(wfId, userId)
      await runExecution(dry2.execId, { publish: () => {}, dryRun: true })
      expect(state.hits).toBe(1)
      expect(stepFor(dry2.execId, 'h1').status).toBe('succeeded') // simulated, not cached
    } finally {
      server.close()
    }
  })

  it('failures are never cached — the node retries for real next run', async () => {
    let failing = true
    const { server, state, port } = await startServer((req, res) => {
      if (failing) {
        res.writeHead(500)
        res.end('boom')
      } else {
        jsonOk({ ok: true })(req, res)
      }
    })
    try {
      const { wfId, userId } = seedWorkflow(cachedHttpGraph(port))
      const first = newExecution(wfId, userId)
      await runExecution(first.execId, { publish: () => {} })
      expect(stepFor(first.execId, 'h1').status).toBe('failed')
      expect(cacheCount(wfId)).toBe(0)

      failing = false
      const hitsAfterFailure = state.hits
      const second = newExecution(wfId, userId)
      await runExecution(second.execId, { publish: () => {} })
      expect(state.hits).toBe(hitsAfterFailure + 1)
      expect(stepFor(second.execId, 'h1').status).toBe('succeeded')
    } finally {
      server.close()
    }
  })

  it('cache config on a non-cacheable node type is ignored', async () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('o1', 'output-log', { message: 'hello', cache: { enabled: true } }),
      ],
      edges: [edge('t1', 'o1')],
    }
    const { wfId, userId } = seedWorkflow(graph)
    const first = newExecution(wfId, userId)
    await runExecution(first.execId, { publish: () => {} })
    const second = newExecution(wfId, userId)
    await runExecution(second.execId, { publish: () => {} })
    expect(stepFor(second.execId, 'o1').status).toBe('succeeded')
    expect(cacheCount(wfId)).toBe(0)
  })

  it('a resumed run can reuse a cached step from the source run', async () => {
    const { server, state, port } = await startServer(jsonOk({ ok: true }))
    // b1 needs an endpoint that fails fast and deterministically: a server
    // that answers 500 beats a closed port, whose connect behavior varies by
    // platform/firewall.
    const broken = await startServer((req, res) => {
      res.writeHead(500)
      res.end('permanently broken')
    })
    try {
      // h1 caches; b1 fails the first run. Resuming must adopt h1's recorded
      // output ('reused') rather than re-fetching.
      const graph = {
        nodes: [
          node('t1', 'trigger-manual'),
          node('h1', 'action-http', {
            method: 'GET',
            url: `http://127.0.0.1:${port}/`,
            headers: '{}',
            cache: { enabled: true },
          }),
          node('b1', 'action-http', {
            method: 'GET',
            url: `http://127.0.0.1:${broken.port}/`,
            headers: '{}',
          }),
        ],
        edges: [edge('t1', 'h1'), edge('h1', 'b1')],
      }
      const { wfId, userId } = seedWorkflow(graph)

      // Seed the cache, then a second run whose h1 step lands as 'cached' and
      // whose b1 fails.
      const seedRun = newExecution(wfId, userId)
      await runExecution(seedRun.execId, { publish: () => {} })
      const failedRun = newExecution(wfId, userId)
      await runExecution(failedRun.execId, { publish: () => {} })
      expect(stepFor(failedRun.execId, 'h1').status).toBe('cached')
      expect(stepFor(failedRun.execId, 'b1').status).toBe('failed')

      // Resume: the cached step must be adoptable like a succeeded one.
      const resumeId = uuidv4()
      db.prepare(
        `INSERT INTO executions (id, workflow_id, status, triggered_by, resumed_from_execution_id, created_at)
         VALUES (?, ?, 'pending', ?, ?, ?)`
      ).run(resumeId, wfId, userId, failedRun.execId, new Date().toISOString())
      await runExecution(resumeId, { publish: () => {} })
      expect(stepFor(resumeId, 'h1').status).toBe('reused')
      expect(state.hits).toBe(1) // one real request across all three runs
    } finally {
      server.close()
      broken.server.close()
    }
  })
})
