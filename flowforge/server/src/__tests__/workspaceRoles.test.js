// The viewer role: member management (list / invite-with-role / role change),
// read access intact, every mutating surface refused with 403 — session API
// and public API alike — and the deliberate exception that viewers may
// comment.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))

const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')

const authed = (req, token) => req.set('Authorization', `Bearer ${token}`)

describe('workspace roles', () => {
  let ownerToken
  let viewerToken
  let viewerId
  let workspaceId
  let workflowId

  beforeAll(async () => {
    const owner = await request(app)
      .post('/api/auth/register')
      .send({ email: 'owner@roles.test', password: 'password123', displayName: 'Rhea Owner' })
    ownerToken = owner.body.token
    workspaceId = (
      await authed(request(app).get('/api/workspaces'), ownerToken)
    ).body.workspaces[0].id

    const viewer = await request(app)
      .post('/api/auth/register')
      .send({ email: 'viewer@roles.test', password: 'password123', displayName: 'Vic Viewer' })
    viewerToken = viewer.body.token
    viewerId = viewer.body.user.id

    const created = await authed(
      request(app).post(`/api/workspaces/${workspaceId}/workflows`).send({ name: 'Observed flow' }),
      ownerToken
    )
    workflowId = created.body.workflow.id
    await authed(
      request(app).put(`/api/workflows/${workflowId}/graph`).send({
        nodes: [
          { id: 't1', type: 'trigger-manual', position: { x: 0, y: 0 }, data: { label: 'Start', config: {} } },
        ],
        edges: [],
      }),
      ownerToken
    )
  })

  it('invites a user as a viewer', async () => {
    const res = await authed(
      request(app)
        .post(`/api/workspaces/${workspaceId}/members`)
        .send({ email: 'viewer@roles.test', role: 'viewer' }),
      ownerToken
    )
    expect(res.status).toBe(201)
    expect(res.body.member).toEqual({ userId: viewerId, role: 'viewer' })
  })

  it('rejects unknown invite roles — and ownership by invitation', async () => {
    for (const role of ['owner', 'admin', 'root']) {
      const res = await authed(
        request(app)
          .post(`/api/workspaces/${workspaceId}/members`)
          .send({ email: 'viewer@roles.test', role }),
        ownerToken
      )
      expect(res.status).toBe(400)
    }
  })

  it('lists members with their roles for any member, viewers included', async () => {
    const res = await authed(request(app).get(`/api/workspaces/${workspaceId}/members`), viewerToken)
    expect(res.status).toBe(200)
    const roles = Object.fromEntries(res.body.members.map((m) => [m.displayName, m.role]))
    expect(roles).toEqual({ 'Rhea Owner': 'owner', 'Vic Viewer': 'viewer' })
  })

  it('viewers keep full read access', async () => {
    const list = await authed(request(app).get(`/api/workspaces/${workspaceId}/workflows`), viewerToken)
    expect(list.status).toBe(200)
    expect(list.body.workflows.map((w) => w.id)).toContain(workflowId)

    const detail = await authed(request(app).get(`/api/workflows/${workflowId}`), viewerToken)
    expect(detail.status).toBe(200)

    const runs = await authed(request(app).get(`/api/workflows/${workflowId}/executions`), viewerToken)
    expect(runs.status).toBe(200)
  })

  it('refuses every mutating workflow operation with 403 — the resource stays visible', async () => {
    const attempts = [
      authed(request(app).post(`/api/workspaces/${workspaceId}/workflows`).send({ name: 'Nope' }), viewerToken),
      authed(request(app).put(`/api/workflows/${workflowId}`).send({ name: 'Renamed' }), viewerToken),
      authed(request(app).put(`/api/workflows/${workflowId}/graph`).send({ nodes: [], edges: [] }), viewerToken),
      authed(request(app).post(`/api/workflows/${workflowId}/execute`), viewerToken),
      authed(request(app).post(`/api/workflows/${workflowId}/test`), viewerToken),
      authed(request(app).post(`/api/workflows/${workflowId}/deploy`), viewerToken),
      authed(request(app).post(`/api/workflows/${workflowId}/archive`), viewerToken),
      authed(request(app).delete(`/api/workflows/${workflowId}`), viewerToken),
      authed(request(app).post(`/api/workflows/${workflowId}/webhooks`).send({}), viewerToken),
      authed(request(app).post(`/api/workflows/${workflowId}/tests`).send({ name: 's', assertions: [{ expression: 'status == "completed"' }] }), viewerToken),
      authed(request(app).post(`/api/workflows/${workflowId}/badge-token`), viewerToken),
      authed(request(app).delete(`/api/workflows/${workflowId}/cache`), viewerToken),
      authed(request(app).put(`/api/workspaces/${workspaceId}`).send({ name: 'Renamed WS' }), viewerToken),
      authed(request(app).post(`/api/workspaces/${workspaceId}/members`).send({ email: 'owner@roles.test' }), viewerToken),
    ]
    for (const attempt of attempts) {
      const res = await attempt
      expect(res.status).toBe(403)
      expect(res.body.error).toMatch(/read-only/)
    }
    // Nothing actually changed.
    const detail = await authed(request(app).get(`/api/workflows/${workflowId}`), ownerToken)
    expect(detail.body.workflow.name).toBe('Observed flow')
    expect(detail.body.workflow.status).toBe('draft')
  })

  it('viewers cannot settle approval gates', async () => {
    const executionId = uuidv4()
    const approvalId = uuidv4()
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO executions (id, workflow_id, status, created_at) VALUES (?, ?, 'running', ?)"
    ).run(executionId, workflowId, now)
    db.prepare(
      `INSERT INTO execution_approvals (id, execution_id, node_id, workflow_id, workspace_id, status, requested_at)
       VALUES (?, ?, 'gate', ?, ?, 'pending', ?)`
    ).run(approvalId, executionId, workflowId, workspaceId, now)

    const res = await authed(
      request(app).post(`/api/approvals/${approvalId}/respond`).send({ decision: 'approve' }),
      viewerToken
    )
    expect(res.status).toBe(403)
    const row = db.prepare('SELECT status FROM execution_approvals WHERE id = ?').get(approvalId)
    expect(row.status).toBe('pending')
  })

  it('viewers may comment — observing and discussing is the role', async () => {
    const res = await authed(
      request(app)
        .post(`/api/workflows/${workflowId}/comments`)
        .send({ x: 10, y: 20, content: 'Should this branch retry?' }),
      viewerToken
    )
    expect(res.status).toBe(201)
  })

  it('a viewer\'s API token is read-only too', async () => {
    const minted = await authed(
      request(app).post('/api/tokens').send({ name: 'viewer-token', scopes: ['trigger', 'read'] }),
      viewerToken
    )
    const apiToken = minted.body.token

    const trigger = await request(app)
      .post(`/api/v1/workflows/${workflowId}/trigger`)
      .set('Authorization', `Bearer ${apiToken}`)
      .send({})
    expect(trigger.status).toBe(403)

    const read = await request(app)
      .get('/api/v1/workflows')
      .set('Authorization', `Bearer ${apiToken}`)
    expect(read.status).toBe(200)
  })

  it('changes a member\'s role (owner-only) and logs it', async () => {
    const byViewer = await authed(
      request(app).put(`/api/workspaces/${workspaceId}/members/${viewerId}`).send({ role: 'member' }),
      viewerToken
    )
    expect(byViewer.status).toBe(403)

    const promote = await authed(
      request(app).put(`/api/workspaces/${workspaceId}/members/${viewerId}`).send({ role: 'member' }),
      ownerToken
    )
    expect(promote.status).toBe(200)
    expect(promote.body.member.role).toBe('member')

    // Promoted: the former viewer can now edit.
    const edit = await authed(
      request(app).put(`/api/workflows/${workflowId}`).send({ name: 'Observed flow' }),
      viewerToken
    )
    expect(edit.status).toBe(200)

    const events = db.prepare(
      "SELECT metadata FROM activity_events WHERE workspace_id = ? AND event_type = 'member.role_changed'"
    ).all(workspaceId)
    expect(events.length).toBe(1)
    expect(JSON.parse(events[0].metadata)).toEqual({ from: 'viewer', to: 'member' })

    // Back to viewer for any later assertions.
    await authed(
      request(app).put(`/api/workspaces/${workspaceId}/members/${viewerId}`).send({ role: 'viewer' }),
      ownerToken
    )
  })

  it('refuses to demote the last owner', async () => {
    const ownerId = db.prepare('SELECT id FROM users WHERE email = ?').get('owner@roles.test').id
    const res = await authed(
      request(app).put(`/api/workspaces/${workspaceId}/members/${ownerId}`).send({ role: 'member' }),
      ownerToken
    )
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/last owner/)
  })

  it('rejects invalid roles on role change', async () => {
    const res = await authed(
      request(app).put(`/api/workspaces/${workspaceId}/members/${viewerId}`).send({ role: 'superuser' }),
      ownerToken
    )
    expect(res.status).toBe(400)
  })
})
