// The workspace exposure report over both surfaces.
//
// Both read the same stored history — there is no "graph on screen" version of
// a question about a whole workspace — so the split is purely about who is
// asking: a session for the dashboard, a scoped token for the Monday post or
// the CI gate.

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

const DAY_MS = 86400000

const GRAPH = {
  nodes: [
    { id: 'trigger', type: 'trigger-webhook', data: { label: 'Start', config: {} } },
    {
      id: 'charge',
      type: 'action-http',
      data: { label: 'Charge card', config: { url: 'https://api.acme.com/charge', method: 'POST' } },
    },
  ],
  edges: [{ id: 'e0', source: 'trigger', target: 'charge' }],
}

describe('workspace exposure endpoints', () => {
  let jwt
  let readToken
  let userId
  let workspaceId
  let workflowId
  let otherJwt

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'exposure@example.com', password: 'password123', displayName: 'Ex' })
    jwt = res.body.token
    userId = db.prepare('SELECT id FROM users WHERE email = ?').get('exposure@example.com').id
    workspaceId = (
      await request(app).get('/api/workspaces').set('Authorization', `Bearer ${jwt}`)
    ).body.workspaces[0].id

    workflowId = uuidv4()
    db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by)
       VALUES (?, ?, 'Payments', ?, 'deployed', ?)`
    ).run(workflowId, workspaceId, JSON.stringify(GRAPH), userId)

    const insert = db.prepare(
      `INSERT INTO executions (id, workflow_id, status, created_at) VALUES (?, ?, 'completed', ?)`
    )
    for (let i = 0; i < 100; i += 1) {
      insert.run(uuidv4(), workflowId, new Date(Date.now() - (10 - i / 10) * DAY_MS).toISOString())
    }

    readToken = (
      await request(app)
        .post('/api/tokens')
        .set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'reader', scopes: ['read'] })
    ).body.token

    otherJwt = (
      await request(app)
        .post('/api/auth/register')
        .send({ email: 'outsider@example.com', password: 'password123', displayName: 'Out' })
    ).body.token
  })

  describe('GET /api/workspaces/:id/exposure', () => {
    const get = (query = '', token = jwt) =>
      request(app)
        .get(`/api/workspaces/${workspaceId}/exposure${query}`)
        .set('Authorization', `Bearer ${token}`)

    it('ranks the workspace and names the queue', async () => {
      const res = await get()
      expect(res.status).toBe(200)
      expect(res.body.workflows[0].workflowId).toBe(workflowId)
      expect(res.body.workflows[0].exposure.ceiling).toBeGreaterThan(0)
      expect(res.body.queue).toEqual([workflowId])
      expect(res.body.summary.uncheckedShare).toBe(1)
    })

    it('accepts a window and reports the one it used', async () => {
      expect((await get('?days=7')).body.windowDays).toBe(7)
    })

    it('clamps a window nobody could mean', async () => {
      // A rate needs at least a day, and a year of history is not this
      // workspace.
      expect((await get('?days=0')).body.windowDays).toBe(1)
      expect((await get('?days=9999')).body.windowDays).toBe(90)
      expect((await get('?days=nonsense')).body.windowDays).toBe(30)
    })

    it('hides a workspace the caller is not in', async () => {
      expect((await get('', otherJwt)).status).toBe(404)
    })

    it('needs a session', async () => {
      expect((await request(app).get(`/api/workspaces/${workspaceId}/exposure`)).status).toBe(401)
    })
  })

  describe('GET /api/v1/workspaces/:id/exposure', () => {
    const get = (query = '', token = readToken) =>
      request(app)
        .get(`/api/v1/workspaces/${workspaceId}/exposure${query}`)
        .set('Authorization', `Bearer ${token}`)

    it('gives a pipeline the same answer the app gets', async () => {
      const viaToken = (await get()).body
      const viaSession = (
        await request(app)
          .get(`/api/workspaces/${workspaceId}/exposure`)
          .set('Authorization', `Bearer ${jwt}`)
      ).body
      expect(viaToken.queue).toEqual(viaSession.queue)
      expect(viaToken.summary).toEqual(viaSession.summary)
    })

    it('refuses a token with no read scope', async () => {
      const writeOnly = (
        await request(app)
          .post('/api/tokens')
          .set('Authorization', `Bearer ${jwt}`)
          .send({ name: 'runner', scopes: ['trigger'] })
      ).body.token
      expect((await get('', writeOnly)).status).toBe(403)
    })

    it('hides a workspace the token cannot see', async () => {
      const res = await request(app)
        .get(`/api/v1/workspaces/${uuidv4()}/exposure`)
        .set('Authorization', `Bearer ${readToken}`)
      expect(res.status).toBe(404)
    })
  })
})
