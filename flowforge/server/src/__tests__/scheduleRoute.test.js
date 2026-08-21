// GET /api/executions/:id/schedule — the measured split between work and
// waiting for an execution slot, and what other caps would have produced.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: jest.fn().mockResolvedValue(undefined) }) }))
jest.mock('../config/redis', () => ({ publish: jest.fn().mockResolvedValue(1) }))

const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')

const T0 = Date.parse('2026-01-01T00:00:00.000Z')
const iso = (sec) => new Date(T0 + sec * 1000).toISOString()

describe('GET /api/executions/:id/schedule', () => {
  let token
  let userId
  let workspaceId
  let workflowId
  let executionId

  beforeAll(async () => {
    process.env.EXEC_MAX_PARALLEL = '2'
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'sched-user@example.com', password: 'password123', displayName: 'Sched' })
    token = res.body.token
    userId = db.prepare('SELECT id FROM users WHERE email = ?').get('sched-user@example.com').id
    workspaceId = (await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`))
      .body.workspaces[0].id

    // A trigger fanning out to four 2s nodes, run at a cap of 2: two waves.
    // The critical path is one node deep and the run took four seconds.
    const leaves = ['a', 'b', 'c', 'd']
    const graph = {
      nodes: ['t', ...leaves].map((id) => ({ id, type: 'transform', data: { label: id } })),
      edges: leaves.map((id) => ({ source: 't', target: id })),
    }
    workflowId = uuidv4()
    db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by)
       VALUES (?, ?, ?, ?, 'deployed', ?)`
    ).run(workflowId, workspaceId, 'Fan out', JSON.stringify(graph), userId)

    executionId = uuidv4()
    db.prepare(
      `INSERT INTO executions (id, workflow_id, status, triggered_by, started_at, finished_at, created_at)
       VALUES (?, ?, 'completed', ?, ?, ?, ?)`
    ).run(executionId, workflowId, userId, iso(0), iso(4), iso(0))

    const insertStep = db.prepare(
      `INSERT INTO execution_steps (id, execution_id, node_id, node_type, status, started_at, finished_at)
       VALUES (?, ?, ?, 'transform', 'succeeded', ?, ?)`
    )
    insertStep.run(uuidv4(), executionId, 't', iso(0), iso(0))
    insertStep.run(uuidv4(), executionId, 'a', iso(0), iso(2))
    insertStep.run(uuidv4(), executionId, 'b', iso(0), iso(2))
    insertStep.run(uuidv4(), executionId, 'c', iso(2), iso(4))
    insertStep.run(uuidv4(), executionId, 'd', iso(2), iso(4))
  })

  afterAll(() => {
    delete process.env.EXEC_MAX_PARALLEL
  })

  it('splits the run into work and waiting', async () => {
    const res = await request(app)
      .get(`/api/executions/${executionId}/schedule`)
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.available).toBe(true)
    expect(res.body.cap).toBe(2)
    expect(res.body.observed.makespanMs).toBe(4000)
    expect(res.body.observed.workMs).toBe(8000)
    // c and d were ready at 0 and started at 2.
    expect(res.body.observed.queuedMs).toBe(4000)
    expect(res.body.observed.utilisation).toBe(1)
  })

  it('reports the floor the cap kept it from', async () => {
    const res = await request(app)
      .get(`/api/executions/${executionId}/schedule`)
      .set('Authorization', `Bearer ${token}`)
    // With capacity for all four, the same work is one 2s wave.
    expect(res.body.idealMakespanMs).toBe(2000)
    expect(res.body.atCap).toEqual(
      expect.arrayContaining([
        { cap: 1, makespanMs: 8000 },
        { cap: 2, makespanMs: 4000 },
        { cap: 4, makespanMs: 2000 },
      ])
    )
  })

  it('names the node that held the slot', async () => {
    const res = await request(app)
      .get(`/api/executions/${executionId}/schedule`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.perNode.c.queuedMs).toBe(2000)
    expect(res.body.perNode.c.cause.kind).toBe('slot')
    expect(['a', 'b']).toContain(res.body.perNode.c.cause.nodeId)
  })

  it('reports unavailable for a run with no recorded steps', async () => {
    const bare = uuidv4()
    db.prepare(
      `INSERT INTO executions (id, workflow_id, status, triggered_by, created_at)
       VALUES (?, ?, 'pending', ?, ?)`
    ).run(bare, workflowId, userId, iso(0))

    const res = await request(app)
      .get(`/api/executions/${bare}/schedule`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.available).toBe(false)
  })

  it('404s for a run in a workspace the caller is not a member of', async () => {
    const other = await request(app)
      .post('/api/auth/register')
      .send({ email: 'sched-other@example.com', password: 'password123', displayName: 'Other' })
    const res = await request(app)
      .get(`/api/executions/${executionId}/schedule`)
      .set('Authorization', `Bearer ${other.body.token}`)
    expect(res.status).toBe(404)
  })

  it('404s for an execution that does not exist', async () => {
    const res = await request(app)
      .get(`/api/executions/${uuidv4()}/schedule`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
  })
})
