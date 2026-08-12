// The guarantee endpoints end to end: declaring invariants, verifying them
// against the graph on screen, the deploy gate, and the CI-shaped GET on the
// public API.
//
// The behaviour worth pinning here is not "the checker works" — that is
// guarantees.test.js — it is that the *product* refuses to let an invariant go
// quiet: it blocks the deploy that breaks one, blocks the deploy that deleted
// the node one names, and travels with an exported definition so a promotion
// carries its own assertions.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const request = require('supertest')

jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: jest.fn() }) }))
jest.mock('../config/redis', () => ({ publish: jest.fn().mockResolvedValue(1) }))
jest.mock('../services/scheduler', () => ({
  registerSchedule: jest.fn(),
  unregisterSchedule: jest.fn(),
  validateCron: () => true,
  scheduleTimeZone: () => null,
}))

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

// hook → approve → (true) charge
const GRAPH = {
  nodes: [
    node('hook', 'trigger-webhook', {}, 'Order webhook'),
    node('approve', 'approval', {}, 'Approve'),
    node('charge', 'action-http', { url: 'https://api.example.com/charge', method: 'POST' }, 'Charge card'),
  ],
  edges: [edge('hook', 'approve'), edge('approve', 'charge', 'true')],
}

const REQUIRES = { kind: 'requires', node: 'charge', other: 'approve' }

let token
let apiToken
let workspaceId
let workflowId

const auth = (req) => req.set('Authorization', `Bearer ${token}`)

async function makeWorkflow(name, graph = GRAPH) {
  const wf = await auth(request(app).post(`/api/workspaces/${workspaceId}/workflows`)).send({ name })
  const id = wf.body.workflow.id
  await auth(request(app).put(`/api/workflows/${id}/graph`)).send(graph)
  return id
}

beforeAll(async () => {
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ email: 'guarantees@example.com', password: 'password123', displayName: 'G' })
  token = reg.body.token
  const ws = await auth(request(app).get('/api/workspaces'))
  workspaceId = ws.body.workspaces[0].id
  workflowId = await makeWorkflow('Payments')
  const minted = await auth(request(app).post('/api/tokens')).send({
    name: 'ci',
    scopes: ['read', 'manage'],
  })
  apiToken = minted.body.token
})

describe('PUT /api/workflows/:id/guarantees', () => {
  it('stores the declarations and verifies them in the same response', async () => {
    const res = await auth(request(app).put(`/api/workflows/${workflowId}/guarantees`)).send({
      guarantees: [REQUIRES],
    })
    expect(res.status).toBe(200)
    expect(res.body.guarantees).toEqual([REQUIRES])
    expect(res.body.results[0].status).toBe('holds')
    expect(res.body.results[0].statement).toBe('Charge card never runs unless Approve ran first')
  })

  it('echoes back what was kept, so a caller sees what was dropped', async () => {
    const id = await makeWorkflow('Echo')
    const res = await auth(request(app).put(`/api/workflows/${id}/guarantees`)).send({
      guarantees: [REQUIRES, { kind: 'nonsense', node: 'a', other: 'b' }],
    })
    expect(res.body.guarantees).toEqual([REQUIRES])
  })

  it('rejects a body that is not an array', async () => {
    const res = await auth(request(app).put(`/api/workflows/${workflowId}/guarantees`)).send({
      guarantees: 'requires charge approve',
    })
    expect(res.status).toBe(400)
  })

  it('404s a workflow the caller is not a member of', async () => {
    const other = await request(app)
      .post('/api/auth/register')
      .send({ email: 'outsider@example.com', password: 'password123', displayName: 'O' })
    const res = await request(app)
      .put(`/api/workflows/${workflowId}/guarantees`)
      .set('Authorization', `Bearer ${other.body.token}`)
      .send({ guarantees: [] })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/workflows/:id/guarantees', () => {
  it('verifies the graph on screen, not the saved one', async () => {
    // The canvas has an extra edge routing around the approval; nothing has
    // been saved. The panel must report it while it is still an edit.
    const onScreen = {
      nodes: GRAPH.nodes,
      edges: [...GRAPH.edges, edge('hook', 'charge')],
    }
    const res = await auth(request(app).post(`/api/workflows/${workflowId}/guarantees`)).send(onScreen)
    expect(res.body.results[0].status).toBe('violated')
    expect(res.body.results[0].counterexample).toEqual(['hook', 'charge'])
  })

  it('verifies a proposed declaration without saving it', async () => {
    const res = await auth(request(app).post(`/api/workflows/${workflowId}/guarantees`)).send({
      ...GRAPH,
      guarantees: [{ kind: 'exclusive', node: 'charge', other: 'approve' }],
    })
    expect(res.body.results).toHaveLength(1)
    expect(res.body.results[0].status).toBe('violated')
    // …and the stored list is untouched.
    const stored = await auth(request(app).post(`/api/workflows/${workflowId}/guarantees`)).send({})
    expect(stored.body.results[0].kind).toBe('requires')
  })

  it('reports the facts and suggestions alongside the verdicts', async () => {
    const res = await auth(request(app).post(`/api/workflows/${workflowId}/guarantees`)).send(GRAPH)
    expect(res.body.facts.alwaysRuns.map((f) => f.nodeId).sort()).toEqual(['approve', 'hook'])
    expect(res.body.facts.decisions[0].nodeId).toBe('approve')
    expect(res.body.suggestions).toContainEqual(
      expect.objectContaining({ kind: 'requires', node: 'charge', other: 'approve' })
    )
  })
})

describe('the Issues panel', () => {
  it('reports a violated guarantee as an error, anchored to its node', async () => {
    const res = await auth(request(app).post(`/api/workflows/${workflowId}/lint`)).send({
      nodes: GRAPH.nodes,
      edges: [...GRAPH.edges, edge('hook', 'charge')],
    })
    const finding = res.body.issues.find((i) => i.code === 'guarantee-violated')
    expect(finding).toBeDefined()
    expect(finding.severity).toBe('error')
    expect(finding.nodeId).toBe('charge')
  })

  it('says nothing about a workflow with no declarations', async () => {
    const id = await makeWorkflow('Undeclared')
    const res = await auth(request(app).post(`/api/workflows/${id}/lint`)).send(GRAPH)
    expect(res.body.issues.filter((i) => i.code.startsWith('guarantee-'))).toEqual([])
  })
})

describe('the deploy gate', () => {
  it('deploys when every guarantee holds', async () => {
    const id = await makeWorkflow('Deployable')
    await auth(request(app).put(`/api/workflows/${id}/guarantees`)).send({ guarantees: [REQUIRES] })
    const res = await auth(request(app).post(`/api/workflows/${id}/deploy`))
    expect(res.status).toBe(201)
  })

  it('refuses the deploy that routes around the gate, with the counterexample', async () => {
    const id = await makeWorkflow('Bypassed')
    await auth(request(app).put(`/api/workflows/${id}/guarantees`)).send({ guarantees: [REQUIRES] })
    await auth(request(app).put(`/api/workflows/${id}/graph`)).send({
      nodes: GRAPH.nodes,
      edges: [...GRAPH.edges, edge('hook', 'charge')],
    })

    const res = await auth(request(app).post(`/api/workflows/${id}/deploy`))
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('Deploy blocked by a workflow guarantee')
    expect(res.body.guarantees[0].counterexample).toEqual(['hook', 'charge'])
    // Still a draft: a blocked deploy changes nothing.
    const after = await auth(request(app).get(`/api/workflows/${id}`))
    expect(after.body.workflow.status).toBe('draft')
  })

  it('refuses the deploy that deleted the node a guarantee names', async () => {
    // The quiet failure: remove the approval and every invariant about it stops
    // failing. `unknown` must block exactly like `violated`.
    const id = await makeWorkflow('Deleted gate')
    await auth(request(app).put(`/api/workflows/${id}/guarantees`)).send({ guarantees: [REQUIRES] })
    await auth(request(app).put(`/api/workflows/${id}/graph`)).send({
      nodes: GRAPH.nodes.filter((n) => n.id !== 'approve'),
      edges: [edge('hook', 'charge')],
    })

    const res = await auth(request(app).post(`/api/workflows/${id}/deploy`))
    expect(res.status).toBe(422)
    expect(res.body.guarantees[0].status).toBe('unknown')
  })

  it('leaves a workflow with no declarations completely alone', async () => {
    const id = await makeWorkflow('Plain')
    expect((await auth(request(app).post(`/api/workflows/${id}/deploy`))).status).toBe(201)
  })
})

describe('GET /api/v1/workflows/:id/guarantees', () => {
  it('is the CI gate: ok true when everything holds', async () => {
    const res = await request(app)
      .get(`/api/v1/workflows/${workflowId}/guarantees`)
      .set('Authorization', `Bearer ${apiToken}`)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.results[0].status).toBe('holds')
  })

  it('is false for an uncheckable declaration, not only a violated one', async () => {
    const id = await makeWorkflow('Gone')
    await auth(request(app).put(`/api/workflows/${id}/guarantees`)).send({ guarantees: [REQUIRES] })
    await auth(request(app).put(`/api/workflows/${id}/graph`)).send({
      nodes: GRAPH.nodes.filter((n) => n.id !== 'approve'),
      edges: [edge('hook', 'charge')],
    })
    const res = await request(app)
      .get(`/api/v1/workflows/${id}/guarantees`)
      .set('Authorization', `Bearer ${apiToken}`)
    expect(res.body.ok).toBe(false)
  })

  it('is ok for a workflow that declares nothing', async () => {
    const id = await makeWorkflow('Silent')
    const res = await request(app)
      .get(`/api/v1/workflows/${id}/guarantees`)
      .set('Authorization', `Bearer ${apiToken}`)
    expect(res.body).toMatchObject({ ok: true, results: [] })
  })
})

describe('portability', () => {
  it('carries the declarations through export and import', async () => {
    const exported = await request(app)
      .get(`/api/v1/workflows/${workflowId}/export`)
      .set('Authorization', `Bearer ${apiToken}`)
    expect(exported.body.guarantees).toEqual([REQUIRES])

    const imported = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/workflows/import`)
      .set('Authorization', `Bearer ${apiToken}`)
      .send({ name: 'Promoted', ...exported.body })
    expect(imported.status).toBe(201)

    const verified = await request(app)
      .get(`/api/v1/workflows/${imported.body.workflow.id}/guarantees`)
      .set('Authorization', `Bearer ${apiToken}`)
    expect(verified.body.results[0]).toMatchObject({ kind: 'requires', status: 'holds' })
  })
})
