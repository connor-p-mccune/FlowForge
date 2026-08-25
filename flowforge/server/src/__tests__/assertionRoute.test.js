// The run assertion endpoints.
//
// The behaviour worth pinning at this layer is what happens to a predicate
// that does not parse: it is refused rather than stored, because a stored one
// that cannot be evaluated is silently green forever.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: jest.fn().mockResolvedValue(undefined) }) }))
jest.mock('../config/redis', () => ({ publish: jest.fn().mockResolvedValue(1) }))

const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')
const { checkRun } = require('../services/runAssertions')

const iso = (ms) => new Date(ms).toISOString()

describe('assertion endpoints', () => {
  let jwt
  let userId
  let workflowId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'assert@example.com', password: 'password123', displayName: 'A' })
    jwt = res.body.token
    userId = db.prepare('SELECT id FROM users WHERE email = ?').get('assert@example.com').id
    const workspaceId = (
      await request(app).get('/api/workspaces').set('Authorization', `Bearer ${jwt}`)
    ).body.workspaces[0].id

    workflowId = uuidv4()
    db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by)
       VALUES (?, ?, 'Orders', '{"nodes":[],"edges":[]}', 'deployed', ?)`
    ).run(workflowId, workspaceId, userId)
  })

  beforeEach(() => {
    db.prepare('DELETE FROM workflow_assertions WHERE workflow_id = ?').run(workflowId)
  })

  const asUser = (req) => req.set('Authorization', `Bearer ${jwt}`)
  const create = (body) =>
    asUser(request(app).post(`/api/workflows/${workflowId}/assertions`)).send(body)
  const report = () => asUser(request(app).get(`/api/workflows/${workflowId}/assertions`))

  const seedRun = (status = 'completed') => {
    const id = uuidv4()
    const now = Date.now()
    db.prepare(
      `INSERT INTO executions (id, workflow_id, status, triggered_by, created_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, workflowId, status, userId, iso(now), iso(now), iso(now + 100))
    return id
  }

  describe('POST /api/workflows/:id/assertions', () => {
    it('pins an assertion', async () => {
      const res = await create({ name: 'no 5xx', predicate: 'steps.charge.output.status >= 500' })
      expect(res.status).toBe(201)
      expect(res.body.assertion.name).toBe('no 5xx')
      expect(res.body.assertion.enabled).toBe(1)
    })

    it('refuses a predicate that does not parse', async () => {
      const res = await create({ name: 'bad', predicate: 'status ==' })
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/does not parse/)
    })

    it('requires a name and a predicate', async () => {
      expect((await create({ predicate: 'true' })).status).toBe(400)
      expect((await create({ name: 'x' })).status).toBe(400)
    })

    it('404s for a workflow the caller is not a member of', async () => {
      const other = await request(app)
        .post('/api/auth/register')
        .send({ email: 'outsider-a@example.com', password: 'password123', displayName: 'O' })
      const res = await request(app)
        .post(`/api/workflows/${workflowId}/assertions`)
        .set('Authorization', `Bearer ${other.body.token}`)
        .send({ name: 'x', predicate: 'true' })
      expect(res.status).toBe(404)
    })
  })

  describe('GET /api/workflows/:id/assertions', () => {
    it('reports what is pinned and whether it is holding', async () => {
      await create({ name: 'never completed', predicate: 'status == "completed"' })
      checkRun(seedRun('failed'), { notify: false })

      const res = await report()
      expect(res.status).toBe(200)
      expect(res.body.summary).toMatchObject({ total: 1, holding: 1, violated: 0 })
    })

    it('reports a violation with the run that caused it', async () => {
      await create({ name: 'never completed', predicate: 'status == "completed"' })
      const bad = seedRun('completed')
      checkRun(bad, { notify: false })

      const res = await report()
      expect(res.body.summary.violated).toBe(1)
      expect(res.body.assertions[0].lastViolationExecutionId).toBe(bad)
    })

    it('never folds a broken assertion into the holding count', async () => {
      await create({ name: 'broken', predicate: 'first(trigger.total) > 0' })
      checkRun(seedRun(), { notify: false })
      const res = await report()
      expect(res.body.summary).toMatchObject({ broken: 1, holding: 0 })
      expect(res.body.assertions[0].lastError).toBeTruthy()
    })

    it('is empty for a workflow with none', async () => {
      expect((await report()).body.summary.total).toBe(0)
    })
  })

  describe('PUT /api/assertions/:id', () => {
    const put = (id, body) => asUser(request(app).put(`/api/assertions/${id}`)).send(body)

    it('renames without losing the record', async () => {
      const { body } = await create({ name: 'old', predicate: 'status == "never"' })
      checkRun(seedRun('failed'), { notify: false })
      const res = await put(body.assertion.id, { name: 'new' })
      expect(res.body.assertion.name).toBe('new')
      expect(res.body.assertion.ok_count).toBeGreaterThan(0)
    })

    it('resets the record when the predicate changes', async () => {
      const { body } = await create({ name: 'x', predicate: 'status == "never"' })
      checkRun(seedRun('failed'), { notify: false })
      const res = await put(body.assertion.id, { predicate: 'status == "other"' })
      expect(res.body.assertion.ok_count).toBe(0)
    })

    it('refuses an edit that would make it unparseable', async () => {
      const { body } = await create({ name: 'x', predicate: 'true' })
      expect((await put(body.assertion.id, { predicate: 'status ==' })).status).toBe(400)
    })

    it('disables one', async () => {
      const { body } = await create({ name: 'x', predicate: 'true' })
      expect((await put(body.assertion.id, { enabled: false })).body.assertion.enabled).toBe(0)
    })

    it('404s for an assertion the caller cannot reach', async () => {
      expect((await put(uuidv4(), { name: 'x' })).status).toBe(404)
    })

    it('404s for another workspace\'s assertion, resolved through its workflow', async () => {
      // Assertion ids are opaque, so ownership is resolved through the workflow
      // rather than trusted from the path.
      const { body } = await create({ name: 'x', predicate: 'true' })
      const other = await request(app)
        .post('/api/auth/register')
        .send({ email: 'outsider-a2@example.com', password: 'password123', displayName: 'O' })
      const res = await request(app)
        .put(`/api/assertions/${body.assertion.id}`)
        .set('Authorization', `Bearer ${other.body.token}`)
        .send({ name: 'hijacked' })
      expect(res.status).toBe(404)
    })
  })

  describe('DELETE /api/assertions/:id', () => {
    it('removes it', async () => {
      const { body } = await create({ name: 'x', predicate: 'true' })
      const res = await asUser(request(app).delete(`/api/assertions/${body.assertion.id}`))
      expect(res.status).toBe(200)
      expect((await report()).body.summary.total).toBe(0)
    })

    it('404s for an unknown id', async () => {
      expect((await asUser(request(app).delete(`/api/assertions/${uuidv4()}`))).status).toBe(404)
    })
  })
})

// The public read, which is the CI shape. The number a pipeline gates on is
// `violated + broken`: an assertion nobody can evaluate is a gap in the
// monitoring, and a build that passed on it would be passing on a check that
// has never once worked.
describe('GET /api/v1/workflows/:id/assertions', () => {
  let jwt
  let readToken
  let triggerToken
  let userId
  let workflowId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'assert-public@example.com', password: 'password123', displayName: 'P' })
    jwt = res.body.token
    userId = db.prepare('SELECT id FROM users WHERE email = ?').get('assert-public@example.com').id
    const workspaceId = (
      await request(app).get('/api/workspaces').set('Authorization', `Bearer ${jwt}`)
    ).body.workspaces[0].id

    workflowId = uuidv4()
    db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by)
       VALUES (?, ?, 'Public', '{"nodes":[],"edges":[]}', 'deployed', ?)`
    ).run(workflowId, workspaceId, userId)

    readToken = (
      await request(app).post('/api/tokens').set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'reader', scopes: ['read'] })
    ).body.token
    triggerToken = (
      await request(app).post('/api/tokens').set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'runner', scopes: ['trigger'] })
    ).body.token

    await request(app)
      .post(`/api/workflows/${workflowId}/assertions`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ name: 'never completed', predicate: 'status == "completed"' })
  })

  const get = (id = workflowId, token = readToken) =>
    request(app).get(`/api/v1/workflows/${id}/assertions`).set('Authorization', `Bearer ${token}`)

  it('reports what is pinned', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.body.summary.total).toBe(1)
    expect(res.body.assertions[0].name).toBe('never completed')
  })

  it('refuses a token without the read scope', async () => {
    expect((await get(workflowId, triggerToken)).status).toBe(403)
  })

  it('404s for an unknown workflow', async () => {
    expect((await get(uuidv4())).status).toBe(404)
  })
})
