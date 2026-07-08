const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'
process.env.EXEC_RETRY_BASE_MS = '1'

// Some routes pulled in by ../index talk to Bull — mock the queue so nothing
// touches Redis (mirrors the other route suites).
const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))

const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')
const { runExecution } = require('../services/executionEngine')

const authed = (req, token) => req.set('Authorization', `Bearer ${token}`)
const noop = () => {}

describe('workspace secrets', () => {
  let ownerToken
  let workspaceId
  let memberToken
  let outsiderToken

  const putSecret = (token, name, value) =>
    authed(request(app).put(`/api/workspaces/${workspaceId}/secrets/${name}`).send({ value }), token)
  const listSecrets = (token) =>
    authed(request(app).get(`/api/workspaces/${workspaceId}/secrets`), token)

  beforeAll(async () => {
    const owner = await request(app)
      .post('/api/auth/register')
      .send({ email: 'owner@secrets.test', password: 'password123', displayName: 'Sara Owner' })
    ownerToken = owner.body.token

    const ws = await authed(request(app).get('/api/workspaces'), ownerToken)
    workspaceId = ws.body.workspaces[0].id

    const member = await request(app)
      .post('/api/auth/register')
      .send({ email: 'member@secrets.test', password: 'password123', displayName: 'Milo Member' })
    memberToken = member.body.token
    db.prepare(
      "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'member')"
    ).run(workspaceId, member.body.user.id)

    const outsider = await request(app)
      .post('/api/auth/register')
      .send({ email: 'outsider@secrets.test', password: 'password123', displayName: 'Oz Outsider' })
    outsiderToken = outsider.body.token
  })

  it('creates a secret and returns metadata only — never the value', async () => {
    const res = await putSecret(ownerToken, 'API_KEY', 'sk-live-supersecret-42')
    expect(res.status).toBe(201)
    expect(res.body.secret).toMatchObject({ name: 'API_KEY', created_by_name: 'Sara Owner' })
    expect(JSON.stringify(res.body)).not.toContain('sk-live-supersecret-42')

    // Stored ciphertext, not plaintext.
    const row = db.prepare(
      'SELECT value_encrypted FROM workspace_secrets WHERE workspace_id = ? AND name = ?'
    ).get(workspaceId, 'API_KEY')
    expect(row.value_encrypted).not.toContain('sk-live-supersecret-42')
    expect(row.value_encrypted.startsWith('v1:')).toBe(true)
  })

  it('rotates an existing secret in place (200, same name)', async () => {
    const res = await putSecret(ownerToken, 'API_KEY', 'sk-live-rotated-43')
    expect(res.status).toBe(200)
    const { count } = db.prepare(
      'SELECT COUNT(*) AS count FROM workspace_secrets WHERE workspace_id = ? AND name = ?'
    ).get(workspaceId, 'API_KEY')
    expect(count).toBe(1)
  })

  it('lists names + metadata for any member, without values', async () => {
    const res = await listSecrets(memberToken)
    expect(res.status).toBe(200)
    const names = res.body.secrets.map((s) => s.name)
    expect(names).toContain('API_KEY')
    expect(JSON.stringify(res.body)).not.toMatch(/sk-live/)
  })

  it('rejects writes from non-owner members (403) and hides the workspace from outsiders (404)', async () => {
    expect((await putSecret(memberToken, 'NOPE', 'v')).status).toBe(403)
    expect((await putSecret(outsiderToken, 'NOPE', 'v')).status).toBe(404)
    expect((await listSecrets(outsiderToken)).status).toBe(404)
    expect((await request(app).get(`/api/workspaces/${workspaceId}/secrets`)).status).toBe(401)
  })

  it('validates the secret name and value', async () => {
    expect((await putSecret(ownerToken, '1BAD', 'v')).status).toBe(400)
    expect((await putSecret(ownerToken, 'has-dash', 'v')).status).toBe(400)
    expect((await putSecret(ownerToken, 'A'.repeat(65), 'v')).status).toBe(400)
    expect((await putSecret(ownerToken, 'EMPTY_VALUE', '')).status).toBe(400)
    expect((await putSecret(ownerToken, 'TOO_LONG', 'x'.repeat(5000))).status).toBe(400)
  })

  it('deletes a secret (owner-only) and 404s an unknown name', async () => {
    await putSecret(ownerToken, 'TEMP', 'short-lived')
    const memberDelete = await authed(
      request(app).delete(`/api/workspaces/${workspaceId}/secrets/TEMP`), memberToken
    )
    expect(memberDelete.status).toBe(403)

    const res = await authed(
      request(app).delete(`/api/workspaces/${workspaceId}/secrets/TEMP`), ownerToken
    )
    expect(res.status).toBe(204)
    expect(
      (await authed(request(app).delete(`/api/workspaces/${workspaceId}/secrets/TEMP`), ownerToken)).status
    ).toBe(404)
  })

  it('records secret changes in the activity feed without the value', async () => {
    await putSecret(ownerToken, 'FEED_KEY', 'feed-secret-value')
    const event = db.prepare(
      "SELECT * FROM activity_events WHERE workspace_id = ? AND event_type = 'secret.created' AND entity_id = 'FEED_KEY'"
    ).get(workspaceId)
    expect(event).toMatchObject({ entity_type: 'secret', entity_name: 'FEED_KEY' })
    expect(JSON.stringify(event)).not.toContain('feed-secret-value')
  })
})

describe('secrets in the execution engine', () => {
  let workspaceId
  let userId

  const node = (id, type, config = {}) => ({
    id, type, position: { x: 0, y: 0 }, data: { label: id, config },
  })
  const edge = (source, target) => ({ id: `${source}-${target}`, source, target })

  function insertWorkflow(graph) {
    const id = uuidv4()
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by, created_at, updated_at)
       VALUES (?, ?, 'Secret WF', ?, 'draft', ?, ?, ?)`
    ).run(id, workspaceId, JSON.stringify(graph), userId, now, now)
    return id
  }

  function seedExecution(wfId) {
    const id = uuidv4()
    db.prepare(
      "INSERT INTO executions (id, workflow_id, status, triggered_by, trigger_type, created_at) VALUES (?, ?, 'pending', ?, 'manual', ?)"
    ).run(id, wfId, userId, new Date().toISOString())
    return id
  }

  beforeAll(async () => {
    const user = await request(app)
      .post('/api/auth/register')
      .send({ email: 'engine@secrets.test', password: 'password123', displayName: 'Engine User' })
    userId = user.body.user.id
    const ws = await authed(request(app).get('/api/workspaces'), user.body.token)
    workspaceId = ws.body.workspaces[0].id
    await authed(
      request(app)
        .put(`/api/workspaces/${workspaceId}/secrets/WEBHOOK_TOKEN`)
        .send({ value: 'tok-verysecret-9999' }),
      user.body.token
    )
  })

  it('resolves {{secrets.NAME}} in node config and redacts it from step logs and events', async () => {
    const wfId = insertWorkflow({
      nodes: [
        node('t', 'trigger-manual'),
        // The transform bakes the secret into its output — exactly the leak the
        // redactor exists to catch.
        node('x', 'transform', { template: '{"auth": "Bearer {{secrets.WEBHOOK_TOKEN}}"}' }),
      ],
      edges: [edge('t', 'x')],
    })
    const execId = seedExecution(wfId)

    const published = []
    await runExecution(execId, { publish: (p) => published.push(p) })

    expect(db.prepare('SELECT status FROM executions WHERE id = ?').get(execId).status).toBe('completed')

    // The runner saw the real value (it reached the in-memory output)…
    const steps = db.prepare(
      'SELECT * FROM execution_steps WHERE execution_id = ? ORDER BY rowid'
    ).all(execId)
    const transformStep = steps.find((s) => s.node_id === 'x')
    expect(transformStep.status).toBe('succeeded')

    // …but nothing persisted or published contains the plaintext.
    const persisted = JSON.stringify(steps)
    expect(persisted).not.toContain('tok-verysecret-9999')
    expect(persisted).toContain('••••••')
    expect(JSON.stringify(published)).not.toContain('tok-verysecret-9999')

    // The redacted output still shows the shape (Bearer prefix survives).
    expect(JSON.parse(transformStep.output_json).auth).toBe('Bearer ••••••')
  })

  it('passes the real secret value between nodes in memory', async () => {
    const wfId = insertWorkflow({
      nodes: [
        node('t', 'trigger-manual'),
        node('x', 'transform', { template: '{"token": "{{secrets.WEBHOOK_TOKEN}}"}' }),
        // Downstream condition must compare against the *real* value to pass.
        node('c', 'condition', { left: '{{x.token}}', operator: 'equals', right: 'tok-verysecret-9999' }),
      ],
      edges: [edge('t', 'x'), edge('x', 'c')],
    })
    const execId = seedExecution(wfId)
    await runExecution(execId, { publish: noop })

    const step = db.prepare(
      "SELECT * FROM execution_steps WHERE execution_id = ? AND node_id = 'c'"
    ).get(execId)
    expect(step.status).toBe('succeeded')
    // Condition outputs { result: true } only when the in-memory value matched.
    expect(JSON.parse(step.output_json).result).toBe(true)
  })

  it('resolves an unknown secret like any missing placeholder (empty string)', async () => {
    const wfId = insertWorkflow({
      nodes: [
        node('t', 'trigger-manual'),
        node('x', 'transform', { template: '{"v": "[{{secrets.DOES_NOT_EXIST}}]"}' }),
      ],
      edges: [edge('t', 'x')],
    })
    const execId = seedExecution(wfId)
    await runExecution(execId, { publish: noop })

    const step = db.prepare(
      "SELECT * FROM execution_steps WHERE execution_id = ? AND node_id = 'x'"
    ).get(execId)
    expect(JSON.parse(step.output_json).v).toBe('[]')
  })
})
