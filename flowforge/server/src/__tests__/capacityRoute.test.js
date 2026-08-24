// The capacity report over both surfaces.
//
// Both read the same stored history — there is no "graph on screen" version of
// a question about arrival rates — so the split here is purely about who is
// asking: a session for the panel, a scoped token for a pipeline.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: jest.fn().mockResolvedValue(undefined) }) }))
jest.mock('../config/redis', () => ({ publish: jest.fn().mockResolvedValue(1) }))

const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')

const iso = (ms) => new Date(ms).toISOString()

// 336 runs over the week (two an hour), each holding a slot for 30 minutes:
// one erlang of offered load, into whatever cap the workflow has.
function seedRuns(workflowId, userId, { count = 336, serviceMs = 30 * 60000 } = {}) {
  const windowMs = 7 * 86400000
  const now = Date.now()
  const gap = windowMs / (count + 1)
  const insert = db.prepare(
    `INSERT INTO executions (id, workflow_id, status, triggered_by, created_at, started_at, finished_at)
     VALUES (?, ?, 'completed', ?, ?, ?, ?)`
  )
  for (let i = 0; i < count; i += 1) {
    const created = now - windowMs + gap * (i + 1)
    insert.run(uuidv4(), workflowId, userId, iso(created), iso(created), iso(created + serviceMs))
  }
}

describe('capacity endpoints', () => {
  let jwt
  let readToken
  let triggerToken
  let userId
  let workspaceId
  let workflowId
  let uncappedId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'capacity@example.com', password: 'password123', displayName: 'Cap' })
    jwt = res.body.token
    userId = db.prepare('SELECT id FROM users WHERE email = ?').get('capacity@example.com').id
    workspaceId = (
      await request(app).get('/api/workspaces').set('Authorization', `Bearer ${jwt}`)
    ).body.workspaces[0].id

    workflowId = uuidv4()
    db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, graph_json, max_concurrent_runs, status, created_by)
       VALUES (?, ?, 'Orders', '{"nodes":[],"edges":[]}', 2, 'deployed', ?)`
    ).run(workflowId, workspaceId, userId)
    seedRuns(workflowId, userId)

    uncappedId = uuidv4()
    db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by)
       VALUES (?, ?, 'Uncapped', '{"nodes":[],"edges":[]}', 'deployed', ?)`
    ).run(uncappedId, workspaceId, userId)

    readToken = (
      await request(app).post('/api/tokens').set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'reader', scopes: ['read'] })
    ).body.token
    triggerToken = (
      await request(app).post('/api/tokens').set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'runner', scopes: ['trigger'] })
    ).body.token
  })

  describe('GET /api/v1/workflows/:id/capacity', () => {
    const get = (query = '', id = workflowId, token = readToken) =>
      request(app)
        .get(`/api/v1/workflows/${id}/capacity${query}`)
        .set('Authorization', `Bearer ${token}`)

    it('reports what history measured and what the model predicts', async () => {
      const res = await get()
      expect(res.status).toBe(200)
      expect(res.body.available).toBe(true)
      expect(res.body.cap).toBe(2)
      expect(res.body.measured.arrivalsPerHour).toBeCloseTo(2, 0)
      expect(res.body.current.utilisation).toBeCloseTo(0.5, 1)
      expect(res.body.current.stable).toBe(true)
    })

    it('names the model and what M/M/c would have said', async () => {
      const res = await get()
      expect(res.body.model.name).toBe('Allen–Cunneen G/G/c')
      expect(typeof res.body.model.mmcWaitMeanMs).toBe('number')
    })

    it('grades its own prediction against the recorded wait', async () => {
      const res = await get()
      expect(res.body.calibration).toHaveProperty('verdict')
      expect(res.body.calibration).toHaveProperty('comparable')
    })

    it('sizes a cap when asked for a target', async () => {
      const res = await get('?target=1000')
      expect(res.body.recommendation.targetWaitMs).toBe(1000)
      expect(res.body.recommendation.servers).toBeGreaterThan(0)
      expect(res.body.recommendation).toHaveProperty('confident')
    })

    it('makes no recommendation when nobody asked for one', async () => {
      expect((await get()).body.recommendation).toBeNull()
      // The curve is still there for somebody to read.
      expect((await get()).body.curve.length).toBeGreaterThan(1)
    })

    it('prices a hypothetical cap without changing the stored one', async () => {
      const res = await get('?cap=12')
      expect(res.body.cap).toBe(12)
      const stored = db
        .prepare('SELECT max_concurrent_runs c FROM workflows WHERE id = ?')
        .get(workflowId)
      expect(stored.c).toBe(2)
    })

    it('says a workflow with no cap is not queueing at all', async () => {
      const res = await get('', uncappedId)
      expect(res.body).toMatchObject({ available: false, reason: 'no-cap' })
    })

    it('refuses a token without the read scope', async () => {
      expect((await get('', workflowId, triggerToken)).status).toBe(403)
    })

    it('404s for an unknown workflow', async () => {
      expect((await get('', uuidv4())).status).toBe(404)
    })

    it('ignores a nonsense target rather than failing the request', async () => {
      const res = await get('?target=soon')
      expect(res.status).toBe(200)
      expect(res.body.recommendation).toBeNull()
    })
  })

  describe('GET /api/workflows/:id/capacity', () => {
    it('answers the same question for the canvas', async () => {
      const res = await request(app)
        .get(`/api/workflows/${workflowId}/capacity?target=1000`)
        .set('Authorization', `Bearer ${jwt}`)
      expect(res.status).toBe(200)
      expect(res.body.available).toBe(true)
      expect(res.body.recommendation.servers).toBeGreaterThan(0)
    })

    it('404s for a workflow the caller is not a member of', async () => {
      const other = await request(app)
        .post('/api/auth/register')
        .send({ email: 'outsider-cap@example.com', password: 'password123', displayName: 'Out' })
      const res = await request(app)
        .get(`/api/workflows/${workflowId}/capacity`)
        .set('Authorization', `Bearer ${other.body.token}`)
      expect(res.status).toBe(404)
    })
  })
})
