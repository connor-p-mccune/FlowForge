const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

// Trigger enqueues through Bull — mock the queue so nothing touches Redis.
const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))

const { app } = require('../index')
const db = require('../config/database')

const authed = (req, token) => req.set('Authorization', `Bearer ${token}`)

describe('personal access tokens + public API v1', () => {
  let jwt // session token (manages tokens)
  let userId
  let workflowId
  let strangerJwt

  beforeAll(async () => {
    const user = await request(app)
      .post('/api/auth/register')
      .send({ email: 'dev@tokens.test', password: 'password123', displayName: 'Dana Dev' })
    jwt = user.body.token
    userId = user.body.user.id

    const ws = await authed(request(app).get('/api/workspaces'), jwt)
    const workspaceId = ws.body.workspaces[0].id

    const wf = await authed(
      request(app).post(`/api/workspaces/${workspaceId}/workflows`).send({ name: 'API Triggered' }),
      jwt
    )
    workflowId = wf.body.workflow.id
    // Give it a runnable graph (trigger → log).
    await authed(
      request(app).put(`/api/workflows/${workflowId}/graph`).send({
        nodes: [
          { id: 't', type: 'trigger-webhook', position: { x: 0, y: 0 }, data: { label: 'T', config: {} } },
          { id: 'l', type: 'output-log', position: { x: 0, y: 100 }, data: { label: 'L', config: { message: 'hi' } } },
        ],
        edges: [{ id: 't-l', source: 't', target: 'l' }],
      }),
      jwt
    )

    const stranger = await request(app)
      .post('/api/auth/register')
      .send({ email: 'stranger@tokens.test', password: 'password123', displayName: 'Sam Stranger' })
    strangerJwt = stranger.body.token
  })

  async function mint(body = { name: 'ci token' }, sessionJwt = jwt) {
    const res = await authed(request(app).post('/api/tokens').send(body), sessionJwt)
    expect(res.status).toBe(201)
    return res.body
  }

  it('mints a token, returning the full value exactly once', async () => {
    const { token, apiToken } = await mint({ name: 'deploy hook' })
    expect(token).toMatch(/^ffp_[0-9a-f]{40}$/)
    // No explicit scopes → the full set, including approve and manage.
    expect(apiToken).toMatchObject({
      name: 'deploy hook',
      scopes: ['trigger', 'read', 'approve', 'manage'],
    })
    expect(apiToken.tokenPrefix).toBe(token.slice(0, 12))

    // The list never exposes the value or the hash.
    const list = await authed(request(app).get('/api/tokens'), jwt)
    expect(list.status).toBe(200)
    const listed = JSON.stringify(list.body)
    expect(listed).not.toContain(token)
    expect(listed).not.toMatch(/token_hash|"hash"/)

    // Only the hash hits the database.
    const row = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(apiToken.id)
    expect(row.token_hash).not.toBe(token)
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('validates name, scopes, and expiry', async () => {
    expect((await authed(request(app).post('/api/tokens').send({}), jwt)).status).toBe(400)
    expect(
      (await authed(request(app).post('/api/tokens').send({ name: 'x', scopes: ['admin'] }), jwt)).status
    ).toBe(400)
    expect(
      (await authed(request(app).post('/api/tokens').send({ name: 'x', scopes: [] }), jwt)).status
    ).toBe(400)
    expect(
      (await authed(request(app).post('/api/tokens').send({ name: 'x', expiresInDays: 0 }), jwt)).status
    ).toBe(400)
    expect(
      (await authed(request(app).post('/api/tokens').send({ name: 'x', expiresInDays: 9999 }), jwt)).status
    ).toBe(400)
  })

  it('triggers a workflow through /api/v1 and records an api-typed execution', async () => {
    const { token } = await mint({ name: 'trigger token', scopes: ['trigger'] })
    mockAdd.mockClear()

    const res = await request(app)
      .post(`/api/v1/workflows/${workflowId}/trigger`)
      .set('Authorization', `Bearer ${token}`)
      .send({ orderId: 42 })
    expect(res.status).toBe(202)
    expect(res.body.execution.status).toBe('pending')
    expect(res.body.statusUrl).toContain(res.body.execution.id)

    const row = db.prepare('SELECT * FROM executions WHERE id = ?').get(res.body.execution.id)
    expect(row).toMatchObject({ workflow_id: workflowId, trigger_type: 'api', triggered_by: userId })
    expect(JSON.parse(row.trigger_data)).toEqual({ orderId: 42 })
    expect(mockAdd).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId, payload: { orderId: 42 } }),
      { priority: 5 }
    )
  })

  it('reads execution status with the read scope', async () => {
    const { token } = await mint({ name: 'reader' })
    const trigger = await request(app)
      .post(`/api/v1/workflows/${workflowId}/trigger`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
    const execId = trigger.body.execution.id

    const res = await request(app)
      .get(`/api/v1/executions/${execId}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.execution).toMatchObject({ id: execId, workflowId, status: 'pending' })
    expect(Array.isArray(res.body.steps)).toBe(true)

    // Workflow listing works too and includes the triggerable id.
    const list = await request(app).get('/api/v1/workflows').set('Authorization', `Bearer ${token}`)
    expect(list.status).toBe(200)
    expect(list.body.workflows.map((w) => w.id)).toContain(workflowId)
  })

  it('enforces scopes: a read-only token cannot trigger, a trigger-only token cannot read', async () => {
    const readOnly = await mint({ name: 'ro', scopes: ['read'] })
    const triggerOnly = await mint({ name: 'to', scopes: ['trigger'] })

    const denied = await request(app)
      .post(`/api/v1/workflows/${workflowId}/trigger`)
      .set('Authorization', `Bearer ${readOnly.token}`)
      .send({})
    expect(denied.status).toBe(403)
    expect(denied.body.error).toMatch(/trigger/)

    const deniedRead = await request(app)
      .get('/api/v1/workflows')
      .set('Authorization', `Bearer ${triggerOnly.token}`)
    expect(deniedRead.status).toBe(403)
  })

  it('rejects garbage, revoked, and expired tokens (401)', async () => {
    expect(
      (await request(app).get('/api/v1/workflows').set('Authorization', 'Bearer ffp_' + 'a'.repeat(40))).status
    ).toBe(401)
    expect((await request(app).get('/api/v1/workflows')).status).toBe(401)

    // Session JWTs are not valid on the public API.
    expect((await request(app).get('/api/v1/workflows').set('Authorization', `Bearer ${jwt}`)).status).toBe(401)

    // Revoked
    const { token, apiToken } = await mint({ name: 'shortlived' })
    expect((await authed(request(app).delete(`/api/tokens/${apiToken.id}`), jwt)).status).toBe(204)
    const revoked = await request(app).get('/api/v1/workflows').set('Authorization', `Bearer ${token}`)
    expect(revoked.status).toBe(401)
    expect(revoked.body.error).toMatch(/revoked/i)

    // Expired (force the column into the past)
    const exp = await mint({ name: 'expiring', expiresInDays: 1 })
    db.prepare('UPDATE api_tokens SET expires_at = ? WHERE id = ?')
      .run('2020-01-01T00:00:00.000Z', exp.apiToken.id)
    const expired = await request(app).get('/api/v1/workflows').set('Authorization', `Bearer ${exp.token}`)
    expect(expired.status).toBe(401)
    expect(expired.body.error).toMatch(/expired/i)
  })

  it('scopes access to the owner: foreign workflows 404, foreign tokens unrevokable', async () => {
    const { token, apiToken } = await mint({ name: 'mine' })

    // A stranger can't revoke someone else's token…
    expect(
      (await authed(request(app).delete(`/api/tokens/${apiToken.id}`), strangerJwt)).status
    ).toBe(404)

    // …and a token only sees its owner's workspaces.
    const strangerToken = await mint({ name: 'strangers', scopes: ['trigger', 'read'] }, strangerJwt)
    const res = await request(app)
      .post(`/api/v1/workflows/${workflowId}/trigger`)
      .set('Authorization', `Bearer ${strangerToken.token}`)
      .send({})
    expect(res.status).toBe(404)
    expect(token).toBeDefined()
  })

  it('stamps last_used_at when a token authenticates', async () => {
    const { token, apiToken } = await mint({ name: 'stamped' })
    expect(apiToken.lastUsedAt).toBeNull()
    await request(app).get('/api/v1/workflows').set('Authorization', `Bearer ${token}`)
    const row = db.prepare('SELECT last_used_at FROM api_tokens WHERE id = ?').get(apiToken.id)
    expect(row.last_used_at).not.toBeNull()
  })

  it('API tokens cannot reach the session API', async () => {
    const { token } = await mint({ name: 'no crossover' })
    // auth middleware treats it as an (invalid) JWT.
    expect((await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`)).status).toBe(401)
    expect((await request(app).get('/api/tokens').set('Authorization', `Bearer ${token}`)).status).toBe(401)
  })
})
