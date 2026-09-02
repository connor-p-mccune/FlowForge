// Execution leases and crash recovery: what happens to a run whose worker
// stopped existing.
//
// The two properties that carry the feature are both about *not* doing
// something. A redelivered job must not re-run a graph that already started —
// that is the duplicate-effects bug the queue's at-least-once contract creates
// and nothing on this side used to close. And a recovery must not resolve an
// indeterminate step by guessing: a step that was running when the process died
// may or may not have charged the card, and both of the statuses the engine
// normally writes would be a lie with consequences.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'
process.env.EXEC_RETRY_BASE_MS = '1'

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const lease = require('../services/executionLease')
const recovery = require('../services/crashRecovery')
const { runExecution } = require('../services/executionEngine')

const node = (id, type, config = {}, label = id) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label, config },
})
const edge = (source, target) => ({ id: `${source}-${target}`, source, target })

const GRAPH = {
  nodes: [node('t1', 'trigger-manual'), node('log', 'output-log', { message: 'hi' })],
  edges: [edge('t1', 'log')],
}

let userId
let workspaceId

beforeAll(() => {
  userId = uuidv4()
  workspaceId = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, `${userId}@test.com`, 'x', 'T', now)
  db.prepare(
    'INSERT INTO workspaces (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(workspaceId, 'WS', userId, now, now)
})

function makeWorkflow(graph = GRAPH, extra = {}) {
  const id = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO workflows (id, workspace_id, name, graph_json, recovery_policy, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, workspaceId, 'WF', JSON.stringify(graph), extra.recovery_policy || 'safe', userId, now, now)
  return id
}

function makeExecution(workflowId, overrides = {}) {
  const id = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO executions (id, workflow_id, status, triggered_by, trigger_type, trigger_data, priority, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    workflowId,
    overrides.status || 'pending',
    userId,
    overrides.trigger_type || 'manual',
    overrides.trigger_data ?? null,
    overrides.priority || 'normal',
    now
  )
  return id
}

// A run abandoned mid-flight: leased, running, with one step still open.
function makeAbandoned(workflowId, { nodeType = 'transform', ago = 60_000, depth = null } = {}) {
  const execId = makeExecution(workflowId, { status: 'pending' })
  const token = lease.acquire(execId)
  const now = new Date()
  db.prepare(
    `UPDATE executions SET status = 'running', started_at = ?, lease_expires_at = ?, recovery_depth = ?
      WHERE id = ?`
  ).run(now.toISOString(), new Date(now.getTime() - ago).toISOString(), depth, execId)
  db.prepare(
    `INSERT INTO execution_steps (id, execution_id, node_id, node_type, status, started_at)
     VALUES (?, ?, 'work', ?, 'running', ?)`
  ).run(uuidv4(), execId, nodeType, now.toISOString())
  db.prepare(
    `INSERT INTO execution_steps (id, execution_id, node_id, node_type, status)
     VALUES (?, ?, 'later', 'output-log', 'pending')`
  ).run(uuidv4(), execId)
  return { execId, token }
}

const getExecution = (id) => db.prepare('SELECT * FROM executions WHERE id = ?').get(id)
const getSteps = (id) =>
  db.prepare('SELECT * FROM execution_steps WHERE execution_id = ? ORDER BY rowid').all(id)

describe('acquiring a lease', () => {
  it('is granted once and refused to a second holder', () => {
    const execId = makeExecution(makeWorkflow())
    const first = lease.acquire(execId)
    expect(first).toEqual(expect.any(String))
    expect(lease.acquire(execId)).toBeNull()
  })

  it('records the holder and counts the pickups', () => {
    const execId = makeExecution(makeWorkflow())
    lease.acquire(execId)
    const row = getExecution(execId)
    expect(row.lease_owner).toBe(lease.WORKER_ID)
    expect(row.lease_attempts).toBe(1)
    expect(new Date(row.lease_expires_at).getTime()).toBeGreaterThan(Date.now())
  })

  it('refuses a run that already started, however stale its lease', () => {
    const { execId } = makeAbandoned(makeWorkflow())
    // The lease lapsed an hour ago and the run is still 'running'. Restarting
    // it would re-execute every node that already ran; the recovery sweep is
    // the mechanism for this, not a fresh acquisition.
    expect(lease.acquire(execId)).toBeNull()
  })

  it('renews only for the holder, and stops once the lease is taken', () => {
    const execId = makeExecution(makeWorkflow())
    const token = lease.acquire(execId)
    expect(lease.renew(execId, token)).toBe(true)
    expect(lease.renew(execId, 'someone-else')).toBe(false)
    expect(lease.held(execId, token)).toBe(true)
    expect(lease.held(execId, 'someone-else')).toBe(false)
  })

  it('releasing clears the deadline but keeps the audit trail', () => {
    const execId = makeExecution(makeWorkflow())
    const token = lease.acquire(execId)
    lease.release(execId, token)
    const row = getExecution(execId)
    expect(row.lease_expires_at).toBeNull()
    expect(row.lease_owner).toBe(lease.WORKER_ID)
  })
})

describe('the engine under a lease', () => {
  it('takes and releases a lease around a real run', async () => {
    const execId = makeExecution(makeWorkflow())
    await runExecution(execId, { publish: () => {} })
    const row = getExecution(execId)
    expect(row.status).toBe('completed')
    expect(row.lease_token).toEqual(expect.any(String))
    expect(row.lease_expires_at).toBeNull()
  })

  it('drops a duplicate delivery instead of running the graph twice', async () => {
    const execId = makeExecution(makeWorkflow())
    await runExecution(execId, { publish: () => {} })
    const before = getSteps(execId).length

    // Exactly what Bull does with a job whose worker stopped reporting.
    await runExecution(execId, { publish: () => {} })
    expect(getSteps(execId)).toHaveLength(before)
    expect(getExecution(execId).lease_attempts).toBe(1)
  })

  it('still reports a missing execution rather than swallowing it', async () => {
    await expect(runExecution('no-such-execution', { publish: () => {} })).rejects.toThrow(
      /not found/
    )
  })

  it('leaves dry runs and nested runs unleased', async () => {
    const dry = makeExecution(makeWorkflow(), { trigger_type: 'dry-run' })
    await runExecution(dry, { dryRun: true, publish: () => {} })
    expect(getExecution(dry).lease_token).toBeNull()

    const nested = makeExecution(makeWorkflow())
    await runExecution(nested, { ancestorWorkflowIds: ['parent'], publish: () => {} })
    expect(getExecution(nested).lease_token).toBeNull()
  })
})

describe('finding what was lost', () => {
  it('reports a run whose lease lapsed', () => {
    const { execId } = makeAbandoned(makeWorkflow())
    expect(lease.expiredLeases().map((r) => r.id)).toContain(execId)
  })

  it('ignores a live lease', () => {
    const execId = makeExecution(makeWorkflow())
    const token = lease.acquire(execId)
    db.prepare("UPDATE executions SET status = 'running' WHERE id = ?").run(execId)
    expect(lease.expiredLeases().map((r) => r.id)).not.toContain(execId)
    lease.release(execId, token)
  })

  it('ignores a running row that was never leased', () => {
    // A nested child, or a run from before leases existed. Concluding that a
    // wait-callback parked for hours is a corpse would be worse than the bug.
    const execId = makeExecution(makeWorkflow())
    db.prepare("UPDATE executions SET status = 'running' WHERE id = ?").run(execId)
    expect(lease.expiredLeases().map((r) => r.id)).not.toContain(execId)
  })

  it('ignores a sub-workflow child', () => {
    const parent = makeExecution(makeWorkflow())
    const { execId } = makeAbandoned(makeWorkflow())
    db.prepare('UPDATE executions SET parent_execution_id = ? WHERE id = ?').run(parent, execId)
    expect(lease.expiredLeases().map((r) => r.id)).not.toContain(execId)
  })
})

describe('recovering a lost run', () => {
  const enqueued = []
  const enqueue = (job) => enqueued.push(job)

  beforeEach(() => {
    enqueued.length = 0
  })

  // The sweep is a sweep: it recovers everything lost, and earlier tests leave
  // their own corpses behind. Each assertion picks out its own run rather than
  // assuming it is the only one.
  const sweepFor = (execId) =>
    recovery.recoverOrphans({ enqueue, publish: () => {} }).find((r) => r.executionId === execId)

  it('records an open step as indeterminate rather than guessing', () => {
    const { execId } = makeAbandoned(makeWorkflow())
    sweepFor(execId)

    const steps = getSteps(execId)
    const open = steps.find((s) => s.node_id === 'work')
    expect(open.status).toBe('indeterminate')
    expect(open.error).toMatch(/whether it completed is unknown/)
    // A node that never launched is what it factually was.
    expect(steps.find((s) => s.node_id === 'later').status).toBe('skipped')
  })

  it('finalises the lost run and continues it as a new one', () => {
    const wfId = makeWorkflow()
    const { execId } = makeAbandoned(wfId)
    const result = sweepFor(execId)

    expect(result.outcome).toBe('resumed')
    const lost = getExecution(execId)
    expect(lost.status).toBe('failed')
    expect(lost.recovery_reason).toBe('worker-lost')
    expect(lost.lease_expires_at).toBeNull()

    const resumed = getExecution(result.resumedAs)
    expect(resumed).toMatchObject({
      workflow_id: wfId,
      status: 'pending',
      trigger_type: 'recovery',
      resumed_from_execution_id: execId,
      recovery_depth: 1,
    })
    expect(enqueued.map((j) => j.executionId)).toContain(result.resumedAs)
  })

  it('refuses to resume when an indeterminate step could already have had an effect', () => {
    const { execId } = makeAbandoned(makeWorkflow(), { nodeType: 'action-http' })
    const result = sweepFor(execId)

    expect(result.outcome).toBe('failed')
    expect(result.reason).toMatch(/may already have taken effect/)
    expect(getExecution(execId).status).toBe('failed')
    expect(enqueued).toHaveLength(0)
  })

  it('resumes an effectful step anyway when the workflow says its steps are idempotent', () => {
    const wfId = makeWorkflow(GRAPH, { recovery_policy: 'resume' })
    const { execId } = makeAbandoned(wfId, { nodeType: 'action-http' })
    expect(sweepFor(execId).outcome).toBe('resumed')
  })

  // The escape hatch only opens where a key is actually sent. A declaration on
  // a node type whose runner ignores it was granting the exemption anyway,
  // which turned "stop and ask a person" into "send the email again".
  it('honours a declared-idempotent HTTP step under the safe policy', () => {
    const wfId = makeWorkflow(
      {
        nodes: [node('t1', 'trigger-manual'), node('work', 'action-http', { url: 'https://x.test', idempotent: true })],
        edges: [edge('t1', 'work')],
      },
      { recovery_policy: 'safe' }
    )
    const { execId } = makeAbandoned(wfId, { nodeType: 'action-http' })
    expect(sweepFor(execId).outcome).toBe('resumed')
  })

  it('ignores the same declaration on a node type that sends no key', () => {
    const wfId = makeWorkflow(
      {
        nodes: [node('t1', 'trigger-manual'), node('work', 'action-email', { to: 'a@b.test', idempotent: true })],
        edges: [edge('t1', 'work')],
      },
      { recovery_policy: 'safe' }
    )
    const { execId } = makeAbandoned(wfId, { nodeType: 'action-email' })
    const result = sweepFor(execId)
    expect(result.outcome).toBe('failed')
    expect(result.reason).toMatch(/may already have taken effect/)
  })

  it('never resumes under a manual policy', () => {
    const wfId = makeWorkflow(GRAPH, { recovery_policy: 'manual' })
    const { execId } = makeAbandoned(wfId)
    const result = sweepFor(execId)
    expect(result.outcome).toBe('failed')
    expect(result.reason).toMatch(/manual/)
  })

  it('stops recovering a run that keeps killing its worker', () => {
    const wfId = makeWorkflow()
    const { execId } = makeAbandoned(wfId, { depth: 2 })
    const result = sweepFor(execId)
    expect(result.outcome).toBe('failed')
    expect(result.reason).toMatch(/already recovered 2 times/)
  })

  it('carries the lost run’s lane and trigger payload forward', () => {
    const wfId = makeWorkflow()
    const { execId } = makeAbandoned(wfId)
    db.prepare("UPDATE executions SET priority = 'high', trigger_data = ? WHERE id = ?")
      .run(JSON.stringify({ orderId: 'ord-1' }), execId)

    const result = sweepFor(execId)
    const resumed = getExecution(result.resumedAs)
    expect(resumed.priority).toBe('high')
    expect(JSON.parse(resumed.trigger_data)).toEqual({ orderId: 'ord-1' })
    expect(enqueued.find((j) => j.executionId === result.resumedAs).payload).toEqual({
      orderId: 'ord-1',
    })
  })

  it('lets a worker that came back and finished the run properly win', () => {
    const { execId } = makeAbandoned(makeWorkflow())
    const row = getExecution(execId)
    // The sweep never sees a settled run — but the row can settle between the
    // query and the write, so the guard lives inside the UPDATE and is tested
    // by handing recovery a row that has moved on underneath it.
    db.prepare("UPDATE executions SET status = 'completed' WHERE id = ?").run(execId)
    const result = recovery.recoverExecution(row, { enqueue, publish: () => {} })
    expect(result.outcome).toBe('settled-elsewhere')
    expect(getExecution(execId).status).toBe('completed')

    db.prepare("UPDATE executions SET status = 'failed' WHERE id = ?").run(execId)
  })

  it('announces the loss so it is seen rather than found', () => {
    const wfId = makeWorkflow()
    const { execId } = makeAbandoned(wfId)
    const published = []
    recovery.recoverOrphans({ enqueue, publish: (p) => published.push(p) })

    expect(published).toContainEqual(
      expect.objectContaining({ executionId: execId, status: 'failed' })
    )
    const event = db
      .prepare(
        "SELECT * FROM activity_events WHERE event_type = 'execution.recovered' AND entity_id = ?"
      )
      .get(execId)
    expect(event).toBeTruthy()
    expect(JSON.parse(event.metadata).indeterminateSteps).toEqual(['work'])
  })

  it('abandons a run whose workflow is gone rather than resurrecting it', () => {
    const wfId = makeWorkflow()
    const { execId } = makeAbandoned(wfId)
    db.prepare("UPDATE workflows SET status = 'archived' WHERE id = ?").run(wfId)
    const result = sweepFor(execId)
    expect(result.outcome).toBe('abandoned')
    expect(getExecution(execId).status).toBe('failed')
    expect(enqueued).toHaveLength(0)
  })
})
