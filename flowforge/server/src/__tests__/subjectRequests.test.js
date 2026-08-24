// Data subject requests over a deliberately append-only system.
//
// The property that matters most is the one at the bottom: after an erasure,
// the audit chain still verifies. That is the whole design — the record grows,
// nothing in it changes, and the proof that the erasure happened survives the
// data it destroyed.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const { subjectIdFor, subjectOf, valueAtPath } = require('../services/subjectIndex')
const { accessReport, eraseSubject, commitmentFor, isErased } = require('../services/subjectRequests')
const { verifyChain, listAudit } = require('../services/auditLog')

let userId
let workspaceId
let workflowId

beforeAll(() => {
  userId = uuidv4()
  workspaceId = uuidv4()
  workflowId = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, `${userId}@test.com`, 'x', 'Admin', now)
  db.prepare(
    'INSERT INTO workspaces (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(workspaceId, 'WS', userId, now, now)
  db.prepare(
    `INSERT INTO workflows (id, workspace_id, name, graph_json, subject_path, created_by, created_at, updated_at)
     VALUES (?, ?, 'Orders', '{"nodes":[],"edges":[]}', 'customer.email', ?, ?, ?)`
  ).run(workflowId, workspaceId, userId, now, now)
})

// A recorded run for one person, with one step holding their data.
function seedRun(email, { at = new Date().toISOString() } = {}) {
  const execId = uuidv4()
  db.prepare(
    `INSERT INTO executions (id, workflow_id, status, triggered_by, subject_id, trigger_data, created_at, finished_at)
     VALUES (?, ?, 'completed', ?, ?, ?, ?, ?)`
  ).run(
    execId,
    workflowId,
    userId,
    subjectIdFor(workspaceId, email),
    JSON.stringify({ customer: { email, name: 'A Person' } }),
    at,
    at
  )
  db.prepare(
    `INSERT INTO execution_steps (id, execution_id, node_id, node_type, status, input_json, output_json, started_at)
     VALUES (?, ?, 'ship', 'action-http', 'succeeded', ?, ?, ?)`
  ).run(uuidv4(), execId, JSON.stringify({ to: email }), JSON.stringify({ sent: true }), at)
  return execId
}

describe('subjectIndex', () => {
  it('is stable for the same person however they are spelled', () => {
    // Case and whitespace are presentation, not identity — a request that
    // missed the runs recorded under another spelling is one nobody can rely on.
    expect(subjectIdFor(workspaceId, ' Alice@Example.COM ')).toBe(
      subjectIdFor(workspaceId, 'alice@example.com')
    )
  })

  it('never contains the identifier it keys', () => {
    const id = subjectIdFor(workspaceId, 'alice@example.com')
    expect(id).toMatch(/^[0-9a-f]{32}$/)
    expect(id).not.toContain('alice')
  })

  it('differs per workspace, so one cannot confirm what another holds', () => {
    expect(subjectIdFor(workspaceId, 'alice@example.com')).not.toBe(
      subjectIdFor(uuidv4(), 'alice@example.com')
    )
  })

  it('has nothing to key on without an identifier', () => {
    expect(subjectIdFor(workspaceId, '')).toBeNull()
    expect(subjectIdFor(workspaceId, '   ')).toBeNull()
    expect(subjectIdFor(null, 'alice@example.com')).toBeNull()
  })

  it('reads a nested path out of a trigger payload', () => {
    expect(valueAtPath({ customer: { email: 'a@b.com' } }, 'customer.email')).toBe('a@b.com')
    expect(valueAtPath({ user: { id: 42 } }, 'user.id')).toBe('42')
  })

  it('refuses a path that does not land on a scalar', () => {
    // A list has not identified one person, and an object is not an identifier.
    expect(valueAtPath({ customer: { emails: ['a@b.com'] } }, 'customer.emails')).toBeNull()
    expect(valueAtPath({ customer: { email: { v: 'x' } } }, 'customer.email')).toBeNull()
    expect(valueAtPath({ a: [{ b: 1 }] }, 'a.b')).toBeNull()
  })

  it('treats a run with no subject as a normal run, not an error', () => {
    expect(subjectOf(workspaceId, null, { customer: { email: 'a@b.com' } })).toBeNull()
    expect(subjectOf(workspaceId, 'customer.email', {})).toBeNull()
  })
})

describe('accessReport', () => {
  it('returns every run held about one person, with the data', () => {
    // A list of run ids would be a receipt, not a disclosure.
    const email = `access-${uuidv4()}@example.com`
    seedRun(email)
    seedRun(email)
    const report = accessReport(workspaceId, email)
    expect(report.summary.runs).toBe(2)
    expect(report.runs[0].workflowName).toBe('Orders')
    expect(report.runs[0].trigger).toContain(email)
    expect(report.runs[0].steps[0].input).toContain(email)
  })

  it('returns nothing for somebody with no runs', () => {
    const report = accessReport(workspaceId, `nobody-${uuidv4()}@example.com`)
    expect(report.available).toBe(true)
    expect(report.summary.runs).toBe(0)
  })

  it('refuses without an identifier rather than returning the whole workspace', () => {
    expect(accessReport(workspaceId, '')).toEqual({ available: false, reason: 'no-identifier' })
  })

  it('stays inside the workspace', () => {
    const email = `scoped-${uuidv4()}@example.com`
    seedRun(email)
    // Another workspace holds no runs for the same person, and the id it would
    // look up is a different one anyway.
    expect(accessReport(uuidv4(), email).summary.runs).toBe(0)
  })
})

describe('eraseSubject', () => {
  it('empties every run held about that person', () => {
    const email = `erase-${uuidv4()}@example.com`
    const execId = seedRun(email)
    const result = eraseSubject(workspaceId, email, { actorId: userId, reason: 'Art. 17 request' })

    expect(result.summary.erased).toBe(1)
    const row = db.prepare('SELECT trigger_data, erased_at FROM executions WHERE id = ?').get(execId)
    expect(row.trigger_data).not.toContain(email)
    expect(row.erased_at).toBe(result.erasedAt)
    const step = db
      .prepare('SELECT input_json, output_json FROM execution_steps WHERE execution_id = ?')
      .get(execId)
    expect(step.input_json).not.toContain(email)
    expect(step.output_json).not.toContain(email)
  })

  it('leaves a tombstone rather than a null', () => {
    // Every reader of these columns should be able to tell "erased on request"
    // from "never recorded", and a null looks like a bug to whichever
    // encounters it first.
    const email = `stone-${uuidv4()}@example.com`
    const execId = seedRun(email)
    const result = eraseSubject(workspaceId, email, { actorId: userId })
    const row = db.prepare('SELECT trigger_data FROM executions WHERE id = ?').get(execId)
    expect(isErased(row.trigger_data)).toBe(true)
    expect(JSON.parse(row.trigger_data).__erased.certificate).toBe(result.certificate)
  })

  it('keeps the execution row, because it is the proof the erasure happened', () => {
    const email = `keep-${uuidv4()}@example.com`
    const execId = seedRun(email)
    eraseSubject(workspaceId, email, { actorId: userId })
    expect(db.prepare('SELECT id FROM executions WHERE id = ?').get(execId)).toBeTruthy()
  })

  it('reports the run as erased and its data as absent on a later access request', () => {
    // "We held something and destroyed it on this date" is itself part of the
    // answer to an access request.
    const email = `later-${uuidv4()}@example.com`
    seedRun(email)
    const { erasedAt } = eraseSubject(workspaceId, email, { actorId: userId })
    const report = accessReport(workspaceId, email)
    expect(report.summary.erased).toBe(1)
    expect(report.runs[0].erasedAt).toBe(erasedAt)
    expect(report.runs[0].trigger).toBeNull()
    expect(report.runs[0].steps).toEqual([])
  })

  it('is idempotent — a second request erases nothing and still succeeds', () => {
    const email = `twice-${uuidv4()}@example.com`
    seedRun(email)
    expect(eraseSubject(workspaceId, email, { actorId: userId }).summary.erased).toBe(1)
    const second = eraseSubject(workspaceId, email, { actorId: userId })
    expect(second.summary.erased).toBe(0)
    expect(second.available).toBe(true)
  })

  it('refuses without an identifier rather than erasing everything', () => {
    expect(eraseSubject(workspaceId, '', { actorId: userId })).toEqual({
      available: false,
      reason: 'no-identifier',
    })
  })

  // — the part that makes it defensible ————————————————————————————————

  it('records a commitment to what was removed, not the content', () => {
    const email = `commit-${uuidv4()}@example.com`
    const execId = seedRun(email)
    const before = commitmentFor(execId)
    const result = eraseSubject(workspaceId, email, { actorId: userId })

    expect(result.commitments[0]).toEqual({ executionId: execId, digest: before })
    expect(result.commitments[0].digest).toMatch(/^[0-9a-f]{64}$/)
    // The digest is over data that no longer exists — a receipt, not a copy.
    expect(commitmentFor(execId)).not.toBe(before)
  })

  it('appends to the audit chain instead of editing it, and the chain still verifies', () => {
    // The whole conflict, resolved: the record grows, nothing in it changes.
    const email = `chain-${uuidv4()}@example.com`
    seedRun(email)
    expect(verifyChain(workspaceId).ok).toBe(true)
    const result = eraseSubject(workspaceId, email, { actorId: userId })
    expect(verifyChain(workspaceId).ok).toBe(true)

    const entry = listAudit(workspaceId, { limit: 1 })[0]
    expect(entry.action).toBe('subject.erased')
    expect(JSON.parse(entry.metadata).certificate).toBe(result.certificate)
  })

  it('names who asked and why, since the erasure is itself a governed act', () => {
    const email = `who-${uuidv4()}@example.com`
    seedRun(email)
    eraseSubject(workspaceId, email, { actorId: userId, reason: 'Support ticket 4821' })
    const entry = listAudit(workspaceId, { limit: 1 })[0]
    expect(entry.actor_label).toBe('Admin')
    expect(JSON.parse(entry.metadata).reason).toBe('Support ticket 4821')
  })

  it('erases every run in one transaction, so there is no half-done state', () => {
    const email = `atomic-${uuidv4()}@example.com`
    const ids = [seedRun(email), seedRun(email), seedRun(email)]
    const result = eraseSubject(workspaceId, email, { actorId: userId })
    expect(result.summary.erased).toBe(3)
    for (const id of ids) {
      expect(db.prepare('SELECT erased_at FROM executions WHERE id = ?').get(id).erased_at)
        .toBe(result.erasedAt)
    }
  })

  it('leaves other people alone', () => {
    const target = `target-${uuidv4()}@example.com`
    const bystander = `bystander-${uuidv4()}@example.com`
    seedRun(target)
    const keptId = seedRun(bystander)
    eraseSubject(workspaceId, target, { actorId: userId })
    expect(db.prepare('SELECT trigger_data FROM executions WHERE id = ?').get(keptId).trigger_data)
      .toContain(bystander)
  })
})
