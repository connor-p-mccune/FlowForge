// Run comparison: compareRuns diffs two recorded step lists node by node, and
// GET /api/executions/:id/compare/:otherId serves it for two runs of the same
// workflow.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: jest.fn().mockResolvedValue(undefined) }) }))
jest.mock('../config/redis', () => ({ publish: jest.fn().mockResolvedValue(1) }))

const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')
const { compareRuns, deepEqual } = require('../services/runComparison')

const T0 = Date.parse('2026-01-01T00:00:00.000Z')
const iso = (sec) => new Date(T0 + sec * 1000).toISOString()

const step = (nodeId, { type = 'transform', status = 'succeeded', start = 0, end = 1, output, error = null } = {}) => ({
  node_id: nodeId,
  node_type: type,
  status,
  started_at: iso(start),
  finished_at: iso(end),
  output_json: output === undefined ? null : JSON.stringify(output),
  error,
})

describe('deepEqual', () => {
  it('compares structurally, ignoring key order', () => {
    expect(deepEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true)
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false)
    expect(deepEqual([1, 2], [2, 1])).toBe(false)
    expect(deepEqual(null, null)).toBe(true)
    expect(deepEqual(null, {})).toBe(false)
  })
})

describe('compareRuns', () => {
  it('lines nodes up by id + type and reports deltas', () => {
    const base = [
      step('t', { output: { ok: true } }),
      step('h', { start: 1, end: 3, output: { status: 200 } }),
    ]
    const other = [
      step('t', { output: { ok: true } }),
      step('h', { start: 1, end: 8, status: 'failed', output: undefined, error: 'HTTP 500' }),
    ]
    const { nodes, summary } = compareRuns(base, other)

    expect(nodes).toHaveLength(2)
    const [t, h] = nodes
    expect(t.statusChanged).toBe(false)
    expect(t.outputChanged).toBe(false)
    expect(t.durationDeltaMs).toBe(0)
    expect(h.statusChanged).toBe(true)
    expect(h.outputChanged).toBe(true)
    expect(h.durationDeltaMs).toBe(5000)
    expect(summary).toMatchObject({
      nodesCompared: 2,
      statusChanges: 1,
      outputChanges: 1,
      slowestRegression: 'h',
      onlyInBase: 0,
      onlyInOther: 0,
    })
  })

  it('treats a node replaced with a different type as removed + added', () => {
    const { nodes, summary } = compareRuns(
      [step('x', { type: 'transform' })],
      [step('x', { type: 'action-http' })]
    )
    expect(nodes).toHaveLength(2)
    expect(nodes[0].other).toBeNull()
    expect(nodes[1].base).toBeNull()
    expect(summary.onlyInBase).toBe(1)
    expect(summary.onlyInOther).toBe(1)
  })

  it('key-order differences in outputs are not a change', () => {
    const { nodes } = compareRuns(
      [step('t', { output: { a: 1, b: 2 } })],
      [step('t', { output: { b: 2, a: 1 } })]
    )
    expect(nodes[0].outputChanged).toBe(false)
  })
})

describe('GET /api/executions/:id/compare/:otherId', () => {
  let token
  let userId
  let workspaceId
  let workflowId
  let baseId
  let otherId

  function seedRun(status, steps) {
    const execId = uuidv4()
    db.prepare(
      `INSERT INTO executions (id, workflow_id, status, triggered_by, started_at, finished_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(execId, workflowId, status, userId, iso(0), iso(10), iso(0))
    const insert = db.prepare(
      `INSERT INTO execution_steps (id, execution_id, node_id, node_type, status, output_json, error, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const s of steps) {
      insert.run(uuidv4(), execId, s.node_id, s.node_type, s.status, s.output_json, s.error, s.started_at, s.finished_at)
    }
    return execId
  }

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'cmp-user@example.com', password: 'password123', displayName: 'Cmp' })
    token = res.body.token
    userId = db.prepare('SELECT id FROM users WHERE email = ?').get('cmp-user@example.com').id
    workspaceId = (await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`))
      .body.workspaces[0].id

    workflowId = uuidv4()
    db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by)
       VALUES (?, ?, ?, ?, 'deployed', ?)`
    ).run(workflowId, workspaceId, 'Cmp WF', JSON.stringify({ nodes: [], edges: [] }), userId)

    baseId = seedRun('completed', [
      step('t', { output: { ok: true } }),
      step('h', { start: 1, end: 2, output: { status: 200 } }),
    ])
    otherId = seedRun('failed', [
      step('t', { output: { ok: true } }),
      step('h', { start: 1, end: 5, status: 'failed', error: 'HTTP 500' }),
    ])
  })

  it('returns the node-by-node diff with run envelopes', async () => {
    const res = await request(app)
      .get(`/api/executions/${baseId}/compare/${otherId}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.base).toMatchObject({ id: baseId, status: 'completed', durationMs: 10000 })
    expect(res.body.other).toMatchObject({ id: otherId, status: 'failed' })
    const h = res.body.nodes.find((n) => n.nodeId === 'h')
    expect(h.statusChanged).toBe(true)
    expect(h.durationDeltaMs).toBe(3000)
    expect(res.body.summary.slowestRegression).toBe('h')
  })

  it('400s when the runs belong to different workflows', async () => {
    const otherWorkflowId = uuidv4()
    db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by)
       VALUES (?, ?, ?, ?, 'deployed', ?)`
    ).run(otherWorkflowId, workspaceId, 'Other WF', JSON.stringify({ nodes: [], edges: [] }), userId)
    const foreignExec = uuidv4()
    db.prepare(
      'INSERT INTO executions (id, workflow_id, status, triggered_by, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(foreignExec, otherWorkflowId, 'completed', userId, iso(0))

    const res = await request(app)
      .get(`/api/executions/${baseId}/compare/${foreignExec}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(400)
  })

  it('404s for non-members and unknown ids', async () => {
    const outsider = await request(app)
      .post('/api/auth/register')
      .send({ email: 'cmp-outsider@example.com', password: 'password123', displayName: 'Out' })
    const asOutsider = await request(app)
      .get(`/api/executions/${baseId}/compare/${otherId}`)
      .set('Authorization', `Bearer ${outsider.body.token}`)
    expect(asOutsider.status).toBe(404)

    const unknown = await request(app)
      .get(`/api/executions/${baseId}/compare/${uuidv4()}`)
      .set('Authorization', `Bearer ${token}`)
    expect(unknown.status).toBe(404)
  })
})
