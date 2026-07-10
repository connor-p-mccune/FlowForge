// The retention sweep: opt-in pruning of old terminal runs (steps and
// approvals cascade), the always-on delivery-log cap, and the guarantees that
// matter — live rows and pending queue entries are never touched.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const { sweepOnce } = require('../services/retention')

const DAY_MS = 24 * 60 * 60 * 1000
const daysAgo = (n) => new Date(Date.now() - n * DAY_MS).toISOString()

// Minimal fixture rows — the sweep is pure SQL, no HTTP surface involved.
const userId = uuidv4()
const workspaceId = uuidv4()
const workflowId = uuidv4()
db.prepare(
  "INSERT INTO users (id, email, password_hash, display_name) VALUES (?, 'sweep@example.com', 'x', 'Sweeper')"
).run(userId)
db.prepare('INSERT INTO workspaces (id, name, created_by) VALUES (?, ?, ?)').run(
  workspaceId, 'Sweep WS', userId
)
db.prepare(
  'INSERT INTO workflows (id, workspace_id, name, created_by) VALUES (?, ?, ?, ?)'
).run(workflowId, workspaceId, 'Sweepable', userId)

function seedExecution({ status, createdAt }) {
  const id = uuidv4()
  db.prepare(
    'INSERT INTO executions (id, workflow_id, status, created_at) VALUES (?, ?, ?, ?)'
  ).run(id, workflowId, status, createdAt)
  db.prepare(
    "INSERT INTO execution_steps (id, execution_id, node_id, status) VALUES (?, ?, 'n1', 'succeeded')"
  ).run(uuidv4(), id)
  db.prepare(
    `INSERT INTO execution_approvals (id, execution_id, node_id, workflow_id, workspace_id, status, requested_at)
     VALUES (?, ?, 'gate', ?, ?, 'approved', ?)`
  ).run(uuidv4(), id, workflowId, workspaceId, createdAt)
  return id
}

function seedDelivery({ status, createdAt }) {
  const subId = uuidv4()
  db.prepare(
    `INSERT INTO event_subscriptions (id, workspace_id, url, events, secret)
     VALUES (?, ?, 'https://example.com/hook', '["*"]', 'whsec_x')`
  ).run(subId, workspaceId)
  const id = uuidv4()
  db.prepare(
    `INSERT INTO event_deliveries (id, subscription_id, event_type, payload_json, status, created_at)
     VALUES (?, ?, 'ping', '{}', ?, ?)`
  ).run(id, subId, status, createdAt)
  return id
}

const executionExists = (id) =>
  Boolean(db.prepare('SELECT 1 FROM executions WHERE id = ?').get(id))
const deliveryExists = (id) =>
  Boolean(db.prepare('SELECT 1 FROM event_deliveries WHERE id = ?').get(id))

afterEach(() => {
  delete process.env.EXECUTION_RETENTION_DAYS
  delete process.env.WEBHOOK_DELIVERY_RETENTION_DAYS
  db.prepare('DELETE FROM executions').run()
  db.prepare('DELETE FROM event_deliveries').run()
  db.prepare('DELETE FROM event_subscriptions').run()
})

describe('retention sweep', () => {
  it('keeps executions forever unless retention is opted into', () => {
    const ancient = seedExecution({ status: 'completed', createdAt: daysAgo(400) })
    const { executions } = sweepOnce()
    expect(executions).toBe(0)
    expect(executionExists(ancient)).toBe(true)
  })

  it('prunes old terminal runs, cascading steps and approvals', () => {
    process.env.EXECUTION_RETENTION_DAYS = '90'
    const old = seedExecution({ status: 'completed', createdAt: daysAgo(120) })
    const failed = seedExecution({ status: 'failed', createdAt: daysAgo(91) })
    const recent = seedExecution({ status: 'completed', createdAt: daysAgo(10) })

    const { executions } = sweepOnce()
    expect(executions).toBe(2)
    expect(executionExists(old)).toBe(false)
    expect(executionExists(failed)).toBe(false)
    expect(executionExists(recent)).toBe(true)

    // Nothing orphaned: steps and approvals went with their executions.
    expect(db.prepare('SELECT COUNT(*) AS n FROM execution_steps').get().n).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM execution_approvals').get().n).toBe(1)
  })

  it('never touches runs that are still pending or running, however old', () => {
    process.env.EXECUTION_RETENTION_DAYS = '30'
    const stuckRunning = seedExecution({ status: 'running', createdAt: daysAgo(365) })
    const stuckPending = seedExecution({ status: 'pending', createdAt: daysAgo(365) })

    sweepOnce()
    expect(executionExists(stuckRunning)).toBe(true)
    expect(executionExists(stuckPending)).toBe(true)
  })

  it('prunes settled webhook deliveries after 30 days by default, keeping the queue', () => {
    const oldDelivered = seedDelivery({ status: 'delivered', createdAt: daysAgo(45) })
    const oldFailed = seedDelivery({ status: 'failed', createdAt: daysAgo(45) })
    const oldPending = seedDelivery({ status: 'pending', createdAt: daysAgo(45) })
    const fresh = seedDelivery({ status: 'delivered', createdAt: daysAgo(5) })

    const { deliveries } = sweepOnce()
    expect(deliveries).toBe(2)
    expect(deliveryExists(oldDelivered)).toBe(false)
    expect(deliveryExists(oldFailed)).toBe(false)
    expect(deliveryExists(oldPending)).toBe(true)
    expect(deliveryExists(fresh)).toBe(true)
  })

  it('honors a custom delivery window, including 0 to disable', () => {
    const settled = seedDelivery({ status: 'delivered', createdAt: daysAgo(45) })

    process.env.WEBHOOK_DELIVERY_RETENTION_DAYS = '0'
    expect(sweepOnce().deliveries).toBe(0)
    expect(deliveryExists(settled)).toBe(true)

    process.env.WEBHOOK_DELIVERY_RETENTION_DAYS = '40'
    expect(sweepOnce().deliveries).toBe(1)
    expect(deliveryExists(settled)).toBe(false)
  })
})
