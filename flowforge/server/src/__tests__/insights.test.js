const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const jwt = require('jsonwebtoken')
const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')

async function register(email, displayName) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'password123', displayName })
  return { token: res.body.token, userId: jwt.decode(res.body.token).id }
}

async function firstWorkspaceId(token) {
  const res = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`)
  return res.body.workspaces[0].id
}

function insertWorkflow(wsId, userId, name, nodeTypes) {
  const id = uuidv4()
  const nodes = nodeTypes.map((type, i) => ({
    id: `${id}-n${i}`, type, position: { x: i * 120, y: 0 }, data: { label: type },
  }))
  db.prepare(
    'INSERT INTO workflows (id, workspace_id, name, graph_json, created_by) VALUES (?, ?, ?, ?, ?)'
  ).run(id, wsId, name, JSON.stringify({ nodes, edges: [] }), userId)
  return { id, nodeIds: nodes.map((n) => n.id) }
}

// Insert a terminal run `createdMinutesAgo` minutes back with a fixed wall time.
function insertRun(wfId, userId, { status, durMs, createdMinutesAgo, triggerType = 'webhook', steps = [] }) {
  const execId = uuidv4()
  const created = new Date(Date.now() - createdMinutesAgo * 60000)
  const startIso = created.toISOString()
  const finished = durMs == null ? null : new Date(created.getTime() + durMs).toISOString()
  db.prepare(
    `INSERT INTO executions (id, workflow_id, status, triggered_by, trigger_type, started_at, finished_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(execId, wfId, status, userId, triggerType, startIso, finished, startIso)
  const ins = db.prepare(
    'INSERT INTO execution_steps (id, execution_id, node_id, node_type, status, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  for (const s of steps) {
    const stepFinish = new Date(created.getTime() + s.durMs).toISOString()
    ins.run(uuidv4(), execId, s.nodeId, s.nodeType, s.status, startIso, stepFinish)
  }
  return execId
}

let token, userId, wsId, wf

beforeAll(async () => {
  const owner = await register('insights-owner@example.com', 'Insights Owner')
  token = owner.token
  userId = owner.userId
  wsId = await firstWorkspaceId(token)
  wf = insertWorkflow(wsId, userId, 'Insight Flow', ['trigger-webhook', 'action-http', 'output-log'])
  const [, http, out] = wf.nodeIds

  // 10 healthy completed runs clustered around ~1000ms, plus one clear outlier
  // at 20000ms, and 2 failures. One dry-run must be ignored entirely.
  let m = 600
  for (let i = 0; i < 10; i++) {
    insertRun(wf.id, userId, {
      status: 'completed', durMs: 1000 + i * 10, createdMinutesAgo: m--,
      steps: [
        { nodeId: http, nodeType: 'action-http', status: 'succeeded', durMs: 800 },
        { nodeId: out, nodeType: 'output-log', status: 'succeeded', durMs: 5 },
      ],
    })
  }
  insertRun(wf.id, userId, { status: 'completed', durMs: 20000, createdMinutesAgo: m--,
    steps: [{ nodeId: http, nodeType: 'action-http', status: 'succeeded', durMs: 19000 }] })
  insertRun(wf.id, userId, { status: 'failed', durMs: 200, createdMinutesAgo: m-- })
  insertRun(wf.id, userId, { status: 'failed', durMs: 300, createdMinutesAgo: m-- })
  insertRun(wf.id, userId, { status: 'cancelled', durMs: 50, createdMinutesAgo: m-- })
  insertRun(wf.id, userId, { status: 'running', durMs: null, createdMinutesAgo: m-- })
  // Test-mode run — must never appear in insights.
  insertRun(wf.id, userId, { status: 'completed', durMs: 99999, createdMinutesAgo: m--, triggerType: 'dry-run' })
})

describe('GET /api/workflows/:id/insights', () => {
  it('requires authentication', async () => {
    const res = await request(app).get(`/api/workflows/${wf.id}/insights`)
    expect(res.status).toBe(401)
  })

  it('404s for a workflow the user cannot see', async () => {
    const other = await register('insights-outsider@example.com', 'Outsider')
    const res = await request(app)
      .get(`/api/workflows/${wf.id}/insights`)
      .set('Authorization', `Bearer ${other.token}`)
    expect(res.status).toBe(404)
  })

  it('excludes dry-runs and settles counts correctly', async () => {
    const res = await request(app)
      .get(`/api/workflows/${wf.id}/insights`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    // 10 healthy + 1 outlier completed, 2 failed, 1 cancelled, 1 running = 15.
    // The dry-run (16th) is excluded.
    expect(res.body.counts.total).toBe(15)
    expect(res.body.counts.completed).toBe(11)
    expect(res.body.counts.failed).toBe(2)
    expect(res.body.counts.cancelled).toBe(1)
    expect(res.body.counts.running).toBe(1)
  })

  it('computes success rate over settled runs, excluding cancels', async () => {
    const { body } = await request(app)
      .get(`/api/workflows/${wf.id}/insights`)
      .set('Authorization', `Bearer ${token}`)
    // 11 completed / (11 completed + 2 failed) = 0.846…
    expect(body.successRate).toBeCloseTo(11 / 13, 5)
  })

  it('reports duration percentiles over completed runs only', async () => {
    const { body } = await request(app)
      .get(`/api/workflows/${wf.id}/insights`)
      .set('Authorization', `Bearer ${token}`)
    expect(body.duration.count).toBe(11)
    // p50 sits in the ~1000ms cluster, not near the 20s outlier.
    expect(body.duration.p50).toBeGreaterThan(900)
    expect(body.duration.p50).toBeLessThan(1200)
    expect(body.duration.max).toBeGreaterThanOrEqual(19900)
  })

  it('flags the 20s run as an anomaly and leaves the healthy runs alone', async () => {
    const { body } = await request(app)
      .get(`/api/workflows/${wf.id}/insights`)
      .set('Authorization', `Bearer ${token}`)
    expect(body.anomalyCount).toBe(1)
    const flagged = body.recentRuns.filter((r) => r.isAnomaly)
    expect(flagged).toHaveLength(1)
    expect(flagged[0].durationMs).toBeGreaterThanOrEqual(19900)
    expect(flagged[0].severity).toBe('severe')
    // A running run has no duration and can't be judged.
    const running = body.recentRuns.find((r) => r.status === 'running')
    expect(running.severity).toBe('unknown')
    expect(running.durationMs).toBeNull()
  })

  it('surfaces the slowest steps, averaged over successful executions', async () => {
    const { body } = await request(app)
      .get(`/api/workflows/${wf.id}/insights`)
      .set('Authorization', `Bearer ${token}`)
    const [, httpNode, logNode] = wf.nodeIds
    expect(Array.isArray(body.slowestSteps)).toBe(true)
    // The http node is far slower than the log node, so it leads the ranking.
    expect(body.slowestSteps[0].nodeId).toBe(httpNode)
    expect(body.slowestSteps[0].nodeType).toBe('action-http')
    expect(body.slowestSteps[0].avgDurationMs).toBeGreaterThan(700)
    const logRow = body.slowestSteps.find((s) => s.nodeId === logNode)
    expect(logRow.avgDurationMs).toBeLessThan(body.slowestSteps[0].avgDurationMs)
  })

  it('honours the limit param', async () => {
    const { body } = await request(app)
      .get(`/api/workflows/${wf.id}/insights?limit=5`)
      .set('Authorization', `Bearer ${token}`)
    expect(body.window.limit).toBe(5)
    expect(body.recentRuns).toHaveLength(5)
  })

  it('reports throughput over the span the window covers', async () => {
    const { body } = await request(app)
      .get(`/api/workflows/${wf.id}/insights`)
      .set('Authorization', `Bearer ${token}`)
    expect(body.throughput.runs).toBe(15)
    expect(body.throughput.perDay).toBeGreaterThan(0)
  })
})
