// The mutation endpoints.
//
// A POST on both surfaces despite writing nothing, because this one *executes*:
// every surviving mutant costs a full pass of the scenario suite as dry runs. A
// GET invites a cache, a prefetch and a browser retry, none of which should
// silently launch a hundred and sixty runs.

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

const GRAPH = {
  nodes: [
    node('t1', 'trigger-webhook'),
    node('check', 'condition', { expression: 'total > 100' }, 'Large order?'),
    node('tag', 'transform', { template: '{"tier": "large"}' }, 'Tag large'),
    node('skip', 'transform', { template: '{"tier": "small"}' }, 'Tag small'),
    node('out', 'output-return', { value: '{{tag}}' }, 'Return'),
  ],
  edges: [
    edge('t1', 'check'),
    edge('check', 'tag', 'true'),
    edge('check', 'skip', 'false'),
    edge('tag', 'out'),
    edge('skip', 'out'),
  ],
}

describe('mutation endpoints', () => {
  let jwt
  let readToken
  let userId
  let workflowId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'mutate@example.com', password: 'password123', displayName: 'M' })
    jwt = res.body.token
    userId = db.prepare('SELECT id FROM users WHERE email = ?').get('mutate@example.com').id
    const workspaceId = (
      await request(app).get('/api/workspaces').set('Authorization', `Bearer ${jwt}`)
    ).body.workspaces[0].id

    workflowId = uuidv4()
    db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by)
       VALUES (?, ?, 'Orders', ?, 'deployed', ?)`
    ).run(workflowId, workspaceId, JSON.stringify(GRAPH), userId)

    db.prepare(
      `INSERT INTO workflow_tests (id, workflow_id, name, trigger_data, assertions, created_by, created_at)
       VALUES (?, ?, 'a large order is tagged large', ?, ?, ?, ?)`
    ).run(
      uuidv4(), workflowId,
      JSON.stringify({ total: 500 }),
      JSON.stringify([{ expression: 'output.tier == "large"' }]),
      userId, new Date().toISOString()
    )

    readToken = (
      await request(app).post('/api/tokens').set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'reader', scopes: ['read'] })
    ).body.token
  })

  describe('POST /api/v1/workflows/:id/mutations', () => {
    const post = (id = workflowId, token = readToken) =>
      request(app).post(`/api/v1/workflows/${id}/mutations`).set('Authorization', `Bearer ${token}`)

    it('reports which mutants the checks caught and which they did not', async () => {
      const res = await post()
      expect(res.status).toBe(200)
      expect(res.body.available).toBe(true)
      expect(res.body.scenarios).toBe(1)
      expect(res.body.summary.total).toBeGreaterThan(0)
      expect(res.body.summary.killed + res.body.summary.survived).toBe(res.body.summary.total)
    })

    it('names each mutation in words somebody can judge in a second', async () => {
      const res = await post()
      expect(res.body.mutants[0].describe).toMatch(/wired backwards|off by one|removed/)
      expect(res.body.mutants[0]).toHaveProperty('operator')
      expect(res.body.mutants[0]).toHaveProperty('nodeId')
    })

    it('says which check did the killing', async () => {
      const res = await post()
      const killed = res.body.mutants.filter((m) => m.killed)
      expect(killed.length).toBeGreaterThan(0)
      expect(killed.every((m) => ['lint', 'guarantee', 'test'].includes(m.by))).toBe(true)
    })

    it('leaves no trace in the workflow history', async () => {
      // The analysis runs dry runs against graphs the workflow does not hold,
      // and deletes them. A mutation check should not appear in history at all.
      await post()
      const runs = db
        .prepare('SELECT COUNT(*) n FROM executions WHERE workflow_id = ?')
        .get(workflowId).n
      expect(runs).toBe(0)
    })

    it('never touches the saved definition', async () => {
      await post()
      const after = db.prepare('SELECT graph_json FROM workflows WHERE id = ?').get(workflowId)
      expect(JSON.parse(after.graph_json)).toEqual(GRAPH)
    })

    it('404s for an unknown workflow', async () => {
      expect((await post(uuidv4())).status).toBe(404)
    })

    it('refuses a token without the read scope', async () => {
      const trigger = (
        await request(app).post('/api/tokens').set('Authorization', `Bearer ${jwt}`)
          .send({ name: 'runner', scopes: ['trigger'] })
      ).body.token
      expect((await post(workflowId, trigger)).status).toBe(403)
    })
  })

  describe('POST /api/workflows/:id/mutations', () => {
    it('answers the same question for the canvas', async () => {
      const res = await request(app)
        .post(`/api/workflows/${workflowId}/mutations`)
        .set('Authorization', `Bearer ${jwt}`)
      expect(res.status).toBe(200)
      expect(res.body.summary).toHaveProperty('score')
    })

    it('404s for a workflow the caller is not a member of', async () => {
      const other = await request(app)
        .post('/api/auth/register')
        .send({ email: 'outsider-m@example.com', password: 'password123', displayName: 'O' })
      const res = await request(app)
        .post(`/api/workflows/${workflowId}/mutations`)
        .set('Authorization', `Bearer ${other.body.token}`)
      expect(res.status).toBe(404)
    })
  })
})
