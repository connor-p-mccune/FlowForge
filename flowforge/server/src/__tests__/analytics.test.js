const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const jwt = require('jsonwebtoken')
const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')

// julianday()-based durations carry tiny float error; the route rounds to whole ms.
const near = (actual, expected, tol = 2) => Math.abs(actual - expected) <= tol

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

// UTC noon of (today - daysAgo), offset by `ms`, so timestamps land on a known day.
function dayIso(daysAgo, ms = 0) {
  const n = new Date()
  const base = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() - daysAgo, 12, 0, 0)
  return new Date(base + ms).toISOString()
}
function dayKey(daysAgo) {
  const n = new Date()
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() - daysAgo))
    .toISOString().slice(0, 10)
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

// steps: [{ nodeId, nodeType, status, durMs }] — skipped steps get zero duration.
function insertExecution(wfId, userId, status, startIso, durMs, steps) {
  const execId = uuidv4()
  const finished = new Date(new Date(startIso).getTime() + durMs).toISOString()
  db.prepare(
    'INSERT INTO executions (id, workflow_id, status, triggered_by, started_at, finished_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(execId, wfId, status, userId, startIso, finished, startIso)

  const ins = db.prepare(
    'INSERT INTO execution_steps (id, execution_id, node_id, node_type, status, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  for (const s of steps) {
    const stepFinish = s.status === 'skipped'
      ? startIso
      : new Date(new Date(startIso).getTime() + s.durMs).toISOString()
    ins.run(uuidv4(), execId, s.nodeId, s.nodeType, s.status, startIso, stepFinish)
  }
  return execId
}

let token, userId, wsId, wfA, wfB

beforeAll(async () => {
  const owner = await register('analytics-owner@example.com', 'Analytics')
  token = owner.token
  userId = owner.userId
  wsId = await firstWorkspaceId(token)

  wfA = insertWorkflow(wsId, userId, 'Alpha Flow', ['trigger-manual', 'action-http', 'action-http', 'output-log'])
  wfB = insertWorkflow(wsId, userId, 'Beta Flow', ['trigger-webhook', 'ai-prompt'])

  const [mA, aA1, aA2, oA] = wfA.nodeIds
  const [tB, pB] = wfB.nodeIds

  // 3 completed Alpha runs on day-2 (duration 1000ms; http steps 100ms + 300ms)
  for (let i = 0; i < 3; i++) {
    insertExecution(wfA.id, userId, 'completed', dayIso(2, i * 1000), 1000, [
      { nodeId: mA, nodeType: 'trigger-manual', status: 'succeeded', durMs: 2 },
      { nodeId: aA1, nodeType: 'action-http', status: 'succeeded', durMs: 100 },
      { nodeId: aA2, nodeType: 'action-http', status: 'succeeded', durMs: 300 },
      { nodeId: oA, nodeType: 'output-log', status: 'succeeded', durMs: 2 },
    ])
  }
  // 1 failed Alpha run on day-2 (duration 500ms; http fails, rest skipped)
  insertExecution(wfA.id, userId, 'failed', dayIso(2, 5000), 500, [
    { nodeId: mA, nodeType: 'trigger-manual', status: 'succeeded', durMs: 2 },
    { nodeId: aA1, nodeType: 'action-http', status: 'failed', durMs: 50 },
    { nodeId: aA2, nodeType: 'action-http', status: 'skipped' },
    { nodeId: oA, nodeType: 'output-log', status: 'skipped' },
  ])
  // 1 completed Beta run on day-2, 1 on day-20 (outside 7d, inside 30d). ai-prompt 1000ms.
  for (const daysAgo of [2, 20]) {
    insertExecution(wfB.id, userId, 'completed', dayIso(daysAgo, 6000), 1200, [
      { nodeId: tB, nodeType: 'trigger-webhook', status: 'succeeded', durMs: 1 },
      { nodeId: pB, nodeType: 'ai-prompt', status: 'succeeded', durMs: 1000 },
    ])
  }
})

describe('GET /analytics/summary', () => {
  it('aggregates totals, success rate, and avg duration over 30 days', async () => {
    const res = await request(app)
      .get(`/api/workspaces/${wsId}/analytics/summary?days=30`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    const s = res.body.summary
    expect(s.totalExecutions).toBe(6)
    expect(s.successful).toBe(5)
    expect(s.failed).toBe(1)
    expect(s.running).toBe(0)
    expect(s.successRate).toBeCloseTo(5 / 6, 5)
    // (3*1000 + 500 + 1200 + 1200) / 6 = 983.3
    expect(near(s.avgDurationMs, 983)).toBe(true)
    expect(res.body.range.days).toBe(30)
  })

  it('narrows the window with days=7 (excludes the 20-day-old run)', async () => {
    const res = await request(app)
      .get(`/api/workspaces/${wsId}/analytics/summary?days=7`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.summary.totalExecutions).toBe(5)
    expect(res.body.summary.successful).toBe(4)
    expect(res.body.summary.failed).toBe(1)
  })

  it('defaults to 30 days and clamps to 365', async () => {
    const def = await request(app)
      .get(`/api/workspaces/${wsId}/analytics/summary`)
      .set('Authorization', `Bearer ${token}`)
    expect(def.body.range.days).toBe(30)

    const clamped = await request(app)
      .get(`/api/workspaces/${wsId}/analytics/summary?days=9999`)
      .set('Authorization', `Bearer ${token}`)
    expect(clamped.body.range.days).toBe(365)

    const garbage = await request(app)
      .get(`/api/workspaces/${wsId}/analytics/summary?days=nonsense`)
      .set('Authorization', `Bearer ${token}`)
    expect(garbage.body.range.days).toBe(30)
  })

  it('requires auth and hides non-member workspaces', async () => {
    const noAuth = await request(app).get(`/api/workspaces/${wsId}/analytics/summary`)
    expect(noAuth.status).toBe(401)

    const { token: other } = await register('stranger@example.com', 'Stranger')
    const forbidden = await request(app)
      .get(`/api/workspaces/${wsId}/analytics/summary`)
      .set('Authorization', `Bearer ${other}`)
    expect(forbidden.status).toBe(404)
  })
})

describe('GET /analytics/timeline', () => {
  it('returns one gap-filled bucket per day, ending today', async () => {
    const res = await request(app)
      .get(`/api/workspaces/${wsId}/analytics/timeline?days=30`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.timeline).toHaveLength(30)
    expect(res.body.timeline.at(-1).date).toBe(dayKey(0))

    const total = res.body.timeline.reduce((a, b) => a + b.total, 0)
    expect(total).toBe(6) // matches the 30-day summary

    const day2 = res.body.timeline.find((b) => b.date === dayKey(2))
    expect(day2).toMatchObject({ completed: 4, failed: 1, total: 5 })

    const day20 = res.body.timeline.find((b) => b.date === dayKey(20))
    expect(day20).toMatchObject({ completed: 1, total: 1 })
  })

  it('honors the days param length', async () => {
    const res = await request(app)
      .get(`/api/workspaces/${wsId}/analytics/timeline?days=7`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.timeline).toHaveLength(7)
  })
})

describe('GET /analytics/node-usage', () => {
  it('counts node types from graphs and averages successful step durations', async () => {
    const res = await request(app)
      .get(`/api/workspaces/${wsId}/analytics/node-usage`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    const byType = Object.fromEntries(res.body.nodeUsage.map((n) => [n.nodeType, n]))

    // Static counts from the two workflow graphs
    expect(byType['action-http'].count).toBe(2)
    expect(byType['trigger-manual'].count).toBe(1)
    expect(byType['output-log'].count).toBe(1)
    expect(byType['trigger-webhook'].count).toBe(1)
    expect(byType['ai-prompt'].count).toBe(1)

    // Averages from succeeded steps only (failed/skipped excluded)
    expect(byType['action-http'].executions).toBe(6) // 3 completed runs * 2 http steps
    expect(near(byType['action-http'].avgDurationMs, 200)).toBe(true) // mean of 100 & 300
    expect(near(byType['ai-prompt'].avgDurationMs, 1000)).toBe(true)
    expect(near(byType['output-log'].avgDurationMs, 2)).toBe(true)

    // Most-used first
    expect(res.body.nodeUsage[0].count).toBe(2)
  })
})

describe('GET /analytics/workflows', () => {
  it('returns per-workflow stats, default sorted by executions desc', async () => {
    const res = await request(app)
      .get(`/api/workspaces/${wsId}/analytics/workflows?days=90`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.workflows).toHaveLength(2)

    const [first, second] = res.body.workflows
    expect(first.name).toBe('Alpha Flow')
    expect(first.executions).toBe(4)
    expect(first.successful).toBe(3)
    expect(first.failed).toBe(1)
    expect(first.successRate).toBeCloseTo(0.75, 5)
    expect(near(first.avgDurationMs, 875)).toBe(true) // (3*1000 + 500) / 4
    expect(first.lastRun).toBeTruthy()

    expect(second.name).toBe('Beta Flow')
    expect(second.executions).toBe(2)
    expect(second.successRate).toBeCloseTo(1, 5)
  })

  it('supports server-side sort via a whitelist', async () => {
    const res = await request(app)
      .get(`/api/workspaces/${wsId}/analytics/workflows?days=90&sort=avgDurationMs&order=desc`)
      .set('Authorization', `Bearer ${token}`)
    // Beta avg (1200) > Alpha avg (875)
    expect(res.body.workflows.map((w) => w.name)).toEqual(['Beta Flow', 'Alpha Flow'])
  })

  it('hides non-member workspaces', async () => {
    const { token: other } = await register('outsider@example.com', 'Outsider')
    const res = await request(app)
      .get(`/api/workspaces/${wsId}/analytics/workflows`)
      .set('Authorization', `Bearer ${other}`)
    expect(res.status).toBe(404)
  })
})
