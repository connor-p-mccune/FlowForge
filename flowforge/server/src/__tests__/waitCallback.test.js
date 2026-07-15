// Wait-for-callback: the machine-in-the-loop gate. The engine arms a
// tokenized execution_callbacks row per wait-callback node at run start, an
// external system POSTs to /api/callbacks/:token, and the runner routes the
// run down the received or timed-out branch — with the armed-before-anything-
// executes design guaranteeing an early reply is stored, not lost.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'
process.env.EXEC_RETRY_BASE_MS = '1'
process.env.CALLBACK_POLL_MS = '25'

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const { runExecution } = require('../services/executionEngine')
const { app } = require('../index')

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

  const execId = uuidv4()
  db.prepare(
    'INSERT INTO executions (id, workflow_id, status, triggered_by, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(execId, wfId, 'pending', userId, now)
  return { execId, wfId }
}

const getExecution = (execId) => db.prepare('SELECT * FROM executions WHERE id = ?').get(execId)
const getSteps = (execId) =>
  db.prepare('SELECT * FROM execution_steps WHERE execution_id = ? ORDER BY rowid').all(execId)
const stepFor = (execId, nodeId) => getSteps(execId).find((s) => s.node_id === nodeId)
const callbackRow = (execId, nodeId) =>
  db
    .prepare('SELECT * FROM execution_callbacks WHERE execution_id = ? AND node_id = ?')
    .get(execId, nodeId)

const node = (id, type, config = {}, label = id) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label, config },
})
const edge = (source, target, sourceHandle = null) => ({
  id: `${source}-${target}${sourceHandle ? `-${sourceHandle}` : ''}`,
  source,
  target,
  sourceHandle,
})

// Poll until fn() is truthy (the runner and the test share one synchronous
// SQLite connection, so reads between its poll ticks are always consistent).
async function waitFor(fn, ms = 5000) {
  const deadline = Date.now() + ms
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

// A graph that pauses at a wait-callback node and routes its two branches to
// separate log nodes.
const gateGraph = (config = {}) => ({
  nodes: [
    node('t1', 'trigger-manual'),
    node('w1', 'wait-callback', config),
    node('got', 'output-log', { message: 'value={{w1.payload.value}}' }),
    node('late', 'output-log', { message: 'timed out' }),
  ],
  edges: [edge('t1', 'w1'), edge('w1', 'got', 'received'), edge('w1', 'late', 'timed-out')],
})

describe('wait-callback engine lifecycle', () => {
  it('arms a tokenized row at run start and settles on delivery', async () => {
    const { execId } = seedWorkflow(gateGraph())
    const events = []
    const run = runExecution(execId, { publish: (p) => events.push(p) })

    // The row exists (armed by the engine) and the runner flips it to waiting.
    const row = await waitFor(() => {
      const r = callbackRow(execId, 'w1')
      return r && r.status === 'waiting' ? r : null
    })
    expect(row.token).toMatch(/^[0-9a-f]{48}$/)
    expect(row.expires_at).toBeTruthy()

    const res = await request(app)
      .post(`/api/callbacks/${row.token}`)
      .send({ value: 42 })
    expect(res.status).toBe(202)

    await run
    expect(getExecution(execId).status).toBe('completed')
    expect(callbackRow(execId, 'w1').status).toBe('received')
    expect(stepFor(execId, 'got').status).toBe('succeeded')
    expect(stepFor(execId, 'late').status).toBe('skipped')
    expect(JSON.parse(stepFor(execId, 'got').output_json).message).toBe('value=42')

    // The canvas learned the URL from the exec-update channel.
    const cb = events.find((e) => e.kind === 'callback')
    expect(cb.nodeId).toBe('w1')
    expect(cb.url).toBe(`/api/callbacks/${row.token}`)
  })

  it('a reply that beats the runner to the node is not lost', async () => {
    // The delay upstream of the gate means the row sits 'armed' while the
    // external system replies; the runner must adopt the parked payload.
    const graph = gateGraph()
    graph.nodes.splice(1, 0, node('d1', 'action-delay', { durationMs: 300 }))
    graph.edges = [
      edge('t1', 'd1'),
      edge('d1', 'w1'),
      edge('w1', 'got', 'received'),
      edge('w1', 'late', 'timed-out'),
    ]
    const { execId } = seedWorkflow(graph)
    const run = runExecution(execId, { publish: () => {} })

    const row = await waitFor(() => callbackRow(execId, 'w1'))
    expect(row.status).toBe('armed')
    const res = await request(app)
      .post(`/api/callbacks/${row.token}`)
      .send({ value: 'early' })
    expect(res.status).toBe(202)

    await run
    expect(getExecution(execId).status).toBe('completed')
    expect(JSON.parse(stepFor(execId, 'got').output_json).message).toBe('value=early')
  })

  it('times out down the timed-out branch by default', async () => {
    // Fractional minutes keep the test fast (0.001 min = 60ms).
    const { execId } = seedWorkflow(gateGraph({ timeoutMinutes: 0.001 }))
    await runExecution(execId, { publish: () => {} })

    expect(getExecution(execId).status).toBe('completed')
    expect(stepFor(execId, 'got').status).toBe('skipped')
    expect(stepFor(execId, 'late').status).toBe('succeeded')
    expect(callbackRow(execId, 'w1').status).toBe('timed-out')
  })

  it('onTimeout fail fails the run instead', async () => {
    const { execId } = seedWorkflow(gateGraph({ timeoutMinutes: 0.001, onTimeout: 'fail' }))
    await runExecution(execId, { publish: () => {} })

    expect(getExecution(execId).status).toBe('failed')
    expect(stepFor(execId, 'w1').status).toBe('failed')
  })

  it('upstream configs resolve {{callbacks.<node-id>}} to the callback URL', async () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('tr1', 'transform', { template: '{"url": "{{callbacks.w1}}"}' }),
        node('w1', 'wait-callback', { timeoutMinutes: 0.001 }),
      ],
      edges: [edge('t1', 'tr1'), edge('tr1', 'w1')],
    }
    const { execId } = seedWorkflow(graph)
    await runExecution(execId, { publish: () => {} })

    const row = callbackRow(execId, 'w1')
    expect(JSON.parse(stepFor(execId, 'tr1').output_json).url).toBe(
      `/api/callbacks/${row.token}`
    )
  })

  it('retires an armed callback on a dead branch when the run settles', async () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('c1', 'condition', { operator: 'expression', expression: 'false' }),
        node('w1', 'wait-callback', {}),
      ],
      edges: [edge('t1', 'c1'), edge('c1', 'w1', 'true')],
    }
    const { execId } = seedWorkflow(graph)
    await runExecution(execId, { publish: () => {} })

    expect(getExecution(execId).status).toBe('completed')
    expect(stepFor(execId, 'w1').status).toBe('skipped')
    // The token died with the run — a late delivery gets a 410, not a write.
    const row = callbackRow(execId, 'w1')
    expect(row.status).toBe('cancelled')
    const res = await request(app).post(`/api/callbacks/${row.token}`).send({ late: true })
    expect(res.status).toBe(410)
  })

  it('cancelling the run mid-wait retires the token', async () => {
    const { execId } = seedWorkflow(gateGraph())
    const run = runExecution(execId, { publish: () => {} })
    await waitFor(() => callbackRow(execId, 'w1')?.status === 'waiting')

    db.prepare('UPDATE executions SET cancel_requested = 1 WHERE id = ?').run(execId)
    await run

    expect(getExecution(execId).status).toBe('cancelled')
    expect(callbackRow(execId, 'w1').status).toBe('cancelled')
  })

  it('dry runs simulate: nothing armed, received branch taken', async () => {
    const { execId } = seedWorkflow(gateGraph())
    await runExecution(execId, { dryRun: true, publish: () => {} })

    expect(getExecution(execId).status).toBe('completed')
    expect(callbackRow(execId, 'w1')).toBeUndefined()
    const w1 = JSON.parse(stepFor(execId, 'w1').output_json)
    expect(w1).toMatchObject({ result: 'received', simulated: true })
    expect(stepFor(execId, 'got').status).toBe('succeeded')
  })
})

describe('POST /api/callbacks/:token', () => {
  it('404s an unknown token without leaking anything', async () => {
    const res = await request(app).post('/api/callbacks/not-a-token').send({})
    expect(res.status).toBe(404)
  })

  it('duplicate delivery cannot overwrite the first payload', async () => {
    const { execId } = seedWorkflow(gateGraph())
    const run = runExecution(execId, { publish: () => {} })
    const row = await waitFor(() => callbackRow(execId, 'w1'))

    const first = await request(app).post(`/api/callbacks/${row.token}`).send({ n: 1 })
    expect(first.status).toBe(202)
    const second = await request(app).post(`/api/callbacks/${row.token}`).send({ n: 2 })
    expect(second.status).toBe(409)
    expect(second.body.status).toBe('received')

    await run
    expect(JSON.parse(stepFor(execId, 'got').output_json).message).toBe('value=')
    expect(JSON.parse(callbackRow(execId, 'w1').payload_json)).toEqual({ n: 1 })
  })

  it('410s a timed-out callback', async () => {
    const { execId } = seedWorkflow(gateGraph({ timeoutMinutes: 0.001 }))
    await runExecution(execId, { publish: () => {} })
    const row = callbackRow(execId, 'w1')
    const res = await request(app).post(`/api/callbacks/${row.token}`).send({})
    expect(res.status).toBe(410)
    expect(res.body.status).toBe('timed-out')
  })
})
