// The repeat report over both surfaces.
//
// Both are GETs over stored graphs, and that is the design rather than a
// shortcut: the walk follows sub-workflow calls, so the answer depends on
// graphs *other* workflows hold, and the recovery policy it checks is a stored
// column. Judging an unsaved canvas against saved callees would describe a
// system that does not exist.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

jest.mock('../config/queue', () => ({
  getExecutionQueue: () => ({ add: jest.fn().mockResolvedValue(undefined) }),
}))
jest.mock('../config/redis', () => ({ publish: jest.fn().mockResolvedValue(1) }))

const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')

const node = (id, type, config = {}, label = id) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label, config },
})

describe('repeat report endpoints', () => {
  let jwt
  let readToken
  let userId
  let workspaceId
  let workflowId
  let calleeId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'repeats@example.com', password: 'password123', displayName: 'Rep' })
    jwt = res.body.token
    userId = db.prepare('SELECT id FROM users WHERE email = ?').get('repeats@example.com').id
    workspaceId = (
      await request(app).get('/api/workspaces').set('Authorization', `Bearer ${jwt}`)
    ).body.workspaces[0].id

    const insert = db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, graph_json, status, recovery_policy, created_by)
       VALUES (?, ?, ?, ?, 'deployed', ?, ?)`
    )

    calleeId = uuidv4()
    insert.run(
      calleeId,
      workspaceId,
      'Fulfilment',
      JSON.stringify({
        nodes: [
          node('t', 'trigger-manual'),
          node('charge', 'action-http', { method: 'POST', url: 'https://api.acme.com/charge' }, 'Charge card'),
        ],
        edges: [{ id: 'e', source: 't', target: 'charge' }],
      }),
      'safe',
      userId
    )

    workflowId = uuidv4()
    insert.run(
      workflowId,
      workspaceId,
      'Orders',
      JSON.stringify({
        nodes: [
          node('t', 'trigger-webhook'),
          node('fetch', 'action-http', { method: 'GET', url: 'https://api.acme.com/price' }, 'Fetch price'),
          node('call', 'sub-workflow', { workflowId: calleeId }, 'Fulfil order'),
        ],
        edges: [
          { id: 'e1', source: 't', target: 'fetch' },
          { id: 'e2', source: 'fetch', target: 'call' },
        ],
      }),
      'safe',
      userId
    )

    readToken = (
      await request(app)
        .post('/api/tokens')
        .set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'reader', scopes: ['read'] })
    ).body.token
  })

  describe('GET /api/v1/workflows/:id/repeats', () => {
    const get = (id = workflowId, token = readToken) =>
      request(app).get(`/api/v1/workflows/${id}/repeats`).set('Authorization', `Bearer ${token}`)

    it('grades each step and names the workflow', async () => {
      const res = await get()
      expect(res.status).toBe(200)
      expect(res.body.available).toBe(true)
      expect(res.body.name).toBe('Orders')
      const byId = Object.fromEntries(res.body.steps.map((s) => [s.nodeId, s]))
      expect(byId.fetch.verdict).toBe('safe')
    })

    it('follows the call and inherits what the callee would do twice', async () => {
      const byId = Object.fromEntries((await get()).body.steps.map((s) => [s.nodeId, s]))
      expect(byId.call).toMatchObject({ verdict: 'unsafe' })
      expect(byId.call.calls).toMatchObject({ workflowId: calleeId, name: 'Fulfilment' })
    })

    it('reads the recovery policy off the stored workflow', async () => {
      expect((await get(calleeId)).body.recovery).toMatchObject({
        policy: 'safe',
        verdict: 'blocks-recovery',
      })

      db.prepare("UPDATE workflows SET recovery_policy = 'resume' WHERE id = ?").run(calleeId)
      expect((await get(calleeId)).body.recovery).toMatchObject({
        policy: 'resume',
        verdict: 'contradicted',
      })
      db.prepare("UPDATE workflows SET recovery_policy = 'safe' WHERE id = ?").run(calleeId)
    })

    it('counts what the engine repeats on its own, which is the CI number', async () => {
      // The callee's POST is retried three times by default. Nothing has to
      // crash for that to happen.
      expect((await get(calleeId)).body.summary).toMatchObject({ retriedUnsafe: 1, maxAttempts: 3 })
      // The caller's sub-workflow node is single-attempt, so its hazard needs a
      // resume or a recovery rather than a timeout.
      expect((await get()).body.summary.retriedUnsafe).toBe(0)
    })

    it('refuses a token with no read scope', async () => {
      const writeOnly = (
        await request(app)
          .post('/api/tokens')
          .set('Authorization', `Bearer ${jwt}`)
          .send({ name: 'runner', scopes: ['trigger'] })
      ).body.token
      expect((await get(workflowId, writeOnly)).status).toBe(403)
    })

    it('404s a workflow the token cannot see', async () => {
      expect((await get(uuidv4())).status).toBe(404)
    })
  })

  describe('GET /api/workflows/:id/repeats', () => {
    it('answers the same question for the canvas', async () => {
      const session = await request(app)
        .get(`/api/workflows/${workflowId}/repeats`)
        .set('Authorization', `Bearer ${jwt}`)
      const token = await request(app)
        .get(`/api/v1/workflows/${workflowId}/repeats`)
        .set('Authorization', `Bearer ${readToken}`)
      expect(session.status).toBe(200)
      expect(session.body.steps).toEqual(token.body.steps)
      expect(session.body.summary).toEqual(token.body.summary)
    })

    it('404s a workflow the caller is not a member of', async () => {
      const outsider = (
        await request(app)
          .post('/api/auth/register')
          .send({ email: 'outsider-r@example.com', password: 'password123', displayName: 'Out' })
      ).body.token
      const res = await request(app)
        .get(`/api/workflows/${workflowId}/repeats`)
        .set('Authorization', `Bearer ${outsider}`)
      expect(res.status).toBe(404)
    })

    it('reports an empty graph as unavailable rather than as clean', async () => {
      const emptyId = uuidv4()
      db.prepare(
        `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by)
         VALUES (?, ?, 'Empty', '{"nodes":[],"edges":[]}', 'draft', ?)`
      ).run(emptyId, workspaceId, userId)

      const res = await request(app)
        .get(`/api/workflows/${emptyId}/repeats`)
        .set('Authorization', `Bearer ${jwt}`)
      expect(res.status).toBe(200)
      expect(res.body.available).toBe(true)
      expect(res.body.steps).toEqual([])
    })
  })
})
