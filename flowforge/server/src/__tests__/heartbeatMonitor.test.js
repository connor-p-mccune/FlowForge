// The heartbeat monitor: a workflow that promises a successful run every N
// minutes is flagged when it goes quiet — once per silence (edge-triggered),
// with a recovered event when a fresh success closes the alert.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const { checkOnce } = require('../services/heartbeatMonitor')

const MINUTE = 60 * 1000
const NOW = Date.parse('2026-07-17T12:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()

let userId
let wsId

beforeAll(() => {
  userId = uuidv4()
  wsId = uuidv4()
  const now = iso(NOW - 100 * MINUTE)
  db.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, 'hb@test.com', 'x', 'Heart Beat', now)
  db.prepare(
    'INSERT INTO workspaces (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(wsId, 'WS', userId, now, now)
})

function seedWorkflow({ interval = 30, status = 'deployed', deployedAgoMin = 90 } = {}) {
  const wfId = uuidv4()
  const created = iso(NOW - deployedAgoMin * MINUTE)
  db.prepare(
    `INSERT INTO workflows (id, workspace_id, name, graph_json, status, heartbeat_interval_minutes, created_by, created_at, updated_at)
     VALUES (?, ?, ?, '{"nodes":[],"edges":[]}', ?, ?, ?, ?, ?)`
  ).run(wfId, wsId, `WF-${wfId.slice(0, 8)}`, status, interval, userId, created, created)
  db.prepare(
    'INSERT INTO workflow_versions (id, workflow_id, version, graph_json, created_at) VALUES (?, ?, 1, ?, ?)'
  ).run(uuidv4(), wfId, '{"nodes":[],"edges":[]}', created)
  return wfId
}

function seedRun(wfId, { agoMin, status = 'completed', triggerType = 'webhook' }) {
  const finished = iso(NOW - agoMin * MINUTE)
  db.prepare(
    `INSERT INTO executions (id, workflow_id, status, trigger_type, started_at, finished_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(uuidv4(), wfId, status, triggerType, finished, finished, finished)
}

const alertedAt = (wfId) =>
  db.prepare('SELECT heartbeat_alerted_at FROM workflows WHERE id = ?').get(wfId).heartbeat_alerted_at

const eventsFor = (wfId, type) =>
  db.prepare('SELECT * FROM activity_events WHERE entity_id = ? AND event_type = ?').all(wfId, type)

describe('heartbeat monitor', () => {
  it('stays quiet while the last success is inside the interval', () => {
    const wfId = seedWorkflow({ interval: 30 })
    seedRun(wfId, { agoMin: 10 })
    const transitions = checkOnce(NOW)
    expect(transitions.find((t) => t.workflowId === wfId)).toBeUndefined()
    expect(alertedAt(wfId)).toBeNull()
  })

  it('alerts once when the silence exceeds the interval, then stays silent', () => {
    const wfId = seedWorkflow({ interval: 30 })
    seedRun(wfId, { agoMin: 45 })

    const first = checkOnce(NOW)
    expect(first).toContainEqual({ workflowId: wfId, event: 'missed' })
    expect(alertedAt(wfId)).toBe(iso(NOW))

    const events = eventsFor(wfId, 'workflow.heartbeat_missed')
    expect(events).toHaveLength(1)
    const metadata = JSON.parse(events[0].metadata)
    expect(metadata.intervalMinutes).toBe(30)
    expect(metadata.overdueMinutes).toBe(15)

    // The owner hears about it.
    const notification = db.prepare(
      "SELECT * FROM notifications WHERE user_id = ? AND type = 'heartbeat-missed'"
    ).get(userId)
    expect(notification).toBeTruthy()

    // Edge-triggered: the next sweep makes no new transition and no new event.
    const second = checkOnce(NOW + 5 * MINUTE)
    expect(second.find((t) => t.workflowId === wfId)).toBeUndefined()
    expect(eventsFor(wfId, 'workflow.heartbeat_missed')).toHaveLength(1)
  })

  it('recovers when a success newer than the alert lands, and can alert again', () => {
    const wfId = seedWorkflow({ interval: 30 })
    seedRun(wfId, { agoMin: 60 })
    checkOnce(NOW)
    expect(alertedAt(wfId)).not.toBeNull()

    // A fresh success after the alert closes it.
    seedRun(wfId, { agoMin: -5 }) // 5 minutes after NOW
    const transitions = checkOnce(NOW + 10 * MINUTE)
    expect(transitions).toContainEqual({ workflowId: wfId, event: 'recovered' })
    expect(alertedAt(wfId)).toBeNull()
    expect(eventsFor(wfId, 'workflow.heartbeat_recovered')).toHaveLength(1)

    // Silence after recovery re-arms the alert.
    const later = checkOnce(NOW + 50 * MINUTE)
    expect(later).toContainEqual({ workflowId: wfId, event: 'missed' })
    expect(eventsFor(wfId, 'workflow.heartbeat_missed')).toHaveLength(2)
  })

  it('measures a never-run workflow from its latest deploy', () => {
    const fresh = seedWorkflow({ interval: 120, deployedAgoMin: 60 })
    const stale = seedWorkflow({ interval: 30, deployedAgoMin: 60 })

    const transitions = checkOnce(NOW)
    expect(transitions.find((t) => t.workflowId === fresh)).toBeUndefined()
    expect(transitions).toContainEqual({ workflowId: stale, event: 'missed' })
  })

  it('ignores dry runs and failed runs as heartbeats', () => {
    const wfId = seedWorkflow({ interval: 30, deployedAgoMin: 90 })
    seedRun(wfId, { agoMin: 5, triggerType: 'dry-run' })
    seedRun(wfId, { agoMin: 5, status: 'failed' })

    const transitions = checkOnce(NOW)
    expect(transitions).toContainEqual({ workflowId: wfId, event: 'missed' })
  })

  it('skips drafts and workflows without an expectation', () => {
    const draft = seedWorkflow({ interval: 30, status: 'draft', deployedAgoMin: 500 })
    const unset = seedWorkflow({ interval: null, deployedAgoMin: 500 })

    const transitions = checkOnce(NOW)
    expect(transitions.find((t) => t.workflowId === draft)).toBeUndefined()
    expect(transitions.find((t) => t.workflowId === unset)).toBeUndefined()
  })
})
