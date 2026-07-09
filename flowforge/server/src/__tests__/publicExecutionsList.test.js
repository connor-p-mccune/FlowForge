// GET /api/v1/workflows/:id/executions — run summaries for external pollers.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))

const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')

describe('GET /api/v1/workflows/:id/executions', () => {
  let jwt
  let pat
  let workflowId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'pubexec@example.com', password: 'password123', displayName: 'Poller' })
    jwt = res.body.token
    const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${jwt}`)
    const workspaceId = ws.body.workspaces[0].id

    const wf = await request(app)
      .post(`/api/workspaces/${workspaceId}/workflows`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ name: 'Pollable' })
    workflowId = wf.body.workflow.id

    const minted = await request(app)
      .post('/api/tokens')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ name: 'poller', scopes: ['read'] })
    pat = minted.body.token

    // Seed runs directly (the queue is mocked, so nothing executes).
    const insert = db.prepare(
      'INSERT INTO executions (id, workflow_id, status, trigger_type, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    for (let i = 0; i < 25; i++) {
      insert.run(
        uuidv4(),
        workflowId,
        i % 3 === 0 ? 'failed' : 'completed',
        'api',
        new Date(Date.now() - i * 60_000).toISOString()
      )
    }
  })

  it('returns newest-first summaries with the default page size', async () => {
    const res = await request(app)
      .get(`/api/v1/workflows/${workflowId}/executions`)
      .set('Authorization', `Bearer ${pat}`)
    expect(res.status).toBe(200)
    expect(res.body.executions).toHaveLength(20)
    const [first, second] = res.body.executions
    expect(first.createdAt >= second.createdAt).toBe(true)
    expect(first).toEqual(
      expect.objectContaining({ workflowId, triggerType: 'api' })
    )
    // Summaries only — no step or trigger payloads.
    expect(first).not.toHaveProperty('steps')
    expect(first).not.toHaveProperty('trigger_data')
  })

  it('clamps ?limit into [1, 100]', async () => {
    const small = await request(app)
      .get(`/api/v1/workflows/${workflowId}/executions?limit=3`)
      .set('Authorization', `Bearer ${pat}`)
    expect(small.body.executions).toHaveLength(3)

    const clamped = await request(app)
      .get(`/api/v1/workflows/${workflowId}/executions?limit=0`)
      .set('Authorization', `Bearer ${pat}`)
    expect(clamped.body.executions).toHaveLength(1)
  })

  it('requires the read scope and hides foreign workflows', async () => {
    const triggerOnly = await request(app)
      .post('/api/tokens')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ name: 'trigger-only', scopes: ['trigger'] })
    const denied = await request(app)
      .get(`/api/v1/workflows/${workflowId}/executions`)
      .set('Authorization', `Bearer ${triggerOnly.body.token}`)
    expect(denied.status).toBe(403)

    const unknown = await request(app)
      .get(`/api/v1/workflows/${uuidv4()}/executions`)
      .set('Authorization', `Bearer ${pat}`)
    expect(unknown.status).toBe(404)
  })
})
