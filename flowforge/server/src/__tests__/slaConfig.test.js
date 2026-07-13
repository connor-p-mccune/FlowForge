// Per-workflow SLA targets on PUT /api/workflows/:id — validation and
// persistence. The monitor that acts on these lives in slaMonitor.test.js.

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
    .send({ email: 'sla-owner@example.com', password: 'password123', displayName: 'SLA Owner' })
  token = res.body.token
  const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`)
  wsId = ws.body.workspaces[0].id
  userId = require('jsonwebtoken').decode(token).id
  wfId = uuidv4()
  db.prepare(
    'INSERT INTO workflows (id, workspace_id, name, graph_json, created_by) VALUES (?, ?, ?, ?, ?)'
  ).run(wfId, wsId, 'SLA Flow', JSON.stringify({ nodes: [], edges: [] }), userId)
})

const put = (body) =>
  request(app).put(`/api/workflows/${wfId}`).set('Authorization', `Bearer ${token}`).send(body)

describe('SLA targets on PUT /api/workflows/:id', () => {
  it('sets both targets', async () => {
    const res = await put({ name: 'SLA Flow', sla_max_duration_ms: 5000, sla_min_success_rate: 0.9 })
    expect(res.status).toBe(200)
    expect(res.body.workflow.sla_max_duration_ms).toBe(5000)
    expect(res.body.workflow.sla_min_success_rate).toBe(0.9)
  })

  it('leaves targets untouched when the fields are absent', async () => {
    const res = await put({ name: 'Renamed Flow' })
    expect(res.status).toBe(200)
    expect(res.body.workflow.name).toBe('Renamed Flow')
    expect(res.body.workflow.sla_max_duration_ms).toBe(5000)
    expect(res.body.workflow.sla_min_success_rate).toBe(0.9)
  })

  it('clears a target with null', async () => {
    const res = await put({ name: 'SLA Flow', sla_max_duration_ms: null })
    expect(res.status).toBe(200)
    expect(res.body.workflow.sla_max_duration_ms).toBeNull()
    // The other target is preserved.
    expect(res.body.workflow.sla_min_success_rate).toBe(0.9)
  })

  it('rejects a non-positive duration', async () => {
    const res = await put({ name: 'SLA Flow', sla_max_duration_ms: 0 })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/sla_max_duration_ms/)
  })

  it('rejects a non-integer duration', async () => {
    const res = await put({ name: 'SLA Flow', sla_max_duration_ms: 12.5 })
    expect(res.status).toBe(400)
  })

  it('rejects a success rate outside 0..1', async () => {
    const res = await put({ name: 'SLA Flow', sla_min_success_rate: 1.5 })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/sla_min_success_rate/)
  })

  it('rejects a non-numeric success rate', async () => {
    const res = await put({ name: 'SLA Flow', sla_min_success_rate: 'high' })
    expect(res.status).toBe(400)
  })
})
