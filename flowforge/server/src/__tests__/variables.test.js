const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

// Routes pulled in by ../index talk to Bull — mock the queue so nothing
// touches Redis (mirrors the other route suites).
const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))

const { app } = require('../index')
const db = require('../config/database')

const authed = (req, token) => req.set('Authorization', `Bearer ${token}`)

describe('workspace variables', () => {
  let ownerToken
  let workspaceId
  let memberToken
  let outsiderToken

  const putVariable = (token, name, value) =>
    authed(request(app).put(`/api/workspaces/${workspaceId}/variables/${name}`).send({ value }), token)
  const listVariables = (token) =>
    authed(request(app).get(`/api/workspaces/${workspaceId}/variables`), token)

  beforeAll(async () => {
    const owner = await request(app)
      .post('/api/auth/register')
      .send({ email: 'owner@vars.test', password: 'password123', displayName: 'Vera Owner' })
    ownerToken = owner.body.token

    const ws = await authed(request(app).get('/api/workspaces'), ownerToken)
    workspaceId = ws.body.workspaces[0].id

    const member = await request(app)
      .post('/api/auth/register')
      .send({ email: 'member@vars.test', password: 'password123', displayName: 'Milo Member' })
    memberToken = member.body.token
    db.prepare(
      "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'member')"
    ).run(workspaceId, member.body.user.id)

    const outsider = await request(app)
      .post('/api/auth/register')
      .send({ email: 'outsider@vars.test', password: 'password123', displayName: 'Oz Outsider' })
    outsiderToken = outsider.body.token
  })

  it('creates a variable and returns it with its value', async () => {
    const res = await putVariable(ownerToken, 'API_BASE_URL', 'https://api.staging.example.com')
    expect(res.status).toBe(201)
    expect(res.body.variable).toMatchObject({
      name: 'API_BASE_URL',
      value: 'https://api.staging.example.com',
      created_by_name: 'Vera Owner',
    })
    // Stored in cleartext — variables are config, not credentials.
    const row = db.prepare(
      'SELECT value FROM workspace_variables WHERE workspace_id = ? AND name = ?'
    ).get(workspaceId, 'API_BASE_URL')
    expect(row.value).toBe('https://api.staging.example.com')
  })

  it('updates an existing variable in place (200, same name)', async () => {
    const res = await putVariable(ownerToken, 'API_BASE_URL', 'https://api.example.com')
    expect(res.status).toBe(200)
    expect(res.body.variable.value).toBe('https://api.example.com')
    const { count } = db.prepare(
      'SELECT COUNT(*) AS count FROM workspace_variables WHERE workspace_id = ? AND name = ?'
    ).get(workspaceId, 'API_BASE_URL')
    expect(count).toBe(1)
  })

  it('lists variables with values for any member', async () => {
    const res = await listVariables(memberToken)
    expect(res.status).toBe(200)
    expect(res.body.variables).toEqual([
      expect.objectContaining({ name: 'API_BASE_URL', value: 'https://api.example.com' }),
    ])
  })

  it('rejects writes from non-owner members with 403', async () => {
    const res = await putVariable(memberToken, 'CHANNEL', '#alerts')
    expect(res.status).toBe(403)
  })

  it('hides the workspace from outsiders (404, not 403)', async () => {
    expect((await listVariables(outsiderToken)).status).toBe(404)
    expect((await putVariable(outsiderToken, 'X', 'y')).status).toBe(404)
  })

  it('rejects invalid names', async () => {
    expect((await putVariable(ownerToken, '9lives', 'x')).status).toBe(400)
    expect((await putVariable(ownerToken, 'has-dash', 'x')).status).toBe(400)
  })

  it('requires a string value', async () => {
    const res = await authed(
      request(app).put(`/api/workspaces/${workspaceId}/variables/NO_VALUE`).send({}),
      ownerToken
    )
    expect(res.status).toBe(400)
  })

  it('deletes a variable (owner-only)', async () => {
    await putVariable(ownerToken, 'DOOMED', 'x')
    const memberDelete = await authed(
      request(app).delete(`/api/workspaces/${workspaceId}/variables/DOOMED`),
      memberToken
    )
    expect(memberDelete.status).toBe(403)

    const ownerDelete = await authed(
      request(app).delete(`/api/workspaces/${workspaceId}/variables/DOOMED`),
      ownerToken
    )
    expect(ownerDelete.status).toBe(204)

    const missing = await authed(
      request(app).delete(`/api/workspaces/${workspaceId}/variables/DOOMED`),
      ownerToken
    )
    expect(missing.status).toBe(404)
  })

  it('logs activity events without leaking anything odd', async () => {
    const events = db.prepare(
      "SELECT event_type FROM activity_events WHERE workspace_id = ? AND event_type LIKE 'variable.%' ORDER BY created_at"
    ).all(workspaceId)
    const types = events.map((e) => e.event_type)
    expect(types).toContain('variable.created')
    expect(types).toContain('variable.updated')
    expect(types).toContain('variable.deleted')
  })
})
