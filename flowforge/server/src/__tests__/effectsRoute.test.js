// The effect report over both surfaces.
//
// The session route judges the graph *on screen* (same body contract as lint,
// types and lineage) so an author sees the answer while editing; the public one
// judges what is stored, because a promotion review is about what is deployed.

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
  id: `${source}-${target}`, source, target, sourceHandle,
})

// Webhook → approval → charge. The shape every example in the docs uses.
const GATED = {
  nodes: [
    node('hook', 'trigger-webhook'),
    node('approve', 'approval', {}, 'Approve refund'),
    node('charge', 'action-http', { url: 'https://api.acme.com/v1/charges' }, 'Charge card'),
    node('log', 'output-log', { message: 'no' }, 'Log rejection'),
  ],
  edges: [
    edge('hook', 'approve'),
    edge('approve', 'charge', 'true'),
    edge('approve', 'log', 'false'),
  ],
}

describe('effect reachability endpoints', () => {
  let jwt
  let readToken
  let triggerToken
  let workflowId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'effects@example.com', password: 'password123', displayName: 'Eff' })
    jwt = res.body.token
    const userId = db.prepare('SELECT id FROM users WHERE email = ?').get('effects@example.com').id
    const workspaceId = (
      await request(app).get('/api/workspaces').set('Authorization', `Bearer ${jwt}`)
    ).body.workspaces[0].id

    workflowId = uuidv4()
    db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by)
       VALUES (?, ?, 'Refunds', ?, 'deployed', ?)`
    ).run(workflowId, workspaceId, JSON.stringify(GATED), userId)

    readToken = (
      await request(app).post('/api/tokens').set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'reader', scopes: ['read'] })
    ).body.token
    triggerToken = (
      await request(app).post('/api/tokens').set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'runner', scopes: ['trigger'] })
    ).body.token
  })

  describe('GET /api/v1/workflows/:id/effects', () => {
    it('reports the effect and the gate it is behind', async () => {
      const res = await request(app)
        .get(`/api/v1/workflows/${workflowId}/effects`)
        .set('Authorization', `Bearer ${readToken}`)

      expect(res.status).toBe(200)
      expect(res.body.available).toBe(true)
      expect(res.body.effects).toHaveLength(1)
      expect(res.body.effects[0]).toMatchObject({
        nodeId: 'charge',
        kind: 'http',
        target: 'api.acme.com',
        always: false,
      })
      expect(res.body.effects[0].conditions).toEqual([
        { nodeId: 'approve', label: 'Approve refund', type: 'approval', outcome: 'true' },
      ])
    })

    it('answers the inverse question in the same payload', async () => {
      const res = await request(app)
        .get(`/api/v1/workflows/${workflowId}/effects`)
        .set('Authorization', `Bearer ${readToken}`)
      const approve = res.body.decisions.find((d) => d.nodeId === 'approve')
      expect(approve.outcomes.find((o) => o.name === 'true').gates).toEqual(['charge'])
      expect(approve.outcomes.find((o) => o.name === 'false').gates).toEqual([])
    })

    it('refuses a token without the read scope', async () => {
      const res = await request(app)
        .get(`/api/v1/workflows/${workflowId}/effects`)
        .set('Authorization', `Bearer ${triggerToken}`)
      expect(res.status).toBe(403)
    })

    it('404s for an unknown workflow', async () => {
      const res = await request(app)
        .get(`/api/v1/workflows/${uuidv4()}/effects`)
        .set('Authorization', `Bearer ${readToken}`)
      expect(res.status).toBe(404)
    })
  })

  describe('POST /api/workflows/:id/effects', () => {
    it('judges the graph in the body, not the one that was saved', async () => {
      // The canvas asks about what is on screen. Here that graph has had a
      // manual trigger wired straight at the charge — the exact edit that makes
      // an approval optional without breaking anything a linter checks.
      const bypassed = {
        nodes: [...GATED.nodes, node('manual', 'trigger-manual', {}, 'Run by hand')],
        edges: [...GATED.edges, edge('manual', 'charge')],
      }
      const res = await request(app)
        .post(`/api/workflows/${workflowId}/effects`)
        .set('Authorization', `Bearer ${jwt}`)
        .send(bypassed)

      expect(res.status).toBe(200)
      const charge = res.body.effects.find((e) => e.nodeId === 'charge')
      expect(charge.always).toBe(true)
      expect(charge.conditions).toEqual([])
      // While the *stored* graph still has the gate, which is the point of the
      // two surfaces answering about different graphs.
      const stored = await request(app)
        .get(`/api/v1/workflows/${workflowId}/effects`)
        .set('Authorization', `Bearer ${readToken}`)
      expect(stored.body.effects[0].always).toBe(false)
    })

    it('falls back to the stored graph when the body has none', async () => {
      const res = await request(app)
        .post(`/api/workflows/${workflowId}/effects`)
        .set('Authorization', `Bearer ${jwt}`)
        .send({})
      expect(res.body.effects[0].nodeId).toBe('charge')
    })

    it('refuses a graph too large to analyse', async () => {
      const res = await request(app)
        .post(`/api/workflows/${workflowId}/effects`)
        .set('Authorization', `Bearer ${jwt}`)
        .send({ nodes: new Array(2001).fill(node('x', 'transform')), edges: [] })
      expect(res.status).toBe(400)
    })

    it('404s for a workflow the caller cannot see', async () => {
      const other = await request(app)
        .post('/api/auth/register')
        .send({ email: 'effects-other@example.com', password: 'password123', displayName: 'Other' })
      const res = await request(app)
        .post(`/api/workflows/${workflowId}/effects`)
        .set('Authorization', `Bearer ${other.body.token}`)
        .send({})
      expect(res.status).toBe(404)
    })
  })
})
