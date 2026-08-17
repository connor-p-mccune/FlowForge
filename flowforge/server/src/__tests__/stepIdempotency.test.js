// Step-level idempotency keys.
//
// The whole feature is one property with two halves, and both are easy to break
// in opposite directions: the key must be **the same** for every attempt at one
// logical step — a retry, a resume, a crash recovery — and **different** for a
// genuinely new request. A key that changes between attempts is the bug this
// exists to prevent; a key that is shared between two runs would make the second
// silently a no-op at the far side, which is worse.
//
// The payoff is in the last describe: crash recovery's `safe` policy refuses to
// re-run a step whose outcome nobody recorded, *unless* the node declared its
// endpoint deduplicates. That declaration is the only thing that makes the
// refusal unnecessary.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const idem = require('../services/stepIdempotency')
const recovery = require('../services/crashRecovery')
const lease = require('../services/executionLease')
const runHttpRequest = require('../services/nodeRunners/httpRequest')

const node = (id, type, config = {}) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label: id, config },
})

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

function makeWorkflow(nodes = []) {
  const id = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO workflows (id, workspace_id, name, graph_json, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, workspaceId, 'WF', JSON.stringify({ nodes, edges: [] }), userId, now, now)
  return id
}

function makeExecution(workflowId, { resumedFrom = null } = {}) {
  const id = uuidv4()
  db.prepare(
    `INSERT INTO executions (id, workflow_id, status, resumed_from_execution_id, created_at)
     VALUES (?, ?, 'pending', ?, ?)`
  ).run(id, workflowId, resumedFrom, new Date().toISOString())
  return id
}

describe('declaring it', () => {
  it('is read from the raw config, so upstream data cannot switch it on', () => {
    expect(idem.isEnabled(node('h', 'action-http', { idempotent: true }))).toBe(true)
    // The canvas stores checkbox values as strings often enough that both spellings
    // have to work; anything else is off.
    expect(idem.isEnabled(node('h', 'action-http', { idempotent: 'true' }))).toBe(true)
    expect(idem.isEnabled(node('h', 'action-http', { idempotent: false }))).toBe(false)
    expect(idem.isEnabled(node('h', 'action-http', { idempotent: '{{trigger.on}}' }))).toBe(false)
    expect(idem.isEnabled(node('h', 'action-http'))).toBe(false)
  })
})

describe('the key', () => {
  it('is the same for the same step of the same run, and different per node', () => {
    const wfId = makeWorkflow([node('charge', 'action-http', { idempotent: true })])
    const execId = makeExecution(wfId)
    const ctx = { parentExecutionId: execId, parentNodeId: 'charge' }

    const first = idem.headerFor(node('charge', 'action-http', { idempotent: true }), ctx)
    const second = idem.headerFor(node('charge', 'action-http', { idempotent: true }), ctx)
    expect(first.name).toBe('Idempotency-Key')
    expect(first.value).toMatch(/^[0-9a-f]{32}$/)
    expect(second.value).toBe(first.value)

    const other = idem.headerFor(node('ship', 'action-http', { idempotent: true }), {
      ...ctx,
      parentNodeId: 'ship',
    })
    expect(other.value).not.toBe(first.value)
  })

  it('is different for a genuinely new run', () => {
    const wfId = makeWorkflow()
    const a = makeExecution(wfId)
    const b = makeExecution(wfId)
    const key = (execId) =>
      idem.headerFor(node('charge', 'action-http', { idempotent: true }), {
        parentExecutionId: execId,
        parentNodeId: 'charge',
      }).value
    // A new webhook delivery is a different request, not a repeat.
    expect(key(a)).not.toBe(key(b))
  })

  it('survives a resume, a recovery, and a chain of both', () => {
    const wfId = makeWorkflow()
    const original = makeExecution(wfId)
    const resumed = makeExecution(wfId, { resumedFrom: original })
    const recovered = makeExecution(wfId, { resumedFrom: resumed })

    const key = (execId) =>
      idem.headerFor(node('charge', 'action-http', { idempotent: true }), {
        parentExecutionId: execId,
        parentNodeId: 'charge',
      }).value

    // The point of the whole design: the continuation presents the key its
    // predecessor did, which is the only way the far side can recognise the
    // repeat.
    expect(key(resumed)).toBe(key(original))
    expect(key(recovered)).toBe(key(original))
  })

  it('does not spin on a corrupt chain', () => {
    const wfId = makeWorkflow()
    const a = makeExecution(wfId)
    const b = makeExecution(wfId, { resumedFrom: a })
    // The schema does not prevent this; the walk must not care.
    db.prepare('UPDATE executions SET resumed_from_execution_id = ? WHERE id = ?').run(b, a)
    expect(idem.rootExecutionId(b)).toEqual(expect.any(String))
  })

  it('yields nothing outside a run, where there is no logical step to key on', () => {
    // The node test bench drives a runner with no execution — there is no
    // logical run, so there is nothing honest to send.
    expect(idem.headerFor(node('h', 'action-http', { idempotent: true }), {})).toBeNull()
    expect(idem.headerFor(node('h', 'action-http'), { parentExecutionId: 'x', parentNodeId: 'h' }))
      .toBeNull()
  })
})

describe('the request', () => {
  const ctxWith = (key) => ({
    idempotencyKey: key ? { name: 'Idempotency-Key', value: key } : null,
  })

  it('carries the header when the node asked for one', async () => {
    const out = await runHttpRequest(
      { method: 'POST', url: 'https://api.example.com/charge', body: '{}' },
      {},
      true,
      ctxWith('abc123')
    )
    expect(out.wouldHaveSent.headers['Idempotency-Key']).toBe('abc123')
  })

  it('sends nothing when the node did not', async () => {
    const out = await runHttpRequest(
      { method: 'POST', url: 'https://api.example.com/charge' },
      {},
      true,
      ctxWith(null)
    )
    expect(Object.keys(out.wouldHaveSent.headers)).not.toContain('Idempotency-Key')
  })

  it('never overwrites a key the author set by hand', async () => {
    const out = await runHttpRequest(
      {
        method: 'POST',
        url: 'https://api.example.com/charge',
        headers: JSON.stringify({ 'idempotency-key': 'mine' }),
      },
      {},
      true,
      ctxWith('generated')
    )
    // Case-insensitively, like the traceparent rule: an author setting their own
    // key is doing it deliberately.
    expect(out.wouldHaveSent.headers['idempotency-key']).toBe('mine')
    expect(out.wouldHaveSent.headers['Idempotency-Key']).toBeUndefined()
  })
})

describe('what it buys — recovering a lost run', () => {
  const enqueue = () => {}

  function abandon(workflowId, nodeId) {
    const execId = makeExecution(workflowId)
    const token = lease.acquire(execId)
    const now = new Date()
    db.prepare(
      `UPDATE executions SET status = 'running', started_at = ?, lease_expires_at = ? WHERE id = ?`
    ).run(now.toISOString(), new Date(now.getTime() - 60_000).toISOString(), execId)
    db.prepare(
      `INSERT INTO execution_steps (id, execution_id, node_id, node_type, status, started_at)
       VALUES (?, ?, ?, 'action-http', 'running', ?)`
    ).run(uuidv4(), execId, nodeId, now.toISOString())
    return { execId, token }
  }

  const sweep = (execId) =>
    recovery.recoverOrphans({ enqueue, publish: () => {} }).find((r) => r.executionId === execId)

  it('refuses to re-run an in-flight request that made no such claim', () => {
    const wfId = makeWorkflow([node('charge', 'action-http', { method: 'POST' })])
    const { execId } = abandon(wfId, 'charge')
    const result = sweep(execId)
    expect(result.outcome).toBe('failed')
    expect(result.reason).toMatch(/may already have taken effect/)
  })

  it('re-runs it when the node declared the endpoint deduplicates', () => {
    const wfId = makeWorkflow([
      node('charge', 'action-http', { method: 'POST', idempotent: true }),
    ])
    const { execId } = abandon(wfId, 'charge')
    // The declaration is the author's claim about their endpoint — the thing
    // FlowForge cannot verify and the only thing that makes the repeat safe.
    expect(sweep(execId).outcome).toBe('resumed')
  })

  it('still refuses when a *different* indeterminate step made no claim', () => {
    const wfId = makeWorkflow([
      node('charge', 'action-http', { method: 'POST', idempotent: true }),
      node('notify', 'action-http', { method: 'POST' }),
    ])
    const { execId } = abandon(wfId, 'charge')
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO execution_steps (id, execution_id, node_id, node_type, status, started_at)
       VALUES (?, ?, 'notify', 'action-http', 'running', ?)`
    ).run(uuidv4(), execId, now)

    const result = sweep(execId)
    expect(result.outcome).toBe('failed')
    expect(result.reason).toMatch(/notify/)
    expect(result.reason).not.toMatch(/charge/)
  })

  it('reads the declaration from the graph, tolerating a corrupt one', () => {
    const wfId = makeWorkflow()
    db.prepare('UPDATE workflows SET graph_json = ? WHERE id = ?').run('not json', wfId)
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(wfId)
    // Nothing can be claimed idempotent, which is the conservative reading.
    expect(recovery.idempotentNodeIds(workflow).size).toBe(0)
  })
})
