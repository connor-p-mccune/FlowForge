// The public, token-authenticated concurrency surface:
//   GET /api/v1/executions/:id/schedule   — where a finished run's time went
//   GET /api/v1/workflows/:id/forecast    — including ?cap, the what-if

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: jest.fn().mockResolvedValue(undefined) }) }))
jest.mock('../config/redis', () => ({ publish: jest.fn().mockResolvedValue(1) }))

const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')

const T0 = Date.parse('2026-02-01T00:00:00.000Z')
const iso = (sec) => new Date(T0 + sec * 1000).toISOString()

// A trigger fanning out to four independent nodes, so the graph is wide enough
// for a cap to bite.
const LEAVES = ['a', 'b', 'c', 'd']
const GRAPH = {
  nodes: ['t', ...LEAVES].map((id) => ({ id, type: 'transform', data: { label: id } })),
  edges: LEAVES.map((id) => ({ source: 't', target: id })),
}

describe('public concurrency endpoints', () => {
  let jwt
  let readToken
  let triggerToken
  let workflowId
  let executionId

  beforeAll(async () => {
    process.env.EXEC_MAX_PARALLEL = '2'
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'pubsched@example.com', password: 'password123', displayName: 'Sched' })
    jwt = res.body.token
    const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${jwt}`)
    const workspaceId = ws.body.workspaces[0].id
    const userId = db.prepare('SELECT id FROM users WHERE email = ?').get('pubsched@example.com').id

    workflowId = uuidv4()
    db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by)
       VALUES (?, ?, ?, ?, 'deployed', ?)`
    ).run(workflowId, workspaceId, 'Wide', JSON.stringify(GRAPH), userId)

    readToken = (
      await request(app)
        .post('/api/tokens')
        .set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'reader', scopes: ['read'] })
    ).body.token
    triggerToken = (
      await request(app)
        .post('/api/tokens')
        .set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'runner', scopes: ['trigger'] })
    ).body.token

    // Two historical runs, each two waves of two 2s nodes at a cap of 2. Two
    // runs so the forecast has a per-node timing sample to work from.
    const insertExec = db.prepare(
      `INSERT INTO executions (id, workflow_id, status, triggered_by, started_at, finished_at, created_at)
       VALUES (?, ?, 'completed', ?, ?, ?, ?)`
    )
    const insertStep = db.prepare(
      `INSERT INTO execution_steps (id, execution_id, node_id, node_type, status, started_at, finished_at)
       VALUES (?, ?, ?, 'transform', 'succeeded', ?, ?)`
    )
    for (let run = 0; run < 2; run++) {
      const id = uuidv4()
      insertExec.run(id, workflowId, userId, iso(run * 100), iso(run * 100 + 4), iso(run * 100))
      insertStep.run(uuidv4(), id, 't', iso(run * 100), iso(run * 100))
      insertStep.run(uuidv4(), id, 'a', iso(run * 100), iso(run * 100 + 2))
      insertStep.run(uuidv4(), id, 'b', iso(run * 100), iso(run * 100 + 2))
      insertStep.run(uuidv4(), id, 'c', iso(run * 100 + 2), iso(run * 100 + 4))
      insertStep.run(uuidv4(), id, 'd', iso(run * 100 + 2), iso(run * 100 + 4))
      if (run === 0) executionId = id
    }
  })

  afterAll(() => {
    delete process.env.EXEC_MAX_PARALLEL
  })

  describe('GET /api/v1/executions/:id/schedule', () => {
    it('reports the measured split for a read token', async () => {
      const res = await request(app)
        .get(`/api/v1/executions/${executionId}/schedule`)
        .set('Authorization', `Bearer ${readToken}`)

      expect(res.status).toBe(200)
      expect(res.body.available).toBe(true)
      expect(res.body.observed.makespanMs).toBe(4000)
      expect(res.body.observed.queuedMs).toBe(4000)
      expect(res.body.idealMakespanMs).toBe(2000)
    })

    it('refuses a token without the read scope', async () => {
      const res = await request(app)
        .get(`/api/v1/executions/${executionId}/schedule`)
        .set('Authorization', `Bearer ${triggerToken}`)
      expect(res.status).toBe(403)
    })

    it('401s without a token', async () => {
      const res = await request(app).get(`/api/v1/executions/${executionId}/schedule`)
      expect(res.status).toBe(401)
    })

    it('404s for an unknown execution', async () => {
      const res = await request(app)
        .get(`/api/v1/executions/${uuidv4()}/schedule`)
        .set('Authorization', `Bearer ${readToken}`)
      expect(res.status).toBe(404)
    })
  })

  describe('GET /api/v1/workflows/:id/forecast', () => {
    it('carries the concurrency block alongside the critical path', async () => {
      const res = await request(app)
        .get(`/api/v1/workflows/${workflowId}/forecast`)
        .set('Authorization', `Bearer ${readToken}`)

      expect(res.status).toBe(200)
      expect(res.body.available).toBe(true)
      // Critical path: one 2s node deep. Under a cap of 2: two waves.
      expect(res.body.estimatedMs).toBe(2000)
      expect(res.body.concurrency.cap).toBe(2)
      expect(res.body.concurrency.makespanMs).toBe(4000)
      expect(res.body.concurrency.contention).toBe(2)
      expect(res.body.concurrency.knee.cap).toBe(4)
    })

    it('models a different cap on request without changing anything', async () => {
      const res = await request(app)
        .get(`/api/v1/workflows/${workflowId}/forecast?cap=4`)
        .set('Authorization', `Bearer ${readToken}`)
      expect(res.body.concurrency.cap).toBe(4)
      expect(res.body.concurrency.makespanMs).toBe(2000)
      expect(res.body.concurrency.contention).toBe(1)

      // The server's own cap is untouched by the query.
      const again = await request(app)
        .get(`/api/v1/workflows/${workflowId}/forecast`)
        .set('Authorization', `Bearer ${readToken}`)
      expect(again.body.concurrency.cap).toBe(2)
    })

    it('ignores a nonsense cap rather than failing the request', async () => {
      const res = await request(app)
        .get(`/api/v1/workflows/${workflowId}/forecast?cap=-4`)
        .set('Authorization', `Bearer ${readToken}`)
      expect(res.status).toBe(200)
      expect(res.body.concurrency.cap).toBe(2)
    })
  })
})
