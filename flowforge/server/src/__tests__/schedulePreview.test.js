// Schedule preview: GET /api/workflows/:id/schedule and POST
// /api/schedule/preview (session), plus GET /api/v1/workflows/:id/schedule
// (public token API). The cron math lives in services/cronExpression.js and is
// unit-tested there; these tests cover the route wiring, auth, and the
// scheduled/unscheduled/impossible shapes.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))

const jwt = require('jsonwebtoken')
const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')

let token, userId, wsId

const NODE = (id, type, config = {}) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label: id, config },
})

// A workflow whose graph is exactly the given nodes, at the given status.
function insertWorkflow(nodes, { status = 'deployed' } = {}) {
  const id = uuidv4()
  db.prepare(
    'INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, wsId, 'Sched Flow', JSON.stringify({ nodes, edges: [] }), status, userId)
  return id
}

// A personal access token with the given scopes, for the public API tests.
async function mintApiToken(scopes) {
  const res = await request(app)
    .post('/api/tokens')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'sched', scopes })
  return res.body.token
}

beforeAll(async () => {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: 'sched-preview@example.com', password: 'password123', displayName: 'Sched' })
  token = res.body.token
  userId = jwt.decode(token).id
  const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`)
  wsId = ws.body.workspaces[0].id
})

describe('GET /api/workflows/:id/schedule', () => {
  it('requires authentication', async () => {
    const wf = insertWorkflow([NODE('s', 'trigger-schedule', { cron: '0 9 * * *' })])
    const res = await request(app).get(`/api/workflows/${wf}/schedule`)
    expect(res.status).toBe(401)
  })

  it('previews the next runs of a deployed schedule', async () => {
    const wf = insertWorkflow([NODE('s', 'trigger-schedule', { cron: '0 9 * * *' })])
    const res = await request(app)
      .get(`/api/workflows/${wf}/schedule?count=3`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.scheduled).toBe(true)
    expect(res.body.active).toBe(true)
    expect(res.body.cron).toBe('0 9 * * *')
    expect(res.body.reachable).toBe(true)
    expect(res.body.nextRuns).toHaveLength(3)
    // Every fire time is at 09:00 UTC.
    for (const iso of res.body.nextRuns) {
      expect(new Date(iso).getUTCHours()).toBe(9)
      expect(new Date(iso).getUTCMinutes()).toBe(0)
    }
  })

  it('marks an undeployed schedule inactive but still previews it', async () => {
    const wf = insertWorkflow([NODE('s', 'trigger-schedule', { cron: '*/30 * * * *' })], { status: 'draft' })
    const res = await request(app)
      .get(`/api/workflows/${wf}/schedule`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.scheduled).toBe(true)
    expect(res.body.active).toBe(false)
    expect(res.body.nextRuns.length).toBeGreaterThan(0)
  })

  it('reports scheduled:false for a workflow with no schedule trigger', async () => {
    const wf = insertWorkflow([NODE('t', 'trigger-manual')])
    const res = await request(app)
      .get(`/api/workflows/${wf}/schedule`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.scheduled).toBe(false)
    expect(res.body.nextRuns).toEqual([])
  })

  it('reports an unreachable schedule honestly (reachable:false, no runs)', async () => {
    const wf = insertWorkflow([NODE('s', 'trigger-schedule', { cron: '0 0 30 2 *' })])
    const res = await request(app)
      .get(`/api/workflows/${wf}/schedule`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.scheduled).toBe(true)
    expect(res.body.reachable).toBe(false)
    expect(res.body.nextRuns).toEqual([])
  })

  it('404s for a workflow the user cannot see', async () => {
    const wf = insertWorkflow([NODE('s', 'trigger-schedule', { cron: '0 9 * * *' })])
    const other = await request(app)
      .post('/api/auth/register')
      .send({ email: 'sched-out@example.com', password: 'password123', displayName: 'Out' })
    const res = await request(app)
      .get(`/api/workflows/${wf}/schedule`)
      .set('Authorization', `Bearer ${other.body.token}`)
    expect(res.status).toBe(404)
  })
})

describe('POST /api/schedule/preview', () => {
  it('previews an arbitrary expression without touching any workflow', async () => {
    const res = await request(app)
      .post('/api/schedule/preview')
      .set('Authorization', `Bearer ${token}`)
      .send({ cron: '0 9 * * MON-FRI', count: 2 })
    expect(res.status).toBe(200)
    expect(res.body.nextRuns).toHaveLength(2)
    // Weekday-only: never a Saturday (6) or Sunday (0).
    for (const iso of res.body.nextRuns) {
      expect([0, 6]).not.toContain(new Date(iso).getUTCDay())
    }
  })

  it('400s on a missing expression', async () => {
    const res = await request(app)
      .post('/api/schedule/preview')
      .set('Authorization', `Bearer ${token}`)
      .send({})
    expect(res.status).toBe(400)
  })

  it('400s on an invalid expression', async () => {
    const res = await request(app)
      .post('/api/schedule/preview')
      .set('Authorization', `Bearer ${token}`)
      .send({ cron: 'not a cron' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/not a valid cron/)
  })
})

describe('GET /api/v1/workflows/:id/schedule (public API)', () => {
  it('previews the schedule for a read-scoped token', async () => {
    const wf = insertWorkflow([NODE('s', 'trigger-schedule', { cron: '0 0 * * *' })])
    const apiToken = await mintApiToken(['read'])
    const res = await request(app)
      .get(`/api/v1/workflows/${wf}/schedule`)
      .set('Authorization', `Bearer ${apiToken}`)
    expect(res.status).toBe(200)
    expect(res.body.scheduled).toBe(true)
    expect(res.body.nextRuns.length).toBeGreaterThan(0)
  })

  it('rejects a token without the read scope', async () => {
    const wf = insertWorkflow([NODE('s', 'trigger-schedule', { cron: '0 0 * * *' })])
    const apiToken = await mintApiToken(['trigger'])
    const res = await request(app)
      .get(`/api/v1/workflows/${wf}/schedule`)
      .set('Authorization', `Bearer ${apiToken}`)
    expect(res.status).toBe(403)
  })
})
