// Regression attribution end to end: a workflow that got slower, and the answer
// to *what changed*.
//
// The detector has its own suite (changePoint.test.js). What is pinned here is
// the attribution, which is where the feature earns its keep — a change point
// with no deploy near it and one with exactly one deploy near it are different
// findings, and conflating them would send somebody to re-read a diff that
// explains nothing.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const request = require('supertest')
const { v4: uuidv4 } = require('uuid')

jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: jest.fn() }) }))
jest.mock('../config/redis', () => ({ publish: jest.fn().mockResolvedValue(1) }))

const db = require('../config/database')
const { app } = require('../index')
const { analyzeRegressions } = require('../services/regressions')

const node = (id, type, config = {}, label = id) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label, config },
})

const graphWith = (url) => ({
  nodes: [
    node('t1', 'trigger-webhook', {}, 'Hook'),
    node('fetch', 'action-http', { url, method: 'GET' }, 'Fetch orders'),
  ],
  edges: [{ id: 'e1', source: 't1', target: 'fetch' }],
})

const DAY = 24 * 60 * 60 * 1000
const START = Date.UTC(2026, 0, 1)
const at = (i) => new Date(START + i * 60 * 60 * 1000).toISOString()

let token
let workspaceId
let apiToken
const authed = (req) => req.set('Authorization', `Bearer ${token}`)

// One completed run at hour `i`, lasting `ms`, with one step of `stepMs`.
function seedRun(workflowId, i, ms, stepMs = ms - 10) {
  const execId = uuidv4()
  const started = new Date(START + i * 60 * 60 * 1000)
  const finished = new Date(started.getTime() + ms)
  db.prepare(
    `INSERT INTO executions (id, workflow_id, status, trigger_type, started_at, finished_at, created_at)
     VALUES (?, ?, 'completed', 'webhook', ?, ?, ?)`
  ).run(execId, workflowId, started.toISOString(), finished.toISOString(), at(i))
  db.prepare(
    `INSERT INTO execution_steps (id, execution_id, node_id, node_type, status, started_at, finished_at)
     VALUES (?, ?, 'fetch', 'action-http', 'succeeded', ?, ?)`
  ).run(
    uuidv4(),
    execId,
    started.toISOString(),
    new Date(started.getTime() + stepMs).toISOString()
  )
  return execId
}

// A deploy: the version snapshot the deploy route writes.
function seedVersion(workflowId, version, graph, createdAt) {
  db.prepare(
    `INSERT INTO workflow_versions (id, workflow_id, version, graph_json, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(uuidv4(), workflowId, version, JSON.stringify(graph), createdAt)
}

async function makeWorkflow(name) {
  const res = await authed(request(app).post(`/api/workspaces/${workspaceId}/workflows`)).send({
    name,
  })
  return res.body.workflow.id
}

beforeAll(async () => {
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ email: 'regressions@example.com', password: 'password123', displayName: 'R' })
  token = reg.body.token
  const ws = await authed(request(app).get('/api/workspaces'))
  workspaceId = ws.body.workspaces[0].id
  const minted = await authed(request(app).post('/api/tokens')).send({
    name: 'ci',
    scopes: ['read'],
  })
  apiToken = minted.body.token
})

describe('analyzeRegressions', () => {
  it('blames the one deploy that landed in the window, and says what it changed', async () => {
    const wfId = await makeWorkflow('Order sync')
    // 30 fast runs, then a deploy, then 30 slow ones.
    for (let i = 0; i < 30; i++) seedRun(wfId, i, 200)
    // An earlier deploy the change cannot be blamed on, and the one that can.
    seedVersion(wfId, 1, graphWith('https://api.example.com/v1/orders'), at(5))
    seedVersion(wfId, 2, graphWith('https://api.example.com/v2/orders'), at(29.7))
    for (let i = 30; i < 60; i++) seedRun(wfId, i, 950)

    const report = analyzeRegressions(wfId)
    expect(report.analysed).toBe(true)
    expect(report.ok).toBe(false)
    expect(report.changePoints).toHaveLength(1)

    const [change] = report.changePoints
    expect(change.direction).toBe('worse')
    expect(change.before.median).toBe(200)
    expect(change.after.median).toBe(950)
    expect(change.cause).toBe('deploy')
    expect(change.deploys).toHaveLength(1)
    expect(change.deploys[0].version).toBe(2)
    // A version number is a pointer; the diff is the answer.
    expect(change.deploys[0].changed.changedNodes).toEqual([
      { nodeId: 'fetch', label: 'Fetch orders', changes: ['config.url'] },
    ])
    // And the step that moved names a node on the canvas.
    expect(change.steps[0]).toMatchObject({ nodeId: 'fetch', nodeType: 'action-http' })
    expect(change.steps[0].delta).toBeGreaterThan(700)
  })

  it('reports "nothing was deployed" as a finding rather than a blank', async () => {
    const wfId = await makeWorkflow('Report build')
    for (let i = 0; i < 30; i++) seedRun(wfId, i, 300)
    for (let i = 30; i < 60; i++) seedRun(wfId, i, 1200)
    // The only deploy is long before the change.
    seedVersion(wfId, 1, graphWith('https://api.example.com/x'), new Date(START - DAY).toISOString())

    const [change] = analyzeRegressions(wfId).changePoints
    expect(change.cause).toBe('external')
    expect(change.deploys).toEqual([])
  })

  it('will not name a suspect when several deploys landed in the same window', async () => {
    const wfId = await makeWorkflow('Busy')
    for (let i = 0; i < 30; i++) seedRun(wfId, i, 250)
    seedVersion(wfId, 1, graphWith('https://a.example.com'), at(29.3))
    seedVersion(wfId, 2, graphWith('https://b.example.com'), at(29.6))
    for (let i = 30; i < 60; i++) seedRun(wfId, i, 1100)

    const [change] = analyzeRegressions(wfId).changePoints
    expect(change.cause).toBe('ambiguous')
    expect(change.deploys.map((d) => d.version)).toEqual([1, 2])
    // With several, the list is the answer and each diff would be noise.
    expect(change.deploys.every((d) => d.changed === null)).toBe(true)
  })

  it('reports an improvement without failing the gate', async () => {
    const wfId = await makeWorkflow('Optimised')
    for (let i = 0; i < 30; i++) seedRun(wfId, i, 1000)
    for (let i = 30; i < 60; i++) seedRun(wfId, i, 150)

    const report = analyzeRegressions(wfId)
    expect(report.changePoints[0].direction).toBe('better')
    expect(report.ok).toBe(true)
  })

  it('says it could not analyse a young workflow, and passes the gate', async () => {
    const wfId = await makeWorkflow('New')
    for (let i = 0; i < 4; i++) seedRun(wfId, i, 300)

    const report = analyzeRegressions(wfId)
    expect(report.analysed).toBe(false)
    expect(report.reason).toBe('not-enough-runs')
    // Failing every young workflow's build would get the check removed.
    expect(report.ok).toBe(true)
  })

  it('ignores dry runs, failures, and sub-workflow children', async () => {
    const wfId = await makeWorkflow('Filtered')
    for (let i = 0; i < 30; i++) seedRun(wfId, i, 200)
    for (let i = 30; i < 60; i++) seedRun(wfId, i, 900)

    // Noise the population must not admit: a slow test run, a failure whose
    // wall time measures how long it took to break, and a nested child.
    const dry = seedRun(wfId, 61, 9000)
    db.prepare("UPDATE executions SET trigger_type = 'dry-run' WHERE id = ?").run(dry)
    const failed = seedRun(wfId, 62, 9000)
    db.prepare("UPDATE executions SET status = 'failed' WHERE id = ?").run(failed)
    const child = seedRun(wfId, 63, 9000)
    db.prepare('UPDATE executions SET parent_execution_id = ? WHERE id = ?').run(dry, child)

    const report = analyzeRegressions(wfId)
    expect(report.runs).toBe(60)
    expect(report.changePoints[0].after.median).toBe(900)
  })
})

describe('the endpoints', () => {
  let wfId

  beforeAll(async () => {
    wfId = await makeWorkflow('Served')
    for (let i = 0; i < 30; i++) seedRun(wfId, i, 200)
    seedVersion(wfId, 1, graphWith('https://api.example.com/v1'), at(29.5))
    for (let i = 30; i < 60; i++) seedRun(wfId, i, 900)
  })

  it('serves the report to a member', async () => {
    const res = await authed(request(app).get(`/api/workflows/${wfId}/regressions`))
    expect(res.status).toBe(200)
    expect(res.body.workflowId).toBe(wfId)
    expect(res.body.changePoints[0].direction).toBe('worse')
  })

  it('honours the window', async () => {
    const res = await authed(request(app).get(`/api/workflows/${wfId}/regressions?limit=20`))
    expect(res.body.runs).toBeLessThanOrEqual(20)
  })

  it('404s for a non-member', async () => {
    const other = await request(app)
      .post('/api/auth/register')
      .send({ email: 'reg-other@example.com', password: 'password123', displayName: 'O' })
    const res = await request(app)
      .get(`/api/workflows/${wfId}/regressions`)
      .set('Authorization', `Bearer ${other.body.token}`)
    expect(res.status).toBe(404)
  })

  it('serves the CI shape on the public API', async () => {
    const res = await request(app)
      .get(`/api/v1/workflows/${wfId}/regressions`)
      .set('Authorization', `Bearer ${apiToken}`)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(res.body.changePoints[0].cause).toBe('deploy')
  })

  it('needs a token', async () => {
    expect((await request(app).get(`/api/v1/workflows/${wfId}/regressions`)).status).toBe(401)
  })
})
