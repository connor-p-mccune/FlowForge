// The workspace schedule report over both surfaces.
//
// Both read stored crons and recorded durations, so the split is purely about
// who is asking. The parameter worth testing is `capacity`: nothing here
// invents one, because the worker concurrency is a deployment fact this
// process may not share and a verdict built on a guess is worse than none.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

jest.mock('../config/queue', () => ({
  getExecutionQueue: () => ({ add: jest.fn().mockResolvedValue(undefined) }),
}))
jest.mock('../config/redis', () => ({ publish: jest.fn().mockResolvedValue(1) }))

const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')

const MIN = 60000

describe('workspace schedule endpoints', () => {
  let jwt
  let readToken
  let userId
  let workspaceId

  function addScheduled(name, cron, durationMs) {
    const id = uuidv4()
    db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by)
       VALUES (?, ?, ?, ?, 'deployed', ?)`
    ).run(
      id,
      workspaceId,
      name,
      JSON.stringify({
        nodes: [
          { id: 't', type: 'trigger-schedule', position: { x: 0, y: 0 }, data: { config: { cron } } },
        ],
        edges: [],
      }),
      userId
    )
    const insert = db.prepare(
      `INSERT INTO executions (id, workflow_id, status, created_at, started_at, finished_at)
       VALUES (?, ?, 'completed', ?, ?, ?)`
    )
    for (let i = 0; i < 3; i += 1) {
      const at = Date.now() - (i + 1) * 86400000
      insert.run(
        uuidv4(),
        id,
        new Date(at).toISOString(),
        new Date(at).toISOString(),
        new Date(at + durationMs).toISOString()
      )
    }
    return id
  }

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'sched@example.com', password: 'password123', displayName: 'Sch' })
    jwt = res.body.token
    userId = db.prepare('SELECT id FROM users WHERE email = ?').get('sched@example.com').id
    workspaceId = (
      await request(app).get('/api/workspaces').set('Authorization', `Bearer ${jwt}`)
    ).body.workspaces[0].id

    addScheduled('Nightly reconcile', '0 0 * * *', 40 * MIN)
    addScheduled('Digest', '0 0 * * *', 20 * MIN)

    readToken = (
      await request(app)
        .post('/api/tokens')
        .set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'reader', scopes: ['read'] })
    ).body.token
  })

  describe('GET /api/v1/workspaces/:id/schedule', () => {
    const get = (query = '', token = readToken) =>
      request(app)
        .get(`/api/v1/workspaces/${workspaceId}/schedule${query}`)
        .set('Authorization', `Bearer ${token}`)

    it('finds the peak and names what is in it', async () => {
      const res = await get('?days=2')
      expect(res.status).toBe(200)
      expect(res.body.available).toBe(true)
      expect(res.body.peak.concurrent).toBe(2)
      expect(res.body.peak.workflows.map((w) => w.name).sort()).toEqual([
        'Digest',
        'Nightly reconcile',
      ])
    })

    it('says how much of the schedule lands on the hour', async () => {
      expect((await get('?days=2')).body.clock.onTheHour).toBeGreaterThan(0)
    })

    it('reaches no verdict until it is told what the machine can do', async () => {
      expect((await get('?days=2')).body.summary.overCapacity).toBeNull()
      expect((await get('?days=2&capacity=1')).body.summary.overCapacity).toBe(true)
      expect((await get('?days=2&capacity=8')).body.summary.overCapacity).toBe(false)
    })

    it('clamps a horizon nobody could mean', async () => {
      expect((await get('?days=0')).body.horizonDays).toBe(1)
      expect((await get('?days=9999')).body.horizonDays).toBe(31)
      expect((await get('?days=nonsense')).body.horizonDays).toBe(7)
    })

    it('ignores a capacity that is not a positive number', async () => {
      expect((await get('?days=2&capacity=0')).body.summary.capacity).toBeNull()
      expect((await get('?days=2&capacity=abc')).body.summary.capacity).toBeNull()
    })

    it('refuses a token with no read scope', async () => {
      const writeOnly = (
        await request(app)
          .post('/api/tokens')
          .set('Authorization', `Bearer ${jwt}`)
          .send({ name: 'runner', scopes: ['trigger'] })
      ).body.token
      expect((await get('', writeOnly)).status).toBe(403)
    })

    it('hides a workspace the token cannot see', async () => {
      const res = await request(app)
        .get(`/api/v1/workspaces/${uuidv4()}/schedule`)
        .set('Authorization', `Bearer ${readToken}`)
      expect(res.status).toBe(404)
    })
  })

  describe('GET /api/workspaces/:id/schedule', () => {
    it('gives the app the same answer a pipeline gets', async () => {
      const session = await request(app)
        .get(`/api/workspaces/${workspaceId}/schedule?days=2`)
        .set('Authorization', `Bearer ${jwt}`)
      const token = await request(app)
        .get(`/api/v1/workspaces/${workspaceId}/schedule?days=2`)
        .set('Authorization', `Bearer ${readToken}`)
      expect(session.status).toBe(200)
      expect(session.body.peak.concurrent).toBe(token.body.peak.concurrent)
      expect(session.body.summary).toEqual(token.body.summary)
    })

    it('hides a workspace the caller is not in', async () => {
      const outsider = (
        await request(app)
          .post('/api/auth/register')
          .send({ email: 'outsider-s@example.com', password: 'password123', displayName: 'Out' })
      ).body.token
      const res = await request(app)
        .get(`/api/workspaces/${workspaceId}/schedule`)
        .set('Authorization', `Bearer ${outsider}`)
      expect(res.status).toBe(404)
    })

    it('needs a session', async () => {
      expect((await request(app).get(`/api/workspaces/${workspaceId}/schedule`)).status).toBe(401)
    })
  })
})
