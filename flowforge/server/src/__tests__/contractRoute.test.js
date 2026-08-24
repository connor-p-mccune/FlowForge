// The contract report over both surfaces.
//
// The session route judges the graph on the canvas, because the author who
// breaks a contract is not the author who finds out and the answer has to
// arrive before the save. The public POST judges a candidate *document* against
// the target workspace, which is the promotion gate: would importing this file
// stop somebody else's reference from resolving?

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: jest.fn().mockResolvedValue(undefined) }) }))
jest.mock('../config/redis', () => ({ publish: jest.fn().mockResolvedValue(1) }))

const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')

const node = (id, type, config = {}, label = id) => ({
  id, type, position: { x: 0, y: 0 }, data: { label, config },
})
const edge = (source, target) => ({ id: `${source}-${target}`, source, target })

const callee = (template) => ({
  nodes: [
    node('t1', 'trigger-manual'),
    node('shape', 'transform', { template }),
    node('out', 'output-return', { value: '{{shape}}' }),
  ],
  edges: [edge('t1', 'shape'), edge('shape', 'out')],
})

const SHAPE = '{"orderId": "abc", "total": 10}'

describe('contract endpoints', () => {
  let jwt
  let readToken
  let triggerToken
  let calleeId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'contract@example.com', password: 'password123', displayName: 'Con' })
    jwt = res.body.token
    const userId = db.prepare('SELECT id FROM users WHERE email = ?').get('contract@example.com').id
    const workspaceId = (
      await request(app).get('/api/workspaces').set('Authorization', `Bearer ${jwt}`)
    ).body.workspaces[0].id

    const insert = db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by)
       VALUES (?, ?, ?, ?, 'deployed', ?)`
    )
    calleeId = uuidv4()
    insert.run(calleeId, workspaceId, 'Fulfilment', JSON.stringify(callee(SHAPE)), userId)

    insert.run(
      uuidv4(),
      workspaceId,
      'Orders',
      JSON.stringify({
        nodes: [
          node('t1', 'trigger-manual'),
          node('call', 'sub-workflow', { workflowId: calleeId }, 'Fulfil order'),
          node('ship', 'action-http', { url: 'https://x.dev/{{call.orderId}}' }, 'Notify carrier'),
        ],
        edges: [edge('t1', 'call'), edge('call', 'ship')],
      }),
      userId
    )

    readToken = (
      await request(app).post('/api/tokens').set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'reader', scopes: ['read'] })
    ).body.token
    triggerToken = (
      await request(app).post('/api/tokens').set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'runner', scopes: ['trigger'] })
    ).body.token
  })

  describe('GET /api/v1/workflows/:id/contract', () => {
    const get = (id = calleeId, token = readToken) =>
      request(app).get(`/api/v1/workflows/${id}/contract`).set('Authorization', `Bearer ${token}`)

    it('reports the promise and who depends on it', async () => {
      const res = await get()
      expect(res.status).toBe(200)
      expect(res.body.before.fields).toEqual(['orderId', 'total'])
      expect(res.body.callers.map((c) => c.name)).toEqual(['Orders'])
    })

    it('is compatible with itself, since nothing changed', async () => {
      expect((await get()).body.summary).toMatchObject({ verdict: 'compatible', broken: 0 })
    })

    it('refuses a token without the read scope', async () => {
      expect((await get(calleeId, triggerToken)).status).toBe(403)
    })

    it('404s for an unknown workflow', async () => {
      expect((await get(uuidv4())).status).toBe(404)
    })
  })

  describe('POST /api/v1/workflows/:id/contract', () => {
    const post = (body) =>
      request(app)
        .post(`/api/v1/workflows/${calleeId}/contract`)
        .set('Authorization', `Bearer ${readToken}`)
        .send(body)

    it('names the caller a candidate would break', async () => {
      const res = await post({ graph_data: callee('{"total": 10}') })
      expect(res.status).toBe(200)
      expect(res.body.summary).toMatchObject({ verdict: 'breaking', broken: 1, references: 1 })
      expect(res.body.callers[0].breaks[0].reference).toBe('call.orderId')
    })

    it('accepts the .flow text form, like lint and preview', async () => {
      const exported = await request(app)
        .get(`/api/v1/workflows/${calleeId}/export?format=flow`)
        .set('Authorization', `Bearer ${readToken}`)
      expect(exported.status).toBe(200)
      const res = await post({ flow: exported.text })
      expect(res.status).toBe(200)
      // The workflow's own export cannot break its own contract.
      expect(res.body.summary.broken).toBe(0)
    })

    it('reports a syntax error with the line it is on', async () => {
      const res = await post({ flow: 'workflow "Broken"\n  node !!!\n' })
      expect(res.status).toBe(400)
      expect(res.body).toHaveProperty('line')
    })

    it('calls an added field additive and breaks nobody', async () => {
      const res = await post({
        graph_data: callee('{"orderId": "abc", "total": 10, "carrier": "dhl"}'),
      })
      expect(res.body.summary).toMatchObject({ verdict: 'additive', broken: 0 })
    })

    it('rejects a body that is not a graph', async () => {
      expect((await post({ graph_data: { nodes: 'nope' } })).status).toBe(400)
    })

    it('refuses a graph too large to analyse', async () => {
      const nodes = Array.from({ length: 2001 }, (_, i) => node(`n${i}`, 'transform'))
      expect((await post({ graph_data: { nodes, edges: [] } })).status).toBe(400)
    })
  })

  describe('POST /api/workflows/:id/contract', () => {
    it('judges the graph on the canvas', async () => {
      const res = await request(app)
        .post(`/api/workflows/${calleeId}/contract`)
        .set('Authorization', `Bearer ${jwt}`)
        .send(callee('{"total": 10}'))
      expect(res.status).toBe(200)
      expect(res.body.summary.broken).toBe(1)
      expect(res.body.callers[0].breaks[0].suggestion).toBeNull()
    })

    it('reads the current contract when given no graph', async () => {
      const res = await request(app)
        .post(`/api/workflows/${calleeId}/contract`)
        .set('Authorization', `Bearer ${jwt}`)
        .send({})
      expect(res.body.summary.verdict).toBe('compatible')
      expect(res.body.before.fields).toEqual(['orderId', 'total'])
    })

    it('404s for a workflow the caller is not a member of', async () => {
      const other = await request(app)
        .post('/api/auth/register')
        .send({ email: 'outsider-con@example.com', password: 'password123', displayName: 'Out' })
      const res = await request(app)
        .post(`/api/workflows/${calleeId}/contract`)
        .set('Authorization', `Bearer ${other.body.token}`)
        .send(callee(SHAPE))
      expect(res.status).toBe(404)
    })
  })
})
