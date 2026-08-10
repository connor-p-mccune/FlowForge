// The schema endpoints: the canvas's POST (which analyses the graph on screen,
// saved or not) and the public API's GET (which analyses the stored one).

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const request = require('supertest')

jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: jest.fn() }) }))
jest.mock('../config/redis', () => ({ publish: jest.fn().mockResolvedValue(1) }))

const { app } = require('../index')

const node = (id, type, config = {}) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label: id, config },
})
const edge = (source, target) => ({ id: `${source}-${target}`, source, target })

const GRAPH = {
  nodes: [
    node('t1', 'trigger-manual'),
    node('h1', 'action-http', { url: 'https://api.example.com' }),
    node('o1', 'output-log', { message: 'code {{h1.status}}' }),
  ],
  edges: [edge('t1', 'h1'), edge('h1', 'o1')],
}

let token
let apiToken
let workflowId

beforeAll(async () => {
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ email: 'types@example.com', password: 'password123', displayName: 'Types' })
  token = reg.body.token
  const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`)
  const workspaceId = ws.body.workspaces[0].id
  const wf = await request(app)
    .post(`/api/workspaces/${workspaceId}/workflows`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Typed' })
  workflowId = wf.body.workflow.id
  await request(app)
    .put(`/api/workflows/${workflowId}/graph`)
    .set('Authorization', `Bearer ${token}`)
    .send(GRAPH)
  const created = await request(app)
    .post('/api/tokens')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'ci', scopes: ['read'] })
  apiToken = created.body.token
})

describe('POST /api/workflows/:id/types', () => {
  it('describes every node’s input and output', async () => {
    const res = await request(app)
      .post(`/api/workflows/${workflowId}/types`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
    expect(res.status).toBe(200)
    expect(res.body.order).toEqual(['t1', 'h1', 'o1'])
    expect(res.body.nodes.h1.output.described).toMatch(/^\{ status: number, body: any/)
    expect(res.body.nodes.o1.input.described).toMatch(/status: number/)
    expect(res.body.diagnostics).toEqual([])
  })

  it('lists the pickable references an output offers', async () => {
    const res = await request(app)
      .post(`/api/workflows/${workflowId}/types`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
    const paths = res.body.nodes.h1.output.fields.map((f) => f.path)
    expect(paths).toEqual(expect.arrayContaining(['status', 'body']))
  })

  it('analyses the posted graph, so the canvas can ask about unsaved edits', async () => {
    const edited = {
      nodes: [...GRAPH.nodes.slice(0, 2), node('o1', 'output-log', { message: '{{h1.bdy}}' })],
      edges: GRAPH.edges,
    }
    const res = await request(app)
      .post(`/api/workflows/${workflowId}/types`)
      .set('Authorization', `Bearer ${token}`)
      .send(edited)
    expect(res.body.diagnostics.map((d) => d.code)).toEqual(['unknown-field'])
    expect(res.body.diagnostics[0].message).toMatch(/did you mean "body"\?/)
  })

  it('refuses a graph too large to analyse', async () => {
    const res = await request(app)
      .post(`/api/workflows/${workflowId}/types`)
      .set('Authorization', `Bearer ${token}`)
      .send({ nodes: new Array(2001).fill(node('x', 'output-log')), edges: [] })
    expect(res.status).toBe(400)
  })

  it('404s for a non-member', async () => {
    const outsider = await request(app)
      .post('/api/auth/register')
      .send({ email: 'types-out@example.com', password: 'password123', displayName: 'Out' })
    const res = await request(app)
      .post(`/api/workflows/${workflowId}/types`)
      .set('Authorization', `Bearer ${outsider.body.token}`)
      .send({})
    expect(res.status).toBe(404)
  })
})

describe('GET /api/v1/workflows/:id/types', () => {
  it('describes the stored graph for a read-scoped token', async () => {
    const res = await request(app)
      .get(`/api/v1/workflows/${workflowId}/types`)
      .set('Authorization', `Bearer ${apiToken}`)
    expect(res.status).toBe(200)
    expect(res.body.workflowId).toBe(workflowId)
    expect(res.body.nodes.h1.output.described).toMatch(/status: number/)
  })

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get(`/api/v1/workflows/${workflowId}/types`)
    expect(res.status).toBe(401)
  })
})

describe('the lint report carries the type findings', () => {
  it('reports a broken reference as an error with the rest of the issues', async () => {
    const res = await request(app)
      .post(`/api/workflows/${workflowId}/lint`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        nodes: [...GRAPH.nodes.slice(0, 2), node('o1', 'output-log', { message: '{{h1.bdy}}' })],
        edges: GRAPH.edges,
      })
    expect(res.body.issues.map((i) => i.code)).toContain('unknown-field')
    expect(res.body.summary.errors).toBeGreaterThan(0)
  })
})
