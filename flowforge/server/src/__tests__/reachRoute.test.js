// The transitive effect endpoints.
//
// A GET rather than the body-taking POST its neighbours use, and for a reason
// specific to this analysis: the answer depends on graphs *other* workflows
// hold, so judging the canvas on screen would mix an unsaved graph with saved
// callees and describe a system that does not exist.

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
const edge = (source, target, sourceHandle = null) => ({
  id: `${source}-${target}${sourceHandle ? `-${sourceHandle}` : ''}`, source, target, sourceHandle,
})

describe('transitive effect endpoints', () => {
  let jwt
  let readToken
  let triggerToken
  let userId
  let workspaceId
  let ordersId
  let fulfilId

  const insert = (id, name, graph, ws) =>
    db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by)
       VALUES (?, ?, ?, ?, 'deployed', ?)`
    ).run(id, ws ?? workspaceId, name, JSON.stringify(graph), userId)

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'reach@example.com', password: 'password123', displayName: 'R' })
    jwt = res.body.token
    userId = db.prepare('SELECT id FROM users WHERE email = ?').get('reach@example.com').id
    workspaceId = (
      await request(app).get('/api/workspaces').set('Authorization', `Bearer ${jwt}`)
    ).body.workspaces[0].id

    fulfilId = uuidv4()
    ordersId = uuidv4()

    insert(fulfilId, 'Fulfilment', {
      nodes: [
        node('t', 'trigger-manual'),
        node('stock', 'condition', { operator: 'expression', expression: 'inStock' }, 'In stock?'),
        node('charge', 'action-http', { url: 'https://api.acme.com/charges' }, 'Charge card'),
        node('back', 'output-log', { message: 'backorder' }, 'Backorder'),
      ],
      edges: [edge('t', 'stock'), edge('stock', 'charge', 'true'), edge('stock', 'back', 'false')],
    })

    insert(ordersId, 'Orders', {
      nodes: [
        node('hook', 'trigger-webhook'),
        node('approve', 'approval', {}, 'Approve order'),
        node('call', 'sub-workflow', { workflowId: fulfilId }, 'Fulfil order'),
        node('decline', 'output-log', { message: 'no' }, 'Decline'),
      ],
      edges: [
        edge('hook', 'approve'),
        edge('approve', 'call', 'true'),
        edge('approve', 'decline', 'false'),
      ],
    })

    readToken = (
      await request(app).post('/api/tokens').set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'reader', scopes: ['read'] })
    ).body.token
    triggerToken = (
      await request(app).post('/api/tokens').set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'runner', scopes: ['trigger'] })
    ).body.token
  })

  describe('GET /api/v1/workflows/:id/reach', () => {
    const get = (id = ordersId, token = readToken) =>
      request(app).get(`/api/v1/workflows/${id}/reach`).set('Authorization', `Bearer ${token}`)

    it('reports what the callee does, not that a call happens', async () => {
      const res = await get()
      expect(res.status).toBe(200)
      expect(res.body.available).toBe(true)
      const charge = res.body.effects.find((e) => e.label === 'Charge card')
      expect(charge.target).toBe('api.acme.com')
      expect(charge.workflowName).toBe('Fulfilment')
    })

    it('conjoins the caller\'s gate with the callee\'s', async () => {
      const res = await get()
      const charge = res.body.effects.find((e) => e.label === 'Charge card')
      expect(charge.conditions.map((c) => c.label)).toEqual(['Approve order', 'In stock?'])
      expect(charge.conditions[0].workflowName).toBe('Orders')
      expect(charge.always).toBe(false)
    })

    it('names the call chain that reaches it', async () => {
      const res = await get()
      const charge = res.body.effects.find((e) => e.label === 'Charge card')
      expect(charge.via.map((v) => v.name)).toEqual(['Fulfilment'])
    })

    it('separates what the per-graph report would have counted', async () => {
      const res = await get()
      expect(res.body.summary.inherited).toBeGreaterThan(0)
      expect(res.body.summary.workflows).toBe(1)
    })

    it('keeps a call it cannot follow, and says why', async () => {
      // Another workspace's workflow is not one the sub-workflow runner would
      // call, so it is not one this follows.
      const otherWs = uuidv4()
      const now = new Date().toISOString()
      db.prepare(
        'INSERT INTO workspaces (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run(otherWs, 'Elsewhere', userId, now, now)
      const hiddenId = uuidv4()
      insert(hiddenId, 'Hidden', {
        nodes: [node('t', 'trigger-manual'), node('x', 'action-http', { url: 'https://hidden.dev' })],
        edges: [edge('t', 'x')],
      }, otherWs)

      const callerId = uuidv4()
      insert(callerId, 'Caller', {
        nodes: [
          node('t', 'trigger-manual'),
          node('call', 'sub-workflow', { workflowId: hiddenId }, 'Call elsewhere'),
        ],
        edges: [edge('t', 'call')],
      })

      const res = await get(callerId)
      expect(res.body.effects.some((e) => e.kind === 'sub-workflow')).toBe(true)
      expect(res.body.unresolved[0].reason).toBe('not-visible')
    })

    it('refuses a token without the read scope', async () => {
      expect((await get(ordersId, triggerToken)).status).toBe(403)
    })

    it('404s for an unknown workflow', async () => {
      expect((await get(uuidv4())).status).toBe(404)
    })
  })

  describe('GET /api/workflows/:id/reach', () => {
    it('answers the same question for the canvas', async () => {
      const res = await request(app)
        .get(`/api/workflows/${ordersId}/reach`)
        .set('Authorization', `Bearer ${jwt}`)
      expect(res.status).toBe(200)
      expect(res.body.effects.some((e) => e.label === 'Charge card')).toBe(true)
    })

    it('404s for a workflow the caller is not a member of', async () => {
      const other = await request(app)
        .post('/api/auth/register')
        .send({ email: 'outsider-r@example.com', password: 'password123', displayName: 'O' })
      const res = await request(app)
        .get(`/api/workflows/${ordersId}/reach`)
        .set('Authorization', `Bearer ${other.body.token}`)
      expect(res.status).toBe(404)
    })
  })
})
