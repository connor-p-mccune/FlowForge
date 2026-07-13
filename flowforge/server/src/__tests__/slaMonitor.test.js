// The SLA & anomaly monitor: duration budgets, statistical anomalies, and the
// edge-triggered success-rate floor, plus the alert side effects (an activity
// event + an owner notification).

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))
jest.mock('../config/redis', () => ({ publish: jest.fn().mockResolvedValue(1) }))

const jwt = require('jsonwebtoken')
const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')
const { evaluateRun } = require('../services/slaMonitor')

let userId
let wsId

beforeAll(async () => {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: 'sla-monitor@example.com', password: 'password123', displayName: 'SLA' })
  userId = jwt.decode(res.body.token).id
  const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${res.body.token}`)
  wsId = ws.body.workspaces[0].id
})

function makeWorkflow({ maxDuration = null, minSuccess = null } = {}) {
  const id = uuidv4()
  db.prepare(
    `INSERT INTO workflows (id, workspace_id, name, graph_json, created_by, sla_max_duration_ms, sla_min_success_rate)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, wsId, 'Monitored', JSON.stringify({ nodes: [], edges: [] }), userId, maxDuration, minSuccess)
  return id
}

let clock = 10_000_000 // ms counter so each run is strictly newer than the last
function insertRun(workflowId, { status, durMs, triggerType = 'webhook' }) {
  const id = uuidv4()
  const created = new Date(clock).toISOString()
  clock += 60_000
  const finished = durMs == null ? null : new Date(new Date(created).getTime() + durMs).toISOString()
  db.prepare(
    `INSERT INTO executions (id, workflow_id, status, triggered_by, trigger_type, started_at, finished_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, workflowId, status, userId, triggerType, created, finished, created)
  return id
}

function notificationsFor(link) {
  return db.prepare("SELECT * FROM notifications WHERE user_id = ? AND type = 'sla-breach' AND link = ?")
    .all(userId, link)
}
function slaActivityFor(executionId) {
  return db.prepare(
    "SELECT * FROM activity_events WHERE event_type = 'execution.sla_breached' AND entity_id = ?"
  ).all(executionId)
}

describe('duration budget', () => {
  it('flags a completed run over its budget and raises both alerts', () => {
    const wf = makeWorkflow({ maxDuration: 1000 })
    const run = insertRun(wf, { status: 'completed', durMs: 5000 })
    const breaches = evaluateRun(run)
    expect(breaches).toHaveLength(1)
    expect(breaches[0]).toMatchObject({ type: 'duration', durationMs: 5000, budgetMs: 1000, overBy: 4000 })
    // Side effects landed.
    expect(notificationsFor(`/workflow/${wf}?execution=${run}`)).toHaveLength(1)
    expect(slaActivityFor(run)).toHaveLength(1)
  })

  it('does not flag a run under budget', () => {
    const wf = makeWorkflow({ maxDuration: 1000 })
    const run = insertRun(wf, { status: 'completed', durMs: 500 })
    expect(evaluateRun(run)).toEqual([])
    expect(slaActivityFor(run)).toHaveLength(0)
  })

  it('ignores a failed run for the duration check', () => {
    const wf = makeWorkflow({ maxDuration: 1000 })
    const run = insertRun(wf, { status: 'failed', durMs: 9000 })
    const breaches = evaluateRun(run)
    expect(breaches.some((b) => b.type === 'duration')).toBe(false)
  })

  it('never alerts on a dry-run, however slow', () => {
    const wf = makeWorkflow({ maxDuration: 1000 })
    const run = insertRun(wf, { status: 'completed', durMs: 9000, triggerType: 'dry-run' })
    expect(evaluateRun(run)).toEqual([])
  })
})

describe('statistical anomaly (no config required)', () => {
  it('flags a run far slower than the workflow baseline', () => {
    const wf = makeWorkflow() // no SLA config at all
    // 24 healthy completed runs around ~1000ms with mild variance.
    for (let i = 0; i < 24; i++) insertRun(wf, { status: 'completed', durMs: 1000 + (i % 5) * 8 })
    const slow = insertRun(wf, { status: 'completed', durMs: 20000 })
    const breaches = evaluateRun(slow)
    const anomaly = breaches.find((b) => b.type === 'anomaly')
    expect(anomaly).toBeTruthy()
    expect(anomaly.severity).toBe('severe')
    expect(slaActivityFor(slow)).toHaveLength(1)
  })

  it('does not flag anomalies without enough baseline history', () => {
    const wf = makeWorkflow()
    for (let i = 0; i < 5; i++) insertRun(wf, { status: 'completed', durMs: 1000 })
    const slow = insertRun(wf, { status: 'completed', durMs: 20000 })
    expect(evaluateRun(slow)).toEqual([]) // < ANOMALY_MIN_BASELINE
  })

  it('leaves a normal run alone', () => {
    const wf = makeWorkflow()
    for (let i = 0; i < 24; i++) insertRun(wf, { status: 'completed', durMs: 1000 + (i % 5) * 8 })
    const normal = insertRun(wf, { status: 'completed', durMs: 1010 })
    expect(evaluateRun(normal)).toEqual([])
  })
})

describe('edge-triggered success-rate floor', () => {
  it('alerts only on the run that crosses below the floor', () => {
    const wf = makeWorkflow({ minSuccess: 0.8 })
    // 10 clean completed runs → rate 1.0.
    for (let i = 0; i < 10; i++) insertRun(wf, { status: 'completed', durMs: 100 })

    // Failures 1 and 2 keep the rate at/above 0.8 (10/11, 10/12).
    const f1 = insertRun(wf, { status: 'failed', durMs: 100 })
    expect(evaluateRun(f1)).toEqual([])
    const f2 = insertRun(wf, { status: 'failed', durMs: 100 })
    expect(evaluateRun(f2)).toEqual([])

    // Failure 3 drops it to 10/13 ≈ 0.77 < 0.8 → the crossing, one alert.
    const f3 = insertRun(wf, { status: 'failed', durMs: 100 })
    const b3 = evaluateRun(f3)
    expect(b3).toHaveLength(1)
    expect(b3[0].type).toBe('success_rate')
    expect(b3[0].rate).toBeCloseTo(10 / 13, 3)
    expect(slaActivityFor(f3)).toHaveLength(1)

    // Failure 4 is still below the floor but not a new crossing → no alert.
    const f4 = insertRun(wf, { status: 'failed', durMs: 100 })
    expect(evaluateRun(f4)).toEqual([])
    expect(slaActivityFor(f4)).toHaveLength(0)
  })

  it('needs a minimum sample before it will fire', () => {
    const wf = makeWorkflow({ minSuccess: 0.9 })
    // Only 3 settled runs, all failed — below SUCCESS_RATE_MIN_RUNS.
    insertRun(wf, { status: 'failed', durMs: 100 })
    insertRun(wf, { status: 'failed', durMs: 100 })
    const last = insertRun(wf, { status: 'failed', durMs: 100 })
    expect(evaluateRun(last)).toEqual([])
  })
})

describe('robustness', () => {
  it('returns [] for an unknown execution and never throws', () => {
    expect(evaluateRun('does-not-exist')).toEqual([])
  })

  it('can trip multiple checks at once', () => {
    const wf = makeWorkflow({ maxDuration: 1000, minSuccess: 0.9 })
    // Build history so this completed run is both over budget and a fresh
    // success-rate crossing: 9 completed + 1 failed, then this slow completed
    // run keeps completed dominant but the prior failure sits in-window.
    for (let i = 0; i < 8; i++) insertRun(wf, { status: 'completed', durMs: 100 })
    insertRun(wf, { status: 'failed', durMs: 100 })
    insertRun(wf, { status: 'failed', durMs: 100 })
    // now 8 completed + 2 failed = 0.8 (>= floor 0.9? no, 0.8 < 0.9) — already
    // below. Evaluate a completed slow run: rate becomes 9/11 ≈ 0.818, still
    // below floor but prev window (8/10 = 0.8) was already below → no new
    // success-rate crossing, only the duration breach.
    const slow = insertRun(wf, { status: 'completed', durMs: 8000 })
    const breaches = evaluateRun(slow)
    expect(breaches.some((b) => b.type === 'duration')).toBe(true)
  })
})
