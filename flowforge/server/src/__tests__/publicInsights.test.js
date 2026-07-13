// GET /api/v1/workflows/:id/insights — the public, token-authenticated view of
// the run-insights rollup (shares computeInsights with the session route).

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))

const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')

describe('GET /api/v1/workflows/:id/insights', () => {
  let jwt
  let readToken
  let workflowId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'pubinsights@example.com', password: 'password123', displayName: 'Insights' })
    jwt = res.body.token
    const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${jwt}`)
    const workspaceId = ws.body.workspaces[0].id

    const wf = await request(app)
      .post(`/api/workspaces/${workspaceId}/workflows`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ name: 'Insightful' })
    workflowId = wf.body.workflow.id

    const minted = await request(app)
      .post('/api/tokens')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ name: 'reader', scopes: ['read'] })
    readToken = minted.body.token

    const insert = db.prepare(
      'INSERT INTO executions (id, workflow_id, status, trigger_type, started_at, finished_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    for (let i = 0; i < 12; i++) {
      const start = new Date(Date.now() - i * 60_000)
      insert.run(
        uuidv4(), workflowId, 'completed', 'api',
        start.toISOString(), new Date(start.getTime() + 1000).toISOString(), start.toISOString()
      )
    }
  })

  it('returns the insight bundle for a read token', async () => {
    const res = await request(app)
      .get(`/api/v1/workflows/${workflowId}/insights`)
      .set('Authorization', `Bearer ${readToken}`)
    expect(res.status).toBe(200)
    expect(res.body.workflowId).toBe(workflowId)
    expect(res.body.counts.completed).toBe(12)
    expect(res.body.duration.count).toBe(12)
    expect(res.body.duration.p50).toBeGreaterThan(0)
    expect(Array.isArray(res.body.recentRuns)).toBe(true)
  })

  it('honours the limit param', async () => {
    const res = await request(app)
      .get(`/api/v1/workflows/${workflowId}/insights?limit=5`)
      .set('Authorization', `Bearer ${readToken}`)
    expect(res.body.window.limit).toBe(5)
    expect(res.body.recentRuns).toHaveLength(5)
  })

  it('requires the read scope', async () => {
    const triggerOnly = await request(app)
      .post('/api/tokens')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ name: 'trigger-only', scopes: ['trigger'] })
    const denied = await request(app)
      .get(`/api/v1/workflows/${workflowId}/insights`)
      .set('Authorization', `Bearer ${triggerOnly.body.token}`)
    expect(denied.status).toBe(403)
  })

  it('hides workflows the token owner cannot see', async () => {
    const res = await request(app)
      .get(`/api/v1/workflows/${uuidv4()}/insights`)
      .set('Authorization', `Bearer ${readToken}`)
    expect(res.status).toBe(404)
  })
})
