// The convergence report over both surfaces.
//
// The session route judges the graph *on screen*, which matters more here than
// on its neighbours: the answer changes the moment somebody draws a connection,
// and wiring a third branch into a join is exactly the edit that creates a
// collision. The public one judges what is stored, because a promotion review
// is about what is deployed.

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

// Two independent lookups converging on one node. Both produce the http
// runner's shape, so every field of it collides — and neither is downstream of
// the other, so the graph does not say which should win.
const DIAMOND = {
  nodes: [
    node('hook', 'trigger-webhook'),
    node('crm', 'action-http', { url: 'https://crm.example.com/lookup' }, 'CRM lookup'),
    node('billing', 'action-http', { url: 'https://billing.example.com/lookup' }, 'Billing lookup'),
    node('merge', 'output-log', { message: 'ok' }, 'Combine'),
  ],
  edges: [
    edge('hook', 'crm'),
    edge('hook', 'billing'),
    edge('crm', 'merge'),
    edge('billing', 'merge'),
  ],
}

describe('convergence endpoints', () => {
  let jwt
  let readToken
  let triggerToken
  let workflowId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'converge@example.com', password: 'password123', displayName: 'Con' })
    jwt = res.body.token
    const userId = db.prepare('SELECT id FROM users WHERE email = ?').get('converge@example.com').id
    const workspaceId = (
      await request(app).get('/api/workspaces').set('Authorization', `Bearer ${jwt}`)
    ).body.workspaces[0].id

    workflowId = uuidv4()
    db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by)
       VALUES (?, ?, 'Enrichment', ?, 'deployed', ?)`
    ).run(workflowId, workspaceId, JSON.stringify(DIAMOND), userId)

    readToken = (
      await request(app).post('/api/tokens').set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'reader', scopes: ['read'] })
    ).body.token
    triggerToken = (
      await request(app).post('/api/tokens').set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'runner', scopes: ['trigger'] })
    ).body.token
  })

  describe('GET /api/v1/workflows/:id/convergence', () => {
    const get = (id = workflowId, token = readToken) =>
      request(app)
        .get(`/api/v1/workflows/${id}/convergence`)
        .set('Authorization', `Bearer ${token}`)

    it('reports the join and what collides at it', async () => {
      const res = await get()
      expect(res.status).toBe(200)
      expect(res.body.available).toBe(true)
      expect(res.body.joins).toHaveLength(1)
      expect(res.body.joins[0]).toMatchObject({ nodeId: 'merge', label: 'Combine', arity: 2 })
      expect(res.body.joins[0].collisions.map((c) => c.key)).toContain('status')
    })

    it('calls it a tie-break and names who wins', async () => {
      const res = await get()
      const found = res.body.joins[0].collisions.find((c) => c.key === 'status')
      expect(found.resolution).toBe('tie-break')
      // Last writer wins, and "last" is alphabetical — which is the finding
      // rather than a recommendation. Nothing about billing or the CRM says the
      // one that sorts later should be the one that survives.
      expect(found.contributors.map((c) => c.label)).toEqual(['Billing lookup', 'CRM lookup'])
      expect(found.decidedBy).toBe('crm')
    })

    it('gives a pipeline one number to gate on', async () => {
      const res = await get()
      expect(res.body.summary.tieBroken).toBeGreaterThan(0)
      expect(res.body.summary.dataflow).toBe(0)
    })

    it('refuses a token without the read scope', async () => {
      expect((await get(workflowId, triggerToken)).status).toBe(403)
    })

    it('404s for an unknown workflow', async () => {
      expect((await get(uuidv4())).status).toBe(404)
    })
  })

  describe('POST /api/workflows/:id/convergence', () => {
    const post = (graph) =>
      request(app)
        .post(`/api/workflows/${workflowId}/convergence`)
        .set('Authorization', `Bearer ${jwt}`)
        .send(graph)

    it('judges the graph in the body, not the one that was saved', async () => {
      // The edit that creates the problem: a third lookup wired into the same
      // join. The author should see it while their hand is still on the mouse.
      const wider = {
        nodes: [
          ...DIAMOND.nodes,
          node('legacy', 'action-http', { url: 'https://old.example.com' }, 'Legacy lookup'),
        ],
        edges: [...DIAMOND.edges, edge('hook', 'legacy'), edge('legacy', 'merge')],
      }
      const res = await post(wider)
      expect(res.status).toBe(200)
      expect(res.body.joins[0].arity).toBe(3)
      expect(res.body.joins[0].mergeOrder).toEqual(['billing', 'crm', 'legacy'])
    })

    it('reports nothing for a graph whose branches can never both run', async () => {
      const exclusive = {
        nodes: [
          node('hook', 'trigger-webhook'),
          node('check', 'condition', { expression: 'amount > 100' }, 'Large?'),
          node('big', 'action-http', { url: 'https://a.dev' }, 'Big'),
          node('small', 'action-http', { url: 'https://b.dev' }, 'Small'),
          node('merge', 'output-log', { message: 'ok' }, 'Combine'),
        ],
        edges: [
          edge('hook', 'check'),
          edge('check', 'big', 'true'),
          edge('check', 'small', 'false'),
          edge('big', 'merge'),
          edge('small', 'merge'),
        ],
      }
      const res = await post(exclusive)
      expect(res.body.joins).toEqual([])
      expect(res.body.summary.collisions).toBe(0)
    })

    it('falls back to the saved graph when the body is not one', async () => {
      const res = await post({})
      expect(res.body.joins[0].nodeId).toBe('merge')
    })

    it('refuses a graph too large to analyse', async () => {
      const nodes = Array.from({ length: 2001 }, (_, i) => node(`n${i}`, 'transform'))
      const res = await post({ nodes, edges: [] })
      expect(res.status).toBe(400)
    })

    it('404s for a workflow the caller is not a member of', async () => {
      const other = await request(app)
        .post('/api/auth/register')
        .send({ email: 'outsider-conv@example.com', password: 'password123', displayName: 'Out' })
      const res = await request(app)
        .post(`/api/workflows/${workflowId}/convergence`)
        .set('Authorization', `Bearer ${other.body.token}`)
        .send(DIAMOND)
      expect(res.status).toBe(404)
    })
  })
})
