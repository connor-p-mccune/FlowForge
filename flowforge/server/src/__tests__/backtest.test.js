// Deploy preview: what an edit would have done to the runs that already
// happened.
//
// The claim the feature makes is narrow and has to be defended precisely: a
// difference it reports must be caused by the **edit**, not by test mode. That
// is why every externally-effectful node is settled from the original run's own
// recorded output, and it is what most of this file pins — including the
// negative case, where a graph that changed nothing produces no findings at all
// despite every HTTP node in it being simulated.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'
process.env.EXEC_RETRY_BASE_MS = '1'

const request = require('supertest')
const { v4: uuidv4 } = require('uuid')

jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: jest.fn() }) }))
jest.mock('../config/redis', () => ({ publish: jest.fn().mockResolvedValue(1) }))

const db = require('../config/database')
const { app } = require('../index')
const { previewDeploy, stubsFor, STUBBED_TYPES } = require('../services/backtest')

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

// hook → fetch(http) → big? → (true) vip / (false) normal
const graphWithThreshold = (threshold) => ({
  nodes: [
    node('hook', 'trigger-webhook', {}, 'Order webhook'),
    node('fetch', 'action-http', { url: 'https://api.example.com/order', method: 'GET' }, 'Fetch'),
    node('big', 'condition', { operator: 'expression', expression: `amount > ${threshold}` }, 'Large?'),
    node('vip', 'output-log', { message: 'vip' }, 'VIP'),
    node('normal', 'output-log', { message: 'normal' }, 'Normal'),
  ],
  edges: [
    edge('hook', 'fetch'),
    edge('fetch', 'big'),
    edge('big', 'vip', 'true'),
    edge('big', 'normal', 'false'),
  ],
})

let token
let workspaceId
const authed = (req) => req.set('Authorization', `Bearer ${token}`)

// A recorded run: the trigger payload it was given, and the steps it produced.
// `amount` rides on the HTTP node's output, so it reaches the condition through
// the merge and the preview has to take it from the recorded step rather than
// from a simulated response.
function seedRun(workflowId, { amount, branch, status = 'completed', i = 0 }) {
  const execId = uuidv4()
  const now = new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString()
  db.prepare(
    `INSERT INTO executions (id, workflow_id, status, trigger_type, trigger_data, started_at, finished_at, created_at)
     VALUES (?, ?, ?, 'webhook', ?, ?, ?, ?)`
  ).run(execId, workflowId, status, JSON.stringify({ orderId: `o-${i}` }), now, now, now)

  const step = (nodeId, nodeType, stepStatus, output) =>
    db.prepare(
      `INSERT INTO execution_steps (id, execution_id, node_id, node_type, status, output_json, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(uuidv4(), execId, nodeId, nodeType, stepStatus, output ? JSON.stringify(output) : null, now, now)

  step('hook', 'trigger-webhook', 'succeeded', { triggered: true, orderId: `o-${i}` })
  step('fetch', 'action-http', 'succeeded', { status: 200, amount })
  step('big', 'condition', 'succeeded', { result: branch })
  step('vip', 'output-log', branch ? 'succeeded' : 'skipped', branch ? { logged: true } : null)
  step('normal', 'output-log', branch ? 'skipped' : 'succeeded', branch ? null : { logged: true })
  return execId
}

async function makeWorkflow(name, graph) {
  const res = await authed(request(app).post(`/api/workspaces/${workspaceId}/workflows`)).send({
    name,
  })
  const id = res.body.workflow.id
  await authed(request(app).put(`/api/workflows/${id}/graph`)).send(graph)
  return id
}

const workflowRow = (id) => db.prepare('SELECT * FROM workflows WHERE id = ?').get(id)

beforeAll(async () => {
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ email: 'preview@example.com', password: 'password123', displayName: 'P' })
  token = reg.body.token
  const ws = await authed(request(app).get('/api/workspaces'))
  workspaceId = ws.body.workspaces[0].id
})

describe('stub selection', () => {
  it('settles only the nodes whose work reaches outside FlowForge', () => {
    const recorded = {
      outputs: {
        fetch: { status: 200, amount: 900 },
        big: { result: true },
        hook: { triggered: true },
      },
    }
    const stubs = stubsFor(graphWithThreshold(500).nodes, recorded)
    // The HTTP node is settled from the recording; the condition is the thing
    // under test and must actually run.
    expect(Object.keys(stubs)).toEqual(['fetch'])
    expect(stubs.fetch).toEqual({ status: 200, amount: 900 })
    expect(STUBBED_TYPES.has('condition')).toBe(false)
  })

  it('leaves a node the original run never reached without one', () => {
    const stubs = stubsFor(
      [node('new', 'action-http', { url: 'https://x.example.com' })],
      { outputs: {} }
    )
    expect(stubs).toEqual({})
  })
})

describe('previewDeploy', () => {
  it('reports nothing when the graph is unchanged, despite every call being simulated', async () => {
    const wfId = await makeWorkflow('Unchanged', graphWithThreshold(500))
    seedRun(wfId, { amount: 900, branch: true, i: 0 })
    seedRun(wfId, { amount: 100, branch: false, i: 1 })

    const report = await previewDeploy(workflowRow(wfId), graphWithThreshold(500))
    expect(report.analysed).toBe(true)
    expect(report.runs).toBe(2)
    expect(report.identical).toBe(2)
    expect(report.changed).toEqual([])
  })

  it('finds the runs an edited threshold would route differently', async () => {
    const wfId = await makeWorkflow('Rerouted', graphWithThreshold(500))
    seedRun(wfId, { amount: 900, branch: true, i: 0 }) // still true at 800
    seedRun(wfId, { amount: 600, branch: true, i: 1 }) // false at 800 — changes
    seedRun(wfId, { amount: 100, branch: false, i: 2 }) // still false

    const report = await previewDeploy(workflowRow(wfId), graphWithThreshold(800))
    expect(report.identical).toBe(2)
    expect(report.changed).toHaveLength(1)

    const [change] = report.changed
    expect(change.difference.routed).toEqual([{ nodeId: 'big', before: true, after: false }])
    expect(change.difference.started).toEqual(['normal'])
    expect(change.difference.stopped).toEqual(['vip'])
    expect(report.summary).toMatchObject({
      changed: 1,
      routingChanges: 1,
      nodesStarted: ['normal'],
      nodesStopped: ['vip'],
    })
  })

  it('reports a node a change newly brings into play', async () => {
    const wfId = await makeWorkflow('Added', graphWithThreshold(500))
    seedRun(wfId, { amount: 900, branch: true, i: 0 })

    const candidate = graphWithThreshold(500)
    candidate.nodes.push(node('audit', 'output-log', { message: 'audit' }, 'Audit'))
    candidate.edges.push(edge('vip', 'audit'))

    const [change] = (await previewDeploy(workflowRow(wfId), candidate)).changed
    expect(change.difference.started).toEqual(['audit'])
    expect(change.difference.stopped).toEqual([])
  })

  it('leaves no trace of the runs it made', async () => {
    const wfId = await makeWorkflow('Traceless', graphWithThreshold(500))
    seedRun(wfId, { amount: 900, branch: true, i: 0 })
    const before = db
      .prepare('SELECT COUNT(*) AS n FROM executions WHERE workflow_id = ?')
      .get(wfId).n

    await previewDeploy(workflowRow(wfId), graphWithThreshold(800))

    const after = db
      .prepare('SELECT COUNT(*) AS n FROM executions WHERE workflow_id = ?')
      .get(wfId).n
    expect(after).toBe(before)
    // And the steps cascaded with them.
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM execution_steps').get().n
    ).toBe(db.prepare(
      'SELECT COUNT(*) AS n FROM execution_steps s JOIN executions e ON e.id = s.execution_id'
    ).get().n)
  })

  it('includes failed runs, because "this stops failing" is half the answer', async () => {
    const wfId = await makeWorkflow('Failing', graphWithThreshold(500))
    seedRun(wfId, { amount: 900, branch: true, status: 'failed', i: 0 })

    const report = await previewDeploy(workflowRow(wfId), graphWithThreshold(500))
    expect(report.runs).toBe(1)
    // The replay completes where the original failed, which is a status change.
    expect(report.changed[0].difference.statusChanged).toBe(true)
    expect(report.summary.statusChanges).toBe(1)
  })

  it('says it could not analyse a workflow with no history', async () => {
    const wfId = await makeWorkflow('Fresh', graphWithThreshold(500))
    const report = await previewDeploy(workflowRow(wfId), graphWithThreshold(500))
    expect(report.analysed).toBe(false)
    expect(report.reason).toBe('no-runs')
  })

  it('caps how many runs it will replay', async () => {
    const wfId = await makeWorkflow('Busy', graphWithThreshold(500))
    for (let i = 0; i < 6; i++) seedRun(wfId, { amount: 100, branch: false, i })
    expect((await previewDeploy(workflowRow(wfId), graphWithThreshold(500), { runs: 3 })).runs).toBe(3)
    expect((await previewDeploy(workflowRow(wfId), graphWithThreshold(500), { runs: 999 })).runs).toBe(6)
  })
})

describe('POST /api/workflows/:id/preview', () => {
  let wfId

  beforeAll(async () => {
    wfId = await makeWorkflow('Served', graphWithThreshold(500))
    seedRun(wfId, { amount: 600, branch: true, i: 0 })
  })

  it('previews the graph on screen against the stored history', async () => {
    const res = await authed(request(app).post(`/api/workflows/${wfId}/preview`)).send({
      ...graphWithThreshold(800),
      runs: 5,
    })
    expect(res.status).toBe(200)
    expect(res.body.workflowId).toBe(wfId)
    expect(res.body.changed).toHaveLength(1)
    expect(res.body.changed[0].difference.routed[0].nodeId).toBe('big')
  })

  it('previews the saved graph when no body is posted', async () => {
    const res = await authed(request(app).post(`/api/workflows/${wfId}/preview`)).send({})
    expect(res.status).toBe(200)
    expect(res.body.identical).toBe(1)
  })

  it('refuses an empty graph and an oversized one', async () => {
    const empty = await authed(request(app).post(`/api/workflows/${wfId}/preview`)).send({
      nodes: [],
      edges: [],
    })
    expect(empty.status).toBe(400)

    const huge = await authed(request(app).post(`/api/workflows/${wfId}/preview`)).send({
      nodes: Array.from({ length: 501 }, (_, i) => node(`n${i}`, 'output-log')),
      edges: [],
    })
    expect(huge.status).toBe(400)
  })

  it('is refused for a viewer, and 404s for a non-member', async () => {
    const viewer = await request(app)
      .post('/api/auth/register')
      .send({ email: 'preview-viewer@example.com', password: 'password123', displayName: 'V' })
    await authed(request(app).post(`/api/workspaces/${workspaceId}/members`)).send({
      email: 'preview-viewer@example.com',
      role: 'viewer',
    })
    const refused = await request(app)
      .post(`/api/workflows/${wfId}/preview`)
      .set('Authorization', `Bearer ${viewer.body.token}`)
      .send({})
    expect(refused.status).toBe(403)

    const stranger = await request(app)
      .post('/api/auth/register')
      .send({ email: 'preview-stranger@example.com', password: 'password123', displayName: 'S' })
    const missing = await request(app)
      .post(`/api/workflows/${wfId}/preview`)
      .set('Authorization', `Bearer ${stranger.body.token}`)
      .send({})
    expect(missing.status).toBe(404)
  })
})
