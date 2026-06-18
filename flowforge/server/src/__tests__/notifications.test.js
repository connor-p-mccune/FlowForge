const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const jwt = require('jsonwebtoken')
const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')
const { createNotification } = require('../services/notificationService')
const { notifyExecutionFailed } = require('../workers/executionWorker')

let seq = 0
async function register(displayName = 'User') {
  const email = `notif-${Date.now()}-${seq++}@example.com`
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'password123', displayName })
  return { token: res.body.token, userId: jwt.decode(res.body.token).id, email }
}

async function firstWorkspaceId(token) {
  const res = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`)
  return res.body.workspaces[0].id
}

const authGet = (path, token) => request(app).get(path).set('Authorization', `Bearer ${token}`)
const authPut = (path, token) => request(app).put(path).set('Authorization', `Bearer ${token}`)

// Insert a notification row directly with a controlled created_at so ordering
// assertions are deterministic (no reliance on wall-clock spacing).
function seedNotification(userId, { title, createdAt, isRead = 0, type = 'execution-failed', message = 'm', link = '/' }) {
  const id = uuidv4()
  db.prepare(
    'INSERT INTO notifications (id, user_id, type, title, message, link, is_read, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, userId, type, title, message, link, isRead, createdAt)
  return id
}

describe('GET /api/notifications', () => {
  it('returns an empty list and zero unread for a new user', async () => {
    const { token } = await register()
    const res = await authGet('/api/notifications', token)
    expect(res.status).toBe(200)
    expect(res.body.notifications).toEqual([])
    expect(res.body.unreadCount).toBe(0)
  })

  it('returns notifications newest-first with the unread count', async () => {
    const { token, userId } = await register()
    seedNotification(userId, { title: 'old', createdAt: '2026-01-01T00:00:00.000Z' })
    seedNotification(userId, { title: 'new', createdAt: '2026-02-01T00:00:00.000Z' })
    seedNotification(userId, { title: 'read', createdAt: '2026-01-15T00:00:00.000Z', isRead: 1 })

    const res = await authGet('/api/notifications', token)
    expect(res.body.notifications.map((n) => n.title)).toEqual(['new', 'read', 'old'])
    expect(res.body.unreadCount).toBe(2) // the read one is excluded from the count
  })

  it('caps the list at the 50 most recent', async () => {
    const { token, userId } = await register()
    for (let i = 0; i < 55; i++) {
      const ts = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()
      seedNotification(userId, { title: `n${i}`, createdAt: ts })
    }
    const res = await authGet('/api/notifications', token)
    expect(res.body.notifications).toHaveLength(50)
    expect(res.body.notifications[0].title).toBe('n54') // newest
    expect(res.body.unreadCount).toBe(55) // count is not capped
  })

  it('only ever returns the caller’s own notifications', async () => {
    const a = await register()
    const b = await register()
    seedNotification(a.userId, { title: 'a-only', createdAt: '2026-01-01T00:00:00.000Z' })

    const res = await authGet('/api/notifications', b.token)
    expect(res.body.notifications).toEqual([])
  })

  it('requires auth', async () => {
    const res = await request(app).get('/api/notifications')
    expect(res.status).toBe(401)
  })
})

describe('PUT /api/notifications/:id/read', () => {
  it('marks one notification read and decrements the unread count', async () => {
    const { token, userId } = await register()
    const id = seedNotification(userId, { title: 'one', createdAt: '2026-01-01T00:00:00.000Z' })
    seedNotification(userId, { title: 'two', createdAt: '2026-01-02T00:00:00.000Z' })

    const res = await authPut(`/api/notifications/${id}/read`, token)
    expect(res.status).toBe(200)
    expect(res.body.notification.is_read).toBe(1)

    const after = await authGet('/api/notifications', token)
    expect(after.body.unreadCount).toBe(1)
  })

  it("returns 404 for another user's notification and leaves it unread", async () => {
    const a = await register()
    const b = await register()
    const id = seedNotification(a.userId, { title: 'secret', createdAt: '2026-01-01T00:00:00.000Z' })

    const res = await authPut(`/api/notifications/${id}/read`, b.token)
    expect(res.status).toBe(404)

    const owner = await authGet('/api/notifications', a.token)
    expect(owner.body.unreadCount).toBe(1)
  })

  it('returns 404 for an unknown id', async () => {
    const { token } = await register()
    const res = await authPut(`/api/notifications/${uuidv4()}/read`, token)
    expect(res.status).toBe(404)
  })
})

describe('PUT /api/notifications/read-all', () => {
  it('marks all of the user’s notifications read (route is not shadowed by :id)', async () => {
    const { token, userId } = await register()
    seedNotification(userId, { title: 'a', createdAt: '2026-01-01T00:00:00.000Z' })
    seedNotification(userId, { title: 'b', createdAt: '2026-01-02T00:00:00.000Z' })

    const res = await authPut('/api/notifications/read-all', token)
    expect(res.status).toBe(200)
    expect(res.body.unreadCount).toBe(0)

    const after = await authGet('/api/notifications', token)
    expect(after.body.unreadCount).toBe(0)
    expect(after.body.notifications.every((n) => n.is_read === 1)).toBe(true)
  })

  it("does not touch other users' notifications", async () => {
    const a = await register()
    const b = await register()
    seedNotification(b.userId, { title: 'b-unread', createdAt: '2026-01-01T00:00:00.000Z' })

    await authPut('/api/notifications/read-all', a.token)

    const other = await authGet('/api/notifications', b.token)
    expect(other.body.unreadCount).toBe(1)
  })
})

describe('createNotification (service)', () => {
  it('inserts an unread row that the GET endpoint then returns', async () => {
    const { token, userId } = await register()
    const created = createNotification(userId, {
      type: 'execution-failed', title: 'Workflow Failed', message: 'boom', link: '/workflow/x',
    })
    expect(created.is_read).toBe(0)

    const res = await authGet('/api/notifications', token)
    expect(res.body.unreadCount).toBe(1)
    expect(res.body.notifications[0]).toMatchObject({
      id: created.id, type: 'execution-failed', title: 'Workflow Failed', link: '/workflow/x',
    })
  })
})

describe('POST /api/workspaces/:id/members (invite)', () => {
  it('adds the user and sends them a workspace-invite notification', async () => {
    const inviter = await register('Ada')
    const invitee = await register('Bob')
    const wsId = await firstWorkspaceId(inviter.token)

    const res = await request(app)
      .post(`/api/workspaces/${wsId}/members`)
      .set('Authorization', `Bearer ${inviter.token}`)
      .send({ email: invitee.email })
    expect(res.status).toBe(201)

    const notifs = await authGet('/api/notifications', invitee.token)
    expect(notifs.body.unreadCount).toBe(1)
    const n = notifs.body.notifications[0]
    expect(n.type).toBe('workspace-invite')
    expect(n.title).toBe('Workspace Invitation')
    expect(n.message).toBe("Ada added you to Ada's Workspace")

    // The invitee is now a member of the workspace.
    const ws = await authGet('/api/workspaces', invitee.token)
    expect(ws.body.workspaces.some((w) => w.id === wsId)).toBe(true)
  })

  it('rejects duplicates (409), unknown emails (404), and non-members (404)', async () => {
    const inviter = await register('Cara')
    const invitee = await register('Dan')
    const stranger = await register('Eve')
    const wsId = await firstWorkspaceId(inviter.token)

    const post = (token, email) =>
      request(app).post(`/api/workspaces/${wsId}/members`).set('Authorization', `Bearer ${token}`).send({ email })

    expect((await post(inviter.token, invitee.email)).status).toBe(201)
    expect((await post(inviter.token, invitee.email)).status).toBe(409)
    expect((await post(inviter.token, 'nobody@example.com')).status).toBe(404)
    expect((await post(stranger.token, invitee.email)).status).toBe(404)
  })

  it('requires auth', async () => {
    const res = await request(app)
      .post(`/api/workspaces/${uuidv4()}/members`)
      .send({ email: 'x@example.com' })
    expect(res.status).toBe(401)
  })
})

describe('notifyExecutionFailed (worker)', () => {
  function insertWorkflow(wsId, userId, name) {
    const id = uuidv4()
    db.prepare(
      'INSERT INTO workflows (id, workspace_id, name, graph_json, created_by) VALUES (?, ?, ?, ?, ?)'
    ).run(id, wsId, name, '{"nodes":[],"edges":[]}', userId)
    return id
  }
  function insertExecution(wfId, userId, status) {
    const id = uuidv4()
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO executions (id, workflow_id, status, triggered_by, started_at, finished_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, wfId, status, userId, now, now, now)
    return id
  }

  it('notifies the workflow owner on a failed run, with a deep link to the run', async () => {
    const owner = await register('Owner')
    const wsId = await firstWorkspaceId(owner.token)
    const wfId = insertWorkflow(wsId, owner.userId, 'Nightly Sync')
    const execId = insertExecution(wfId, owner.userId, 'failed')

    notifyExecutionFailed(execId)

    const res = await authGet('/api/notifications', owner.token)
    expect(res.body.unreadCount).toBe(1)
    const n = res.body.notifications[0]
    expect(n.type).toBe('execution-failed')
    expect(n.title).toBe('Workflow Failed')
    expect(n.message).toBe('Your workflow "Nightly Sync" failed during execution')
    expect(n.link).toBe(`/workflow/${wfId}?execution=${execId}`)
  })

  it('does nothing when the run did not fail', async () => {
    const owner = await register('Owner2')
    const wsId = await firstWorkspaceId(owner.token)
    const wfId = insertWorkflow(wsId, owner.userId, 'OK Flow')
    const execId = insertExecution(wfId, owner.userId, 'completed')

    notifyExecutionFailed(execId)

    const res = await authGet('/api/notifications', owner.token)
    expect(res.body.unreadCount).toBe(0)
  })
})
