// The path-feasibility endpoints end to end: analysing the graph on screen,
// the CI shape on the public API, and the one that writes: generating a test
// scenario per branch a payload can drive.
//
// The analysis itself is pinned by pathConstraints.test.js. What matters here
// is the *product* behaviour around it — that generation is idempotent, that it
// never touches a scenario a person wrote, and that the branches it could not
// cover come back with a reason rather than being silently absent.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const request = require('supertest')

jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: jest.fn() }) }))
jest.mock('../config/redis', () => ({ publish: jest.fn().mockResolvedValue(1) }))

const { app } = require('../index')

const node = (id, type, config = {}, label = id) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label, config },
})
const edge = (source, target, sourceHandle) => ({
  id: `${source}-${target}-${sourceHandle || ''}`,
  source,
  target,
  ...(sourceHandle ? { sourceHandle } : {}),
})

// A router with three outcomes, all drivable from the trigger payload.
const ROUTED = {
  nodes: [
    node('hook', 'trigger-webhook', {}, 'Order webhook'),
    node(
      'route',
      'switch',
      {
        cases: [
          { label: 'refund', expression: 'kind == "refund"' },
          { label: 'order', expression: 'kind == "order"' },
        ],
      },
      'Route'
    ),
    node('a', 'output-log', { message: 'refund' }),
    node('b', 'output-log', { message: 'order' }),
    node('c', 'output-log', { message: 'other' }),
  ],
  edges: [
    edge('hook', 'route'),
    edge('route', 'a', 'refund'),
    edge('route', 'b', 'order'),
    edge('route', 'c', 'default'),
  ],
}

let token
let apiToken
let workspaceId
let workflowId

const auth = (req) => req.set('Authorization', `Bearer ${token}`)

async function makeWorkflow(name, graph) {
  const wf = await auth(request(app).post(`/api/workspaces/${workspaceId}/workflows`)).send({ name })
  const id = wf.body.workflow.id
  await auth(request(app).put(`/api/workflows/${id}/graph`)).send(graph)
  return id
}

beforeAll(async () => {
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ email: 'paths@example.com', password: 'password123', displayName: 'P' })
  token = reg.body.token
  const ws = await auth(request(app).get('/api/workspaces'))
  workspaceId = ws.body.workspaces[0].id
  workflowId = await makeWorkflow('Router', ROUTED)
  const minted = await auth(request(app).post('/api/tokens')).send({
    name: 'ci',
    scopes: ['read', 'manage'],
  })
  apiToken = minted.body.token
})

describe('POST /api/workflows/:id/paths', () => {
  it('analyses the stored graph when no body is posted', async () => {
    const res = await auth(request(app).post(`/api/workflows/${workflowId}/paths`))
    expect(res.status).toBe(200)
    expect(res.body.analysed).toBe(true)
    expect(res.body.coverage).toEqual({ branches: 3, reachable: 3, generatable: 3 })
    expect(res.body.findings).toEqual([])
  })

  it('analyses the graph on screen instead of the saved one', async () => {
    // An unsaved edit that shadows the second case behind the first.
    const edited = {
      ...ROUTED,
      nodes: ROUTED.nodes.map((n) =>
        n.id === 'route'
          ? node('route', 'switch', {
              cases: [
                { label: 'refund', expression: 'amount > 10' },
                { label: 'order', expression: 'amount > 100' },
              ],
            }, 'Route')
          : n
      ),
    }
    const res = await auth(request(app).post(`/api/workflows/${workflowId}/paths`)).send(edited)
    expect(res.status).toBe(200)
    const dead = res.body.branches.find((b) => b.outcome === 'order')
    expect(dead.status).toBe('unreachable')
    expect(res.body.findings[0].code).toBe('unreachable-branch')

    // …and the saved graph is untouched by having asked.
    const saved = await auth(request(app).post(`/api/workflows/${workflowId}/paths`))
    expect(saved.body.findings).toEqual([])
  })

  it('refuses a graph too large to analyse', async () => {
    const res = await auth(request(app).post(`/api/workflows/${workflowId}/paths`)).send({
      nodes: Array.from({ length: 2001 }, (_, i) => node(`n${i}`, 'output-log')),
      edges: [],
    })
    expect(res.status).toBe(400)
  })

  it('404s for a non-member', async () => {
    const other = await request(app)
      .post('/api/auth/register')
      .send({ email: 'paths-other@example.com', password: 'password123', displayName: 'O' })
    const res = await request(app)
      .post(`/api/workflows/${workflowId}/paths`)
      .set('Authorization', `Bearer ${other.body.token}`)
    expect(res.status).toBe(404)
  })
})

describe('GET /api/v1/workflows/:id/paths', () => {
  it('serves the CI shape against the stored graph', async () => {
    const res = await request(app)
      .get(`/api/v1/workflows/${workflowId}/paths`)
      .set('Authorization', `Bearer ${apiToken}`)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.workflowId).toBe(workflowId)
    expect(res.body.branches).toHaveLength(3)
  })

  it('reports ok: false when a branch is provably unreachable', async () => {
    const shadowed = await makeWorkflow('Shadowed', {
      nodes: [
        node('hook', 'trigger-webhook'),
        node('c1', 'condition', { operator: 'expression', expression: 'amount < 100' }, 'Small'),
        node(
          'c2',
          'condition',
          { operator: 'greater_than', left: '{{hook.amount}}', right: '1000' },
          'Large'
        ),
        node('o1', 'output-log', { message: 'big' }),
      ],
      edges: [edge('hook', 'c1'), edge('c1', 'c2', 'true'), edge('c2', 'o1', 'true')],
    })
    const res = await request(app)
      .get(`/api/v1/workflows/${shadowed}/paths`)
      .set('Authorization', `Bearer ${apiToken}`)
    expect(res.body.ok).toBe(false)
    expect(res.body.findings[0].nodeId).toBe('c2')
  })

  it('needs a token', async () => {
    expect((await request(app).get(`/api/v1/workflows/${workflowId}/paths`)).status).toBe(401)
  })
})

describe('POST /api/workflows/:id/tests/generate', () => {
  let target

  beforeAll(async () => {
    target = await makeWorkflow('Generated', ROUTED)
  })

  it('writes one scenario per drivable branch, each asserting the branch it covers', async () => {
    const res = await auth(request(app).post(`/api/workflows/${target}/tests/generate`))
    expect(res.status).toBe(200)
    expect(res.body.created).toBe(3)
    expect(res.body.updated).toBe(0)
    expect(res.body.uncovered).toEqual([])

    const refund = res.body.tests.find((t) => t.generatedFor === 'route:refund')
    expect(refund.name).toBe('Route → refund')
    expect(refund.input).toEqual({ kind: 'refund' })
    expect(refund.assertions[0].expression).toBe('steps["route"].result == "refund"')
  })

  it('is idempotent — a second run updates rather than doubles the suite', async () => {
    const again = await auth(request(app).post(`/api/workflows/${target}/tests/generate`))
    expect(again.body.created).toBe(0)
    expect(again.body.updated).toBe(3)
    expect(again.body.tests).toHaveLength(3)
  })

  it('leaves a hand-written scenario alone', async () => {
    const mine = await auth(request(app).post(`/api/workflows/${target}/tests`)).send({
      name: 'my own case',
      input: { kind: 'refund' },
      assertions: [{ expression: 'status == "completed"' }],
    })
    expect(mine.body.test.generatedFor).toBeNull()

    const again = await auth(request(app).post(`/api/workflows/${target}/tests/generate`))
    expect(again.body.tests).toHaveLength(4)
    expect(again.body.tests.find((t) => t.id === mine.body.test.id).name).toBe('my own case')
  })

  it('names the branches it could not cover, with the reason', async () => {
    const gated = await makeWorkflow('Gated', {
      nodes: [
        node('hook', 'trigger-webhook'),
        node('approve', 'approval', {}, 'Approve'),
        node('charge', 'output-log', { message: 'charge' }),
        node('drop', 'output-log', { message: 'drop' }),
      ],
      edges: [
        edge('hook', 'approve'),
        edge('approve', 'charge', 'true'),
        edge('approve', 'drop', 'false'),
      ],
    })
    const res = await auth(request(app).post(`/api/workflows/${gated}/tests/generate`))
    expect(res.body.created).toBe(1)
    expect(res.body.uncovered).toHaveLength(1)
    expect(res.body.uncovered[0]).toMatchObject({ nodeId: 'approve', outcome: 'false' })
    expect(res.body.uncovered[0].reason).toMatch(/test mode/)
    expect(res.body.coverage).toEqual({ branches: 2, reachable: 2, generatable: 1 })
  })

  it('refuses a graph that admits no execution', async () => {
    const cyclic = await makeWorkflow('Cyclic', {
      nodes: [node('a', 'condition'), node('b', 'condition')],
      edges: [edge('a', 'b', 'true'), edge('b', 'a', 'true')],
    })
    const res = await auth(request(app).post(`/api/workflows/${cyclic}/tests/generate`))
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/cycle/)
  })

  it('is refused for a viewer', async () => {
    const viewer = await request(app)
      .post('/api/auth/register')
      .send({ email: 'paths-viewer@example.com', password: 'password123', displayName: 'V' })
    await auth(request(app).post(`/api/workspaces/${workspaceId}/members`)).send({
      email: 'paths-viewer@example.com',
      role: 'viewer',
    })
    const res = await request(app)
      .post(`/api/workflows/${target}/tests/generate`)
      .set('Authorization', `Bearer ${viewer.body.token}`)
    expect(res.status).toBe(403)
  })
})
