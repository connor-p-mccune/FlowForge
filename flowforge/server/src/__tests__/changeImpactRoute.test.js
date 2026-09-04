// The change-impact report over both surfaces.
//
// Both take a candidate graph and compare it against the *deployed* one, which
// is the whole point: the question is what this edit changes rather than what
// the workflow is. The public form takes the same document contract lint and
// preview do, so a CI job that already has a .flow file can ask.

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

const n = (id, type, config = {}, label = id) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label, config },
})
const e = (source, target, sourceHandle) => ({
  id: `e-${source}-${target}${sourceHandle || ''}`,
  source,
  target,
  ...(sourceHandle ? { sourceHandle } : {}),
})

const NODES = [
  n('t', 'trigger-webhook', {}, 'Start'),
  n('a', 'approval', {}, 'Approve'),
  n('c', 'action-http', { method: 'POST', url: 'https://api.acme.com/charge' }, 'Charge card'),
]
const GATED = { nodes: NODES, edges: [e('t', 'a'), e('a', 'c', 'true')] }
// The one-line diff.
const UNGATED = { nodes: NODES, edges: [...GATED.edges, e('t', 'c')] }

describe('change impact endpoints', () => {
  let jwt
  let readToken
  let userId
  let workspaceId
  let workflowId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'impact@example.com', password: 'password123', displayName: 'Imp' })
    jwt = res.body.token
    userId = db.prepare('SELECT id FROM users WHERE email = ?').get('impact@example.com').id
    workspaceId = (
      await request(app).get('/api/workspaces').set('Authorization', `Bearer ${jwt}`)
    ).body.workspaces[0].id

    workflowId = uuidv4()
    db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, graph_json, guarantees_json, status, created_by)
       VALUES (?, ?, 'Orders', ?, ?, 'deployed', ?)`
    ).run(
      workflowId,
      workspaceId,
      JSON.stringify(GATED),
      JSON.stringify([{ kind: 'requires', node: 'c', other: 'a' }]),
      userId
    )

    readToken = (
      await request(app)
        .post('/api/tokens')
        .set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'reader', scopes: ['read'] })
    ).body.token
  })

  describe('POST /api/v1/workflows/:id/impact', () => {
    const post = (body, token = readToken) =>
      request(app)
        .post(`/api/v1/workflows/${workflowId}/impact`)
        .set('Authorization', `Bearer ${token}`)
        .send(body)

    it('reports what a one-line edit does to a payment path', async () => {
      const res = await post({ graph_data: UNGATED })
      expect(res.status).toBe(200)
      expect(res.body.name).toBe('Orders')
      expect(res.body.findings[0]).toMatchObject({
        code: 'ungated-effect',
        nodeId: 'c',
        blocking: false,
      })
      expect(res.body.summary.verdict).toBe('blocked')
    })

    it('checks the candidate against the guarantees the target workspace declares', async () => {
      // Not the ones in the file — the ones production is relying on.
      const codes = (await post({ graph_data: UNGATED })).body.findings.map((f) => f.code)
      expect(codes).toContain('guarantee-broken')
    })

    it('reports nothing for the graph that is already deployed', async () => {
      const res = await post({ graph_data: GATED })
      expect(res.body.findings).toEqual([])
      expect(res.body.summary.verdict).toBe('clear')
    })

    it('rejects a body with no graph in it', async () => {
      expect((await post({})).status).toBe(400)
      expect((await post({ graph_data: { nodes: [] } })).status).toBe(400)
    })

    it('refuses a graph too large to analyse', async () => {
      const huge = { nodes: new Array(2001).fill(n('x', 'transform')), edges: [] }
      expect((await post({ graph_data: huge })).status).toBe(400)
    })

    it('refuses a token with no read scope', async () => {
      const writeOnly = (
        await request(app)
          .post('/api/tokens')
          .set('Authorization', `Bearer ${jwt}`)
          .send({ name: 'runner', scopes: ['trigger'] })
      ).body.token
      expect((await post({ graph_data: GATED }, writeOnly)).status).toBe(403)
    })

    it('404s a workflow the token cannot see', async () => {
      const res = await request(app)
        .post(`/api/v1/workflows/${uuidv4()}/impact`)
        .set('Authorization', `Bearer ${readToken}`)
        .send({ graph_data: GATED })
      expect(res.status).toBe(404)
    })
  })

  describe('POST /api/workflows/:id/impact', () => {
    const post = (body, token = jwt) =>
      request(app)
        .post(`/api/workflows/${workflowId}/impact`)
        .set('Authorization', `Bearer ${token}`)
        .send(body)

    it('answers the same question for the canvas, from the graph on screen', async () => {
      const res = await post(UNGATED)
      expect(res.status).toBe(200)
      expect(res.body.findings.map((f) => f.code)).toContain('ungated-effect')
    })

    it('compares against the deployed graph, not the one it was sent', async () => {
      // Sending the deployed graph back must report no change at all.
      expect((await post(GATED)).body.summary.verdict).toBe('clear')
    })

    it('requires a graph', async () => {
      expect((await post({})).status).toBe(400)
    })

    it('404s a workflow the caller is not a member of', async () => {
      const outsider = (
        await request(app)
          .post('/api/auth/register')
          .send({ email: 'outsider-i@example.com', password: 'password123', displayName: 'Out' })
      ).body.token
      expect((await post(GATED, outsider)).status).toBe(404)
    })
  })
})
