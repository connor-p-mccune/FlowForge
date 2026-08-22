// Quorum, owner-only gates, and separation of duties, through the real HTTP
// surface — the decision core is unit-tested in approvalQuorum.test.js; this is
// about the rows, the races and the status codes.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: jest.fn().mockResolvedValue(undefined) }) }))
jest.mock('../config/redis', () => ({ publish: jest.fn().mockResolvedValue(1) }))

const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')

let owner
let alice
let bob
let viewer
let workspaceId
let workflowId

// Register and return { token, id }.
async function register(email, name) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'password123', displayName: name })
  return { token: res.body.token, id: db.prepare('SELECT id FROM users WHERE email = ?').get(email).id }
}

// File a pending approval directly. The runner's wait is covered elsewhere;
// what matters here is the gate stored on the row, which is exactly what the
// runner writes.
function fileApproval({ quorum = 1, requiredRole = null, excludedUserId = null, triggeredBy = null } = {}) {
  const execId = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO executions (id, workflow_id, status, triggered_by, created_at)
     VALUES (?, ?, 'running', ?, ?)`
  ).run(execId, workflowId, triggeredBy, now)

  const id = uuidv4()
  db.prepare(
    `INSERT INTO execution_approvals
       (id, execution_id, node_id, workflow_id, workspace_id, status, message, requested_at, expires_at,
        quorum, required_role, excluded_user_id)
     VALUES (?, ?, 'gate', ?, ?, 'pending', 'Ship it?', ?, ?, ?, ?, ?)`
  ).run(
    id, execId, workflowId, workspaceId, now,
    new Date(Date.now() + 3_600_000).toISOString(), quorum, requiredRole, excludedUserId
  )
  return id
}

const respond = (approvalId, token, decision = 'approve', note) =>
  request(app)
    .post(`/api/approvals/${approvalId}/respond`)
    .set('Authorization', `Bearer ${token}`)
    .send({ decision, ...(note ? { note } : {}) })

const statusOf = (id) => db.prepare('SELECT status FROM execution_approvals WHERE id = ?').get(id).status
const votesFor = (id) =>
  db.prepare('SELECT * FROM execution_approval_responses WHERE approval_id = ? ORDER BY created_at').all(id)

beforeAll(async () => {
  owner = await register('quorum-owner@example.com', 'Owner')
  alice = await register('quorum-alice@example.com', 'Alice')
  bob = await register('quorum-bob@example.com', 'Bob')
  viewer = await register('quorum-viewer@example.com', 'Viewer')

  workspaceId = (await request(app).get('/api/workspaces').set('Authorization', `Bearer ${owner.token}`))
    .body.workspaces[0].id

  const join = db.prepare(
    'INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
  )
  const now = new Date().toISOString()
  join.run(workspaceId, alice.id, 'member', now)
  join.run(workspaceId, bob.id, 'member', now)
  join.run(workspaceId, viewer.id, 'viewer', now)

  workflowId = uuidv4()
  db.prepare(
    `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by)
     VALUES (?, ?, 'Gated', '{"nodes":[],"edges":[]}', 'deployed', ?)`
  ).run(workflowId, workspaceId, owner.id)
})

describe('quorum', () => {
  it('is unchanged for an ordinary approval — one response settles it', async () => {
    const id = fileApproval()
    const res = await respond(id, alice.token)
    expect(res.status).toBe(200)
    expect(statusOf(id)).toBe('approved')
  })

  it('holds the gate open until enough distinct people approve', async () => {
    const id = fileApproval({ quorum: 2 })

    const first = await respond(id, alice.token)
    // 202, not 200: the vote was accepted and the gate is still open. A client
    // treating every 2xx as "approved" would otherwise act on a half-met quorum.
    expect(first.status).toBe(202)
    expect(first.body.progress).toMatchObject({ settled: false, approvals: 1, needed: 2 })
    expect(statusOf(id)).toBe('pending')

    const second = await respond(id, bob.token)
    expect(second.status).toBe(200)
    expect(second.body.progress).toMatchObject({ settled: true, approvals: 2 })
    expect(statusOf(id)).toBe('approved')
  })

  it('will not let one person satisfy a quorum by clicking twice', async () => {
    const id = fileApproval({ quorum: 2 })
    await respond(id, alice.token)

    const again = await respond(id, alice.token)
    expect(again.status).toBe(409)
    expect(again.body.reason).toBe('already-responded')
    expect(statusOf(id)).toBe('pending')
    expect(votesFor(id)).toHaveLength(1)
  })

  it('settles rejected on a single objection, whatever the quorum', async () => {
    const id = fileApproval({ quorum: 3 })
    await respond(id, alice.token)
    const res = await respond(id, bob.token, 'reject', 'the amount is wrong')

    expect(res.status).toBe(200)
    expect(statusOf(id)).toBe('rejected')
    expect(res.body.progress.status).toBe('rejected')
  })

  it('records who approved, not only who happened to be last', async () => {
    const id = fileApproval({ quorum: 2 })
    await respond(id, alice.token, 'approve', 'checked the ledger')
    await respond(id, bob.token)

    const votes = votesFor(id)
    expect(votes).toHaveLength(2)
    expect(votes.map((v) => v.user_id).sort()).toEqual([alice.id, bob.id].sort())
    expect(votes[0].note).toBe('checked the ledger')
    // The approval row still names a single responder, which is why the votes
    // table exists: with four-eyes that column is the least interesting name.
    expect(votesFor(id).some((v) => v.user_id === alice.id)).toBe(true)
  })

  it('refuses a late response once the gate has settled', async () => {
    const id = fileApproval({ quorum: 2 })
    await respond(id, alice.token)
    await respond(id, bob.token)

    const late = await respond(id, owner.token)
    expect(late.status).toBe(409)
    expect(late.body.error).toMatch(/already approved/)
    // And the late vote is not recorded against a decision that is over.
    expect(votesFor(id)).toHaveLength(2)
  })
})

describe('required role', () => {
  it('refuses a member on an owner-only gate, and says why', async () => {
    const id = fileApproval({ requiredRole: 'owner' })
    const res = await respond(id, alice.token)
    expect(res.status).toBe(403)
    expect(res.body.reason).toBe('role')
    expect(res.body.error).toMatch(/workspace owner/)
    expect(statusOf(id)).toBe('pending')
    expect(votesFor(id)).toHaveLength(0)
  })

  it('lets an owner through', async () => {
    const id = fileApproval({ requiredRole: 'owner' })
    expect((await respond(id, owner.token)).status).toBe(200)
    expect(statusOf(id)).toBe('approved')
  })

  it('still refuses a viewer, before the role check even applies', async () => {
    const id = fileApproval()
    const res = await respond(id, viewer.token)
    expect(res.status).toBe(403)
    expect(res.body.reason).toBe('viewer')
  })
})

describe('separation of duties', () => {
  it('refuses whoever started the run', async () => {
    const id = fileApproval({ excludedUserId: alice.id, triggeredBy: alice.id })
    const res = await respond(id, alice.token)
    expect(res.status).toBe(403)
    expect(res.body.reason).toBe('separation-of-duties')
    expect(res.body.error).toMatch(/you cannot approve it/i)
  })

  it('lets anybody else through', async () => {
    const id = fileApproval({ excludedUserId: alice.id, triggeredBy: alice.id })
    expect((await respond(id, bob.token)).status).toBe(200)
  })

  it('excludes nobody when the run had no triggering user', async () => {
    // A webhook or schedule run has no `triggered_by`. The control is honestly
    // inert rather than quietly becoming something else — the linter is where
    // that is reported, while it is still an edit.
    const id = fileApproval({ excludedUserId: null, triggeredBy: null })
    expect((await respond(id, alice.token)).status).toBe(200)
  })

  it('refuses an owner who started the run — it is about the role in this run', async () => {
    const id = fileApproval({ requiredRole: 'owner', excludedUserId: owner.id, triggeredBy: owner.id })
    const res = await respond(id, owner.token)
    expect(res.status).toBe(403)
    expect(res.body.reason).toBe('separation-of-duties')
  })
})

describe('the audit trail', () => {
  it('logs a partial approval as well as the settlement', async () => {
    const id = fileApproval({ quorum: 2 })
    await respond(id, alice.token)
    await respond(id, bob.token)

    const events = db
      .prepare("SELECT event_type, metadata FROM activity_events WHERE workspace_id = ? AND event_type LIKE 'approval.%' ORDER BY created_at DESC LIMIT 2")
      .all(workspaceId)
      .map((e) => e.event_type)
    // Both the vote that did not settle it and the one that did — if the
    // request had then timed out, the first is the only record that anybody
    // approved at all.
    expect(events).toContain('approval.approved')
    expect(events).toContain('approval.recorded')
  })

  it('carries the quorum in the entry only when there was one', async () => {
    // Newest by rowid rather than created_at: the two settlements below land in
    // the same second, and a timestamp sort would pick between them by luck.
    const newestApproved = db.prepare(
      "SELECT metadata FROM activity_events WHERE event_type = 'approval.approved' ORDER BY rowid DESC LIMIT 1"
    )

    const quorumId = fileApproval({ quorum: 2 })
    await respond(quorumId, alice.token)
    await respond(quorumId, bob.token)
    expect(JSON.parse(newestApproved.get().metadata)).toMatchObject({ approvals: 2, quorum: 2 })

    // And an ordinary approval's entry is exactly what it always was.
    const plainId = fileApproval()
    await respond(plainId, alice.token)
    expect(JSON.parse(newestApproved.get().metadata).quorum).toBeUndefined()
  })
})
