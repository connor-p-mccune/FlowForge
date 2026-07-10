// Observability: the hand-rolled Prometheus registry, the /metrics endpoint
// (exposition format + optional bearer gating), request instrumentation, the
// engine's execution counters, and the deep readiness probe.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const mockAdd = jest.fn().mockResolvedValue(undefined)
const mockJobCounts = jest.fn().mockResolvedValue({ waiting: 3, active: 1 })
jest.mock('../config/queue', () => ({
  getExecutionQueue: () => ({ add: mockAdd, getJobCounts: mockJobCounts }),
}))

const mockPing = jest.fn().mockResolvedValue('PONG')
jest.mock('../config/redis', () => ({
  ping: (...a) => mockPing(...a),
  publish: jest.fn().mockResolvedValue(1),
}))

const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')
const metrics = require('../services/metrics')
const { runExecution } = require('../services/executionEngine')

function seedExecution(graph) {
  const userId = uuidv4()
  const wsId = uuidv4()
  const wfId = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, `${userId}@test.com`, 'x', 'Test', now)
  db.prepare(
    'INSERT INTO workspaces (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(wsId, 'WS', userId, now, now)
  db.prepare(
    'INSERT INTO workflows (id, workspace_id, name, graph_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(wfId, wsId, 'WF', JSON.stringify(graph), userId, now, now)
  const execId = uuidv4()
  db.prepare(
    'INSERT INTO executions (id, workflow_id, status, triggered_by, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(execId, wfId, 'pending', userId, now)
  return execId
}

afterEach(() => {
  delete process.env.METRICS_TOKEN
})

describe('metrics registry', () => {
  it('renders counters, gauges, and histograms in exposition format', async () => {
    const c = metrics.counter('test_widgets_total', 'Widgets made.', ['kind'])
    c.inc({ kind: 'round' })
    c.inc({ kind: 'round' }, 2)
    const g = metrics.gauge('test_temperature', 'Current temp.')
    g.set({}, 21.5)
    const h = metrics.histogram('test_latency_seconds', 'Latency.', [], [0.1, 1])
    h.observe({}, 0.05)
    h.observe({}, 0.5)

    const text = await metrics.renderPrometheus()
    expect(text).toContain('# TYPE test_widgets_total counter')
    expect(text).toContain('test_widgets_total{kind="round"} 3')
    expect(text).toContain('test_temperature 21.5')
    expect(text).toContain('test_latency_seconds_bucket{le="0.1"} 1')
    expect(text).toContain('test_latency_seconds_bucket{le="1"} 2')
    expect(text).toContain('test_latency_seconds_bucket{le="+Inf"} 2')
    expect(text).toContain('test_latency_seconds_count 2')
  })

  it('escapes label values', async () => {
    const c = metrics.counter('test_escapes_total', 'Escaping.', ['path'])
    c.inc({ path: 'a"b\\c' })
    const text = await metrics.renderPrometheus()
    expect(text).toContain('test_escapes_total{path="a\\"b\\\\c"} 1')
  })
})

describe('GET /metrics', () => {
  it('serves the exposition format with process and queue gauges', async () => {
    const res = await request(app).get('/metrics')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/plain/)
    expect(res.text).toContain('# TYPE flowforge_http_requests_total counter')
    expect(res.text).toContain('process_uptime_seconds')
    // Queue depth sampled from the (mocked) Bull queue at scrape time.
    expect(res.text).toContain('flowforge_queue_jobs{state="waiting"} 3')
    expect(res.text).toContain('flowforge_queue_jobs{state="active"} 1')
    // Outbound webhook backlog sampled from SQLite at scrape time.
    expect(res.text).toContain('flowforge_webhook_deliveries_pending 0')
  })

  it('labels requests with the matched route pattern, not the raw URL', async () => {
    await request(app).get('/api/workflows/some-random-id').set('Authorization', 'Bearer nope')
    const res = await request(app).get('/metrics')
    expect(res.text).toContain('route="/api/workflows/:id"')
    expect(res.text).not.toContain('some-random-id')
  })

  it('enforces METRICS_TOKEN when set', async () => {
    process.env.METRICS_TOKEN = 'scrape-secret'
    const denied = await request(app).get('/metrics')
    expect(denied.status).toBe(401)
    const allowed = await request(app)
      .get('/metrics')
      .set('Authorization', 'Bearer scrape-secret')
    expect(allowed.status).toBe(200)
  })

  it('survives a broken collector', async () => {
    mockJobCounts.mockRejectedValueOnce(new Error('redis gone'))
    const res = await request(app).get('/metrics')
    expect(res.status).toBe(200)
    expect(res.text).toContain('process_uptime_seconds')
  })
})

describe('execution metrics', () => {
  it('counts completed and failed runs with wall time', async () => {
    const ok = seedExecution({
      nodes: [{ id: 't', type: 'trigger-manual', position: { x: 0, y: 0 }, data: { label: 't', config: {} } }],
      edges: [],
    })
    await runExecution(ok, { publish: () => {} })

    const bad = seedExecution({
      nodes: [
        { id: 'a', type: 'transform', position: { x: 0, y: 0 }, data: { label: 'a', config: {} } },
        { id: 'b', type: 'transform', position: { x: 0, y: 0 }, data: { label: 'b', config: {} } },
      ],
      edges: [
        { id: 'ab', source: 'a', target: 'b' },
        { id: 'ba', source: 'b', target: 'a' },
      ], // cycle → failed
    })
    await runExecution(bad, { publish: () => {} })

    const text = await metrics.renderPrometheus()
    expect(text).toMatch(/flowforge_executions_total\{status="completed",nested="false"\} \d+/)
    expect(text).toMatch(/flowforge_executions_total\{status="failed",nested="false"\} \d+/)
    expect(text).toMatch(/flowforge_execution_duration_seconds_count\{status="completed"\} \d+/)
  })
})

describe('GET /api/health/ready', () => {
  it('is ready when the database and Redis respond', async () => {
    const res = await request(app).get('/api/health/ready')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ready', checks: { database: 'ok', redis: 'ok' } })
  })

  it('degrades to 503 when Redis is unreachable', async () => {
    mockPing.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const res = await request(app).get('/api/health/ready')
    expect(res.status).toBe(503)
    expect(res.body.status).toBe('degraded')
    expect(res.body.checks.redis).toBe('error')
  })
})
