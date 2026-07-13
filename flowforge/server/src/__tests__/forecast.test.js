// GET /api/workflows/:id/forecast (session) and /api/v1/... (public): the
// predictive next-run estimate over recorded step timing.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))

const jwt = require('jsonwebtoken')
const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')

let token, userId, wsId, wf

// A diamond: trigger → (fast, slow) → join.
const NODE = (id, type) => ({ id, type, position: { x: 0, y: 0 }, data: { label: id } })

function insertWorkflow() {
  const id = uuidv4()
  const graph = {
    nodes: [NODE('t', 'trigger-manual'), NODE('fast', 'action-http'), NODE('slow', 'action-http'), NODE('join', 'output-log')],
    edges: [
      { source: 't', target: 'fast' },
      { source: 't', target: 'slow' },
      { source: 'fast', target: 'join' },
      { source: 'slow', target: 'join' },
    ],
  }
  db.prepare(
    'INSERT INTO workflows (id, workspace_id, name, graph_json, created_by) VALUES (?, ?, ?, ?, ?)'
  ).run(id, wsId, 'Forecast Flow', JSON.stringify(graph), userId)
  return id
}

// One completed run whose steps take the given per-node durations (ms).
function insertRun(workflowId, durations) {
  const execId = uuidv4()
  const start = new Date()
  db.prepare(
    "INSERT INTO executions (id, workflow_id, status, triggered_by, trigger_type, started_at, finished_at, created_at) VALUES (?, ?, 'completed', ?, 'webhook', ?, ?, ?)"
  ).run(execId, workflowId, userId, start.toISOString(), new Date(start.getTime() + 1000).toISOString(), start.toISOString())
  const ins = db.prepare(
    'INSERT INTO execution_steps (id, execution_id, node_id, node_type, status, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  const typeOf = { t: 'trigger-manual', fast: 'action-http', slow: 'action-http', join: 'output-log' }
  for (const [nodeId, ms] of Object.entries(durations)) {
    ins.run(uuidv4(), execId, nodeId, typeOf[nodeId], 'succeeded', start.toISOString(), new Date(start.getTime() + ms).toISOString())
  }
}

beforeAll(async () => {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: 'forecast@example.com', password: 'password123', displayName: 'Forecast' })
  token = res.body.token
  userId = jwt.decode(token).id
  const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`)
  wsId = ws.body.workspaces[0].id
  wf = insertWorkflow()
  // 12 completed runs: fast ~100ms, slow ~500ms, join ~40ms.
  for (let i = 0; i < 12; i++) {
    insertRun(wf, { t: 1, fast: 100 + (i % 3) * 5, slow: 500 + (i % 3) * 10, join: 40 })
  }
})

describe('GET /api/workflows/:id/forecast', () => {
  it('requires authentication', async () => {
    const res = await request(app).get(`/api/workflows/${wf}/forecast`)
    expect(res.status).toBe(401)
  })

  it('estimates the makespan and picks the slow branch as the critical path', async () => {
    const res = await request(app)
      .get(`/api/workflows/${wf}/forecast`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.available).toBe(true)
    expect(res.body.criticalPath).toEqual(['t', 'slow', 'join'])
    // slow (~500) + join (~40) dominates fast (~100) + join.
    expect(res.body.estimatedMs).toBeGreaterThan(520)
    expect(res.body.estimatedMs).toBeLessThan(560)
    expect(res.body.estimatedP95Ms).toBeGreaterThanOrEqual(res.body.estimatedMs)
    expect(res.body.bottleneck.nodeId).toBe('slow')
  })

  it('reports full coverage once every work node has history', async () => {
    const res = await request(app)
      .get(`/api/workflows/${wf}/forecast`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.coverage).toEqual({ nodesWithHistory: 3, workNodes: 3, ratio: 1 })
  })

  it('404s for a workflow the user cannot see', async () => {
    const other = await request(app)
      .post('/api/auth/register')
      .send({ email: 'forecast-out@example.com', password: 'password123', displayName: 'Out' })
    const res = await request(app)
      .get(`/api/workflows/${wf}/forecast`)
      .set('Authorization', `Bearer ${other.body.token}`)
    expect(res.status).toBe(404)
  })

  it('is available but empty for a workflow with no run history', async () => {
    const fresh = insertWorkflow()
    const res = await request(app)
      .get(`/api/workflows/${fresh}/forecast`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.available).toBe(true)
    expect(res.body.estimatedMs).toBe(0)
    expect(res.body.bottleneck).toBeNull()
    expect(res.body.coverage.nodesWithHistory).toBe(0)
  })
})

describe('GET /api/v1/workflows/:id/forecast', () => {
  it('serves the forecast to a read token', async () => {
    const minted = await request(app)
      .post('/api/tokens')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'reader', scopes: ['read'] })
    const res = await request(app)
      .get(`/api/v1/workflows/${wf}/forecast`)
      .set('Authorization', `Bearer ${minted.body.token}`)
    expect(res.status).toBe(200)
    expect(res.body.bottleneck.nodeId).toBe('slow')
  })

  it('requires the read scope', async () => {
    const minted = await request(app)
      .post('/api/tokens')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'trig', scopes: ['trigger'] })
    const res = await request(app)
      .get(`/api/v1/workflows/${wf}/forecast`)
      .set('Authorization', `Bearer ${minted.body.token}`)
    expect(res.status).toBe(403)
  })
})
