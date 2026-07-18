// The heartbeat expectation on PUT /api/workflows/:id — validation,
// persistence, and the alert-state reset on change. The monitor that acts on
// the expectation lives in heartbeatMonitor.test.js.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))

const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')

let token, userId, wsId, wfId

beforeAll(async () => {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: 'hb-owner@example.com', password: 'password123', displayName: 'HB Owner' })
  token = res.body.token
  const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`)
  wsId = ws.body.workspaces[0].id
  userId = require('jsonwebtoken').decode(token).id
  wfId = uuidv4()
  db.prepare(
    'INSERT INTO workflows (id, workspace_id, name, graph_json, created_by) VALUES (?, ?, ?, ?, ?)'
  ).run(wfId, wsId, 'Heartbeat Flow', JSON.stringify({ nodes: [], edges: [] }), userId)
})

const put = (body) =>
  request(app).put(`/api/workflows/${wfId}`).set('Authorization', `Bearer ${token}`).send(body)

describe('heartbeat expectation on PUT /api/workflows/:id', () => {
  it('sets the interval', async () => {
    const res = await put({ name: 'Heartbeat Flow', heartbeat_interval_minutes: 30 })
    expect(res.status).toBe(200)
    expect(res.body.workflow.heartbeat_interval_minutes).toBe(30)
  })

  it('leaves the interval untouched when the field is absent', async () => {
    const res = await put({ name: 'Renamed Flow' })
    expect(res.status).toBe(200)
    expect(res.body.workflow.heartbeat_interval_minutes).toBe(30)
  })

  it('changing the interval clears an outstanding alert', async () => {
    db.prepare('UPDATE workflows SET heartbeat_alerted_at = ? WHERE id = ?')
      .run(new Date().toISOString(), wfId)

    // Same interval: alert state is preserved.
    const same = await put({ name: 'Heartbeat Flow', heartbeat_interval_minutes: 30 })
    expect(same.body.workflow.heartbeat_alerted_at).not.toBeNull()

    // New interval: the old alert answered the old promise.
    const changed = await put({ name: 'Heartbeat Flow', heartbeat_interval_minutes: 60 })
    expect(changed.body.workflow.heartbeat_alerted_at).toBeNull()
  })

  it('clears the expectation (and any alert) with null', async () => {
    db.prepare('UPDATE workflows SET heartbeat_alerted_at = ? WHERE id = ?')
      .run(new Date().toISOString(), wfId)
    const res = await put({ name: 'Heartbeat Flow', heartbeat_interval_minutes: null })
    expect(res.status).toBe(200)
    expect(res.body.workflow.heartbeat_interval_minutes).toBeNull()
    expect(res.body.workflow.heartbeat_alerted_at).toBeNull()
  })

  it('rejects a non-positive, non-integer, or over-long interval', async () => {
    for (const bad of [0, -5, 2.5, 'soon', 10081]) {
      const res = await put({ name: 'Heartbeat Flow', heartbeat_interval_minutes: bad })
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/heartbeat_interval_minutes/)
    }
  })
})
