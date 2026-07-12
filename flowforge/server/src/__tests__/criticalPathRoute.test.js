// GET /api/executions/:id returns a critical-path analysis alongside the run's
// steps, computed from the recorded timings against the workflow's edges.

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

describe('GET /api/executions/:id critical path', () => {
  let token
  let userId
  let workspaceId
  let workflowId
  let executionId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'cp-user@example.com', password: 'password123', displayName: 'CP' })
    token = res.body.token
    userId = db.prepare('SELECT id FROM users WHERE email = ?').get('cp-user@example.com').id
    workspaceId = (await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`))
      .body.workspaces[0].id

    // Diamond: t → (b short, c long) → d. Critical path is t → c → d.
    const graph = {
      nodes: ['t', 'b', 'c', 'd'].map((id) => ({ id, type: 'transform', data: { label: id } })),
      edges: [
        { source: 't', target: 'b' },
        { source: 't', target: 'c' },
        { source: 'b', target: 'd' },
        { source: 'c', target: 'd' },
      ],
    }
    workflowId = uuidv4()
    db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by)
       VALUES (?, ?, ?, ?, 'deployed', ?)`
    ).run(workflowId, workspaceId, 'Diamond', JSON.stringify(graph), userId)

    executionId = uuidv4()
    db.prepare(
      `INSERT INTO executions (id, workflow_id, status, triggered_by, started_at, finished_at, created_at)
       VALUES (?, ?, 'completed', ?, ?, ?, ?)`
    ).run(executionId, workflowId, userId, iso(0), iso(4), iso(0))

    const insertStep = db.prepare(
      `INSERT INTO execution_steps (id, execution_id, node_id, node_type, status, started_at, finished_at)
       VALUES (?, ?, ?, 'transform', 'succeeded', ?, ?)`
    )
    insertStep.run(uuidv4(), executionId, 't', iso(0), iso(0.5)) // 0.5s
    insertStep.run(uuidv4(), executionId, 'b', iso(0.5), iso(1.5)) // 1s (short)
    insertStep.run(uuidv4(), executionId, 'c', iso(0.5), iso(3.5)) // 3s (long)
    insertStep.run(uuidv4(), executionId, 'd', iso(3.5), iso(4)) // 0.5s
  })

  it('includes the critical path through the heavier branch', async () => {
    const res = await request(app)
      .get(`/api/executions/${executionId}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.criticalPath.path).toEqual(['t', 'c', 'd'])
    expect(res.body.criticalPath.totalMs).toBe(4000)
    expect(res.body.criticalPath.durationsMs).toEqual({ t: 500, c: 3000, d: 500 })
  })

  it('404s for a non-member', async () => {
    const other = await request(app)
      .post('/api/auth/register')
      .send({ email: 'cp-other@example.com', password: 'password123', displayName: 'Other' })
    const res = await request(app)
      .get(`/api/executions/${executionId}`)
      .set('Authorization', `Bearer ${other.body.token}`)
    expect(res.status).toBe(404)
  })
})
