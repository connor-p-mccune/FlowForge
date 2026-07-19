// Per-workflow rate limiting: cap how many runs may *start* within a rolling
// window, independent of the concurrency cap. Enforced at the shared admitRun
// gate, so every entry point is covered; dry runs are exempt; the window
// slides by created_at.

const request = require('supertest')
const { v4: uuidv4 } = require('uuid')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))

const { app } = require('../index')
const db = require('../config/database')
const { admitRun } = require('../services/concurrencyGate')

// Seed an execution row directly with a chosen created_at + trigger type, so
// window and dry-run behavior can be tested without driving the queue.
function seedRun(workflowId, { createdAt, triggerType = 'manual', status = 'completed' } = {}) {
  db.prepare(
    'INSERT INTO executions (id, workflow_id, status, trigger_type, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(uuidv4(), workflowId, status, triggerType, createdAt || new Date().toISOString())
}

describe('per-workflow rate limiting', () => {
  let jwt
  let workspaceId
  let workflowId

  const authed = (req) => req.set('Authorization', `Bearer ${jwt}`)

  beforeAll(async () => {
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ email: 'rate@example.com', password: 'password123', displayName: 'Rater' })
    jwt = reg.body.token
    workspaceId = (await authed(request(app).get('/api/workspaces'))).body.workspaces[0].id
    const wf = await authed(request(app).post(`/api/workspaces/${workspaceId}/workflows`))
      .send({ name: 'Throttled' })
    workflowId = wf.body.workflow.id
    await authed(request(app).put(`/api/workflows/${workflowId}/graph`)).send({
      nodes: [{ id: 't1', type: 'trigger-manual', position: { x: 0, y: 0 }, data: { config: {} } }],
      edges: [],
    })
  })

  beforeEach(() => {
    mockAdd.mockClear()
    db.prepare('DELETE FROM executions WHERE workflow_id = ?').run(workflowId)
  })

  describe('admitRun (the gate)', () => {
    const rl = (over = {}) => ({
      id: workflowId,
      name: 'Throttled',
      rate_limit_max: 3,
      rate_limit_window_seconds: 60,
      ...over,
    })

    it('admits runs under the limit and refuses at it', () => {
      seedRun(workflowId)
      seedRun(workflowId)
      expect(admitRun(rl()).ok).toBe(true) // 2 in window, limit 3

      seedRun(workflowId)
      const refused = admitRun(rl())
      expect(refused.ok).toBe(false)
      expect(refused.reason).toBe('rate_limit')
      expect(refused.error).toMatch(/Rate limit reached/)
    })

    it('ignores runs older than the window', () => {
      const old = new Date(Date.now() - 120 * 1000).toISOString() // outside a 60s window
      seedRun(workflowId, { createdAt: old })
      seedRun(workflowId, { createdAt: old })
      seedRun(workflowId, { createdAt: old })
      expect(admitRun(rl()).ok).toBe(true) // all three fell out of the window
    })

    it('does not count dry runs toward the limit', () => {
      seedRun(workflowId, { triggerType: 'dry-run' })
      seedRun(workflowId, { triggerType: 'dry-run' })
      seedRun(workflowId, { triggerType: 'dry-run' })
      seedRun(workflowId, { triggerType: 'manual' })
      expect(admitRun(rl()).ok).toBe(true) // only the one manual run counts
    })

    it('is off when either field is unset', () => {
      for (let i = 0; i < 10; i++) seedRun(workflowId)
      expect(admitRun(rl({ rate_limit_max: null })).ok).toBe(true)
      expect(admitRun(rl({ rate_limit_window_seconds: null })).ok).toBe(true)
    })
  })

  describe('through the run entry points', () => {
    beforeEach(async () => {
      await authed(request(app).put(`/api/workflows/${workflowId}`)).send({
        name: 'Throttled',
        rate_limit_max: 2,
        rate_limit_window_seconds: 3600,
      })
    })

    afterEach(async () => {
      // Clear the limit so other blocks aren't affected.
      await authed(request(app).put(`/api/workflows/${workflowId}`)).send({
        name: 'Throttled',
        rate_limit_max: null,
        rate_limit_window_seconds: null,
      })
    })

    it('refuses a manual run over the limit with a 409, dry runs excepted', async () => {
      expect((await authed(request(app).post(`/api/workflows/${workflowId}/execute`))).status).toBe(202)
      expect((await authed(request(app).post(`/api/workflows/${workflowId}/execute`))).status).toBe(202)
      const third = await authed(request(app).post(`/api/workflows/${workflowId}/execute`))
      expect(third.status).toBe(409)
      expect(third.body.error).toMatch(/Rate limit reached/)

      // A dry run is exempt and still starts even while rate-limited.
      const dry = await authed(request(app).post(`/api/workflows/${workflowId}/test`))
      expect(dry.status).toBe(202)
    })
  })

  describe('PUT validation', () => {
    it('rejects out-of-range values', async () => {
      const badMax = await authed(request(app).put(`/api/workflows/${workflowId}`)).send({
        name: 'Throttled', rate_limit_max: 0, rate_limit_window_seconds: 60,
      })
      expect(badMax.status).toBe(400)

      const badWindow = await authed(request(app).put(`/api/workflows/${workflowId}`)).send({
        name: 'Throttled', rate_limit_max: 5, rate_limit_window_seconds: 999999,
      })
      expect(badWindow.status).toBe(400)
    })

    it('enforces both-or-neither', async () => {
      const onlyMax = await authed(request(app).put(`/api/workflows/${workflowId}`)).send({
        name: 'Throttled', rate_limit_max: 5, rate_limit_window_seconds: null,
      })
      expect(onlyMax.status).toBe(400)
      expect(onlyMax.body.error).toMatch(/set together/)
    })

    it('persists a valid pair and clears it', async () => {
      const set = await authed(request(app).put(`/api/workflows/${workflowId}`)).send({
        name: 'Throttled', rate_limit_max: 10, rate_limit_window_seconds: 60,
      })
      expect(set.status).toBe(200)
      expect(set.body.workflow.rate_limit_max).toBe(10)
      expect(set.body.workflow.rate_limit_window_seconds).toBe(60)

      const cleared = await authed(request(app).put(`/api/workflows/${workflowId}`)).send({
        name: 'Throttled', rate_limit_max: null, rate_limit_window_seconds: null,
      })
      expect(cleared.body.workflow.rate_limit_max).toBeNull()
      expect(cleared.body.workflow.rate_limit_window_seconds).toBeNull()
    })
  })
})
