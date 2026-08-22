// The drift surfaces: GET /api/workflows/:id/drift (session),
// GET /api/v1/workflows/:id/drift (token), and the per-workflow alerting toggle
// on PUT /api/workflows/:id.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: jest.fn().mockResolvedValue(undefined) }) }))
jest.mock('../config/redis', () => ({ publish: jest.fn().mockResolvedValue(1) }))

const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')

const GRAPH = {
  nodes: [{ id: 'fetch', type: 'action-http', data: { label: 'Fetch orders' } }],
  edges: [],
}

let clock = Date.parse('2026-03-01T00:00:00.000Z')
function seedRuns(workflowId, userId, count, make) {
  for (let i = 0; i < count; i++) {
    clock += 60_000
    const at = new Date(clock).toISOString()
    const execId = uuidv4()
    db.prepare(
      `INSERT INTO executions (id, workflow_id, status, trigger_type, triggered_by, started_at, finished_at, created_at)
       VALUES (?, ?, 'completed', 'api', ?, ?, ?, ?)`
    ).run(execId, workflowId, userId, at, at, at)
    db.prepare(
      `INSERT INTO execution_steps (id, execution_id, node_id, node_type, status, output_json, started_at, finished_at)
       VALUES (?, ?, 'fetch', 'action-http', 'succeeded', ?, ?, ?)`
    ).run(uuidv4(), execId, JSON.stringify(make(i)), at, at)
  }
}

describe('drift endpoints', () => {
  let jwt
  let readToken
  let triggerToken
  let userId
  let workspaceId
  let driftedId
  let steadyId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'drift-route@example.com', password: 'password123', displayName: 'Drift' })
    jwt = res.body.token
    userId = db.prepare('SELECT id FROM users WHERE email = ?').get('drift-route@example.com').id
    workspaceId = (await request(app).get('/api/workspaces').set('Authorization', `Bearer ${jwt}`))
      .body.workspaces[0].id

    const create = (name) => {
      const id = uuidv4()
      db.prepare(
        `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by)
         VALUES (?, ?, ?, ?, 'deployed', ?)`
      ).run(id, workspaceId, name, JSON.stringify(GRAPH), userId)
      return id
    }
    driftedId = create('Drifted')
    steadyId = create('Steady')

    // Drifted: a field that started coming back null.
    seedRuns(driftedId, userId, 70, () => ({ email: 'a@b.com', total: 100 }))
    seedRuns(driftedId, userId, 50, (i) => ({ email: i % 10 < 6 ? null : 'a@b.com', total: 100 }))
    // Steady: whole cycles in both windows.
    seedRuns(steadyId, userId, 120, (i) => ({ total: 100 + (i % 40), status: 'ok' }))

    readToken = (
      await request(app).post('/api/tokens').set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'reader', scopes: ['read'] })
    ).body.token
    triggerToken = (
      await request(app).post('/api/tokens').set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'runner', scopes: ['trigger'] })
    ).body.token
  })

  describe('GET /api/workflows/:id/drift', () => {
    it('reports the finding, the node label, and the evidence', async () => {
      const res = await request(app)
        .get(`/api/workflows/${driftedId}/drift?recent=50&baseline=70`)
        .set('Authorization', `Bearer ${jwt}`)

      expect(res.status).toBe(200)
      expect(res.body.available).toBe(true)
      expect(res.body.summary.major).toBeGreaterThan(0)

      const finding = res.body.nodes[0].findings.find((f) => f.kind === 'null-rate')
      expect(finding.nodeLabel).toBe('Fetch orders')
      expect(finding.path).toBe('email')
      expect(finding.detail.test).toBe('two-proportion')
      expect(finding.summary).toMatch(/null in 60\.0% of records, was 0\.0%/)
    })

    it('reports nothing for a workflow whose output is steady', async () => {
      const res = await request(app)
        .get(`/api/workflows/${steadyId}/drift?recent=40&baseline=80`)
        .set('Authorization', `Bearer ${jwt}`)
      expect(res.body.available).toBe(true)
      expect(res.body.summary.major).toBe(0)
      expect(res.body.summary.minor).toBe(0)
    })

    it('is available whether or not the workflow opted into alerting', async () => {
      const res = await request(app)
        .get(`/api/workflows/${driftedId}/drift?recent=50&baseline=70`)
        .set('Authorization', `Bearer ${jwt}`)
      expect(res.body.monitoring).toBe(false)
      expect(res.body.available).toBe(true)
    })

    it('says so when a workflow has too little history to judge', async () => {
      const bare = uuidv4()
      db.prepare(
        `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by)
         VALUES (?, ?, 'Fresh', ?, 'deployed', ?)`
      ).run(bare, workspaceId, JSON.stringify(GRAPH), userId)

      const res = await request(app)
        .get(`/api/workflows/${bare}/drift`)
        .set('Authorization', `Bearer ${jwt}`)
      expect(res.body.available).toBe(false)
      expect(res.body.reason).toBe('insufficient-history')
    })

    it('404s for a non-member', async () => {
      const other = await request(app)
        .post('/api/auth/register')
        .send({ email: 'drift-other@example.com', password: 'password123', displayName: 'Other' })
      const res = await request(app)
        .get(`/api/workflows/${driftedId}/drift`)
        .set('Authorization', `Bearer ${other.body.token}`)
      expect(res.status).toBe(404)
    })
  })

  describe('GET /api/v1/workflows/:id/drift', () => {
    it('serves the same report to a read token', async () => {
      const res = await request(app)
        .get(`/api/v1/workflows/${driftedId}/drift?recent=50&baseline=70`)
        .set('Authorization', `Bearer ${readToken}`)
      expect(res.status).toBe(200)
      expect(res.body.summary.major).toBeGreaterThan(0)
    })

    it('refuses a token without the read scope', async () => {
      const res = await request(app)
        .get(`/api/v1/workflows/${driftedId}/drift`)
        .set('Authorization', `Bearer ${triggerToken}`)
      expect(res.status).toBe(403)
    })

    it('401s without a token', async () => {
      expect((await request(app).get(`/api/v1/workflows/${driftedId}/drift`)).status).toBe(401)
    })
  })

  describe('the alerting toggle', () => {
    it('turns alerting on and off through the workflow settings', async () => {
      const on = await request(app)
        .put(`/api/workflows/${driftedId}`)
        .set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'Drifted', drift_monitoring: true })
      expect(on.status).toBe(200)
      expect(on.body.workflow.drift_monitoring).toBe(1)

      const off = await request(app)
        .put(`/api/workflows/${driftedId}`)
        .set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'Drifted', drift_monitoring: false })
      expect(off.body.workflow.drift_monitoring).toBe(0)
    })

    it('clears the outstanding alert when alerting is switched off', async () => {
      // Otherwise re-enabling later would stay silent about a drift the first
      // alert already reported, and nobody would see it again.
      db.prepare(
        'UPDATE workflows SET drift_monitoring = 1, drift_alerted_at = ?, drift_fingerprint = ? WHERE id = ?'
      ).run(new Date().toISOString(), 'abc123', driftedId)

      await request(app)
        .put(`/api/workflows/${driftedId}`)
        .set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'Drifted', drift_monitoring: false })

      const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(driftedId)
      expect(row.drift_alerted_at).toBeNull()
      expect(row.drift_fingerprint).toBeNull()
    })

    it('leaves the setting alone when the patch does not mention it', async () => {
      await request(app)
        .put(`/api/workflows/${driftedId}`)
        .set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'Drifted', drift_monitoring: true })

      const res = await request(app)
        .put(`/api/workflows/${driftedId}`)
        .set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'Renamed' })
      expect(res.body.workflow.drift_monitoring).toBe(1)
    })
  })
})
