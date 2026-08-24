// The data subject request endpoints.
//
// Both take the person's actual identifier in a POST body rather than the
// pseudonymous key in a URL, and both require `manage` — access is not an
// escalation over `read`, but a bulk cross-workflow disclosure about a named
// person is a governed act and erasure is destructive and audited.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: jest.fn().mockResolvedValue(undefined) }) }))
jest.mock('../config/redis', () => ({ publish: jest.fn().mockResolvedValue(1) }))

const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')
const { subjectIdFor } = require('../services/subjectIndex')

describe('subject request endpoints', () => {
  let jwt
  let manageToken
  let readToken
  let userId
  let workspaceId
  let workflowId

  const EMAIL = 'alice@example.com'

  const seedRun = (email) => {
    const execId = uuidv4()
    const at = new Date().toISOString()
    db.prepare(
      `INSERT INTO executions (id, workflow_id, status, triggered_by, subject_id, trigger_data, created_at)
       VALUES (?, ?, 'completed', ?, ?, ?, ?)`
    ).run(
      execId, workflowId, userId, subjectIdFor(workspaceId, email),
      JSON.stringify({ customer: { email } }), at
    )
    db.prepare(
      `INSERT INTO execution_steps (id, execution_id, node_id, node_type, status, input_json, started_at)
       VALUES (?, ?, 'ship', 'action-http', 'succeeded', ?, ?)`
    ).run(uuidv4(), execId, JSON.stringify({ to: email }), at)
    return execId
  }

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'privacy@example.com', password: 'password123', displayName: 'Privacy' })
    jwt = res.body.token
    userId = db.prepare('SELECT id FROM users WHERE email = ?').get('privacy@example.com').id
    workspaceId = (
      await request(app).get('/api/workspaces').set('Authorization', `Bearer ${jwt}`)
    ).body.workspaces[0].id

    workflowId = uuidv4()
    db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, graph_json, subject_path, status, created_by)
       VALUES (?, ?, 'Orders', '{"nodes":[],"edges":[]}', 'customer.email', 'deployed', ?)`
    ).run(workflowId, workspaceId, userId)

    manageToken = (
      await request(app).post('/api/tokens').set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'admin', scopes: ['manage'] })
    ).body.token
    readToken = (
      await request(app).post('/api/tokens').set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'reader', scopes: ['read'] })
    ).body.token
  })

  const post = (path, body, token = manageToken) =>
    request(app).post(`/api/v1/subjects/${path}`).set('Authorization', `Bearer ${token}`).send(body)

  describe('POST /api/v1/subjects/access', () => {
    it('returns the runs and the data held about one person', async () => {
      seedRun(EMAIL)
      const res = await post('access', { identifier: EMAIL })
      expect(res.status).toBe(200)
      expect(res.body.available).toBe(true)
      expect(res.body.summary.runs).toBeGreaterThan(0)
      expect(res.body.runs[0].trigger).toContain(EMAIL)
      expect(res.body.runs[0].steps[0].input).toContain(EMAIL)
    })

    it('matches however the identifier is spelled', async () => {
      const res = await post('access', { identifier: '  ALICE@Example.com ' })
      expect(res.body.summary.runs).toBeGreaterThan(0)
    })

    it('returns an empty report for somebody with no runs', async () => {
      const res = await post('access', { identifier: 'nobody@example.com' })
      expect(res.body.available).toBe(true)
      expect(res.body.summary.runs).toBe(0)
    })

    it('requires an identifier rather than returning the workspace', async () => {
      expect((await post('access', {})).status).toBe(400)
      expect((await post('access', { identifier: '   ' })).status).toBe(400)
    })

    it('refuses a token without the manage scope', async () => {
      expect((await post('access', { identifier: EMAIL }, readToken)).status).toBe(403)
    })
  })

  describe('POST /api/v1/subjects/erasure', () => {
    it('erases the runs and returns a certificate', async () => {
      const email = `erase-${uuidv4()}@example.com`
      const execId = seedRun(email)
      const res = await post('erasure', { identifier: email, reason: 'Ticket 4821' })

      expect(res.status).toBe(200)
      expect(res.body.certificate).toMatch(/^[0-9a-f-]{36}$/)
      expect(res.body.summary.erased).toBe(1)
      expect(res.body.commitments[0]).toMatchObject({ executionId: execId })
      expect(res.body.commitments[0].digest).toMatch(/^[0-9a-f]{64}$/)

      const row = db.prepare('SELECT trigger_data FROM executions WHERE id = ?').get(execId)
      expect(row.trigger_data).not.toContain(email)
    })

    it('leaves the audit chain verifiable, over the verify route an auditor uses', async () => {
      // The whole point of the design, asserted through the surface an auditor
      // would actually use rather than through the service.
      const email = `chain-${uuidv4()}@example.com`
      seedRun(email)
      const before = await request(app)
        .get(`/api/workspaces/${workspaceId}/audit/verify`)
        .set('Authorization', `Bearer ${jwt}`)
      expect(before.body.ok).toBe(true)

      const erasure = await post('erasure', { identifier: email })

      const after = await request(app)
        .get(`/api/workspaces/${workspaceId}/audit/verify`)
        .set('Authorization', `Bearer ${jwt}`)
      expect(after.status).toBe(200)
      expect(after.body.ok).toBe(true)
      // The chain grew rather than changed.
      expect(after.body.entries).toBeGreaterThan(before.body.entries)

      const entry = db
        .prepare("SELECT * FROM audit_log WHERE action = 'subject.erased' ORDER BY seq DESC LIMIT 1")
        .get()
      expect(entry.actor_id).toBe(userId)
      expect(JSON.parse(entry.metadata).certificate).toBe(erasure.body.certificate)
    })

    it('is idempotent', async () => {
      const email = `twice-${uuidv4()}@example.com`
      seedRun(email)
      expect((await post('erasure', { identifier: email })).body.summary.erased).toBe(1)
      const second = await post('erasure', { identifier: email })
      expect(second.status).toBe(200)
      expect(second.body.summary.erased).toBe(0)
    })

    it('requires an identifier', async () => {
      expect((await post('erasure', {})).status).toBe(400)
    })

    it('refuses a token without the manage scope', async () => {
      expect((await post('erasure', { identifier: EMAIL }, readToken)).status).toBe(403)
    })

    it('404s for a workspace the caller does not belong to', async () => {
      const res = await post('erasure', { identifier: EMAIL, workspaceId: uuidv4() })
      expect(res.status).toBe(404)
    })
  })

  describe('PUT /api/workflows/:id — subject_path', () => {
    const put = (body) =>
      request(app)
        .put(`/api/workflows/${workflowId}`)
        .set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'Orders', ...body })

    it('accepts a dotted field path', async () => {
      const res = await put({ subject_path: 'user.profile.email' })
      expect(res.status).toBe(200)
      expect(res.body.workflow.subject_path).toBe('user.profile.email')
    })

    it('clears it with an empty string', async () => {
      expect((await put({ subject_path: '' })).body.workflow.subject_path).toBeNull()
    })

    it('rejects anything that is not a field path', async () => {
      expect((await put({ subject_path: 'customer.email; DROP' })).status).toBe(400)
      expect((await put({ subject_path: '{{trigger.email}}' })).status).toBe(400)
    })

    it('leaves it alone when the body does not mention it', async () => {
      await put({ subject_path: 'customer.email' })
      const res = await put({ description: 'unchanged' })
      expect(res.body.workflow.subject_path).toBe('customer.email')
    })
  })
})
