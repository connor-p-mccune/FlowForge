// Public status pages: owner-only management, the token as the whole
// credential, and a public payload that shares health without leaking
// anything actionable (no ids, no errors, no drafts, no dry runs).

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))

const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')

describe('status pages', () => {
  let jwt
  let workspaceId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'status@example.com', password: 'password123', displayName: 'Owner' })
    jwt = res.body.token
    const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${jwt}`)
    workspaceId = ws.body.workspaces[0].id
  })

  async function createWorkflow(name, { deploy = true } = {}) {
    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/workflows`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ name })
    const wf = res.body.workflow
    await request(app)
      .put(`/api/workflows/${wf.id}/graph`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({
        nodes: [{ id: 't1', type: 'trigger-manual', position: { x: 0, y: 0 }, data: { label: 'Go' } }],
        edges: [],
      })
    if (deploy) {
      await request(app)
        .post(`/api/workflows/${wf.id}/deploy`)
        .set('Authorization', `Bearer ${jwt}`)
    }
    return wf
  }

  function seedRun(workflowId, status, { triggerType = 'manual', minutesAgo = 0, durationMs = 1000 } = {}) {
    const finished = new Date(Date.now() - minutesAgo * 60_000)
    const started = new Date(finished.getTime() - durationMs)
    db.prepare(
      `INSERT INTO executions (id, workflow_id, status, trigger_type, started_at, finished_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      uuidv4(), workflowId, status, triggerType,
      started.toISOString(), finished.toISOString(), started.toISOString()
    )
  }

  it('mints, rotates, and reports the token for owners', async () => {
    expect(
      (await request(app).get(`/api/workspaces/${workspaceId}/status-page`).set('Authorization', `Bearer ${jwt}`)).body.token
    ).toBeNull()

    const first = await request(app)
      .post(`/api/workspaces/${workspaceId}/status-page`)
      .set('Authorization', `Bearer ${jwt}`)
    expect(first.status).toBe(201)
    expect(first.body.token).toMatch(/^[0-9a-f]{48}$/)

    const second = await request(app)
      .post(`/api/workspaces/${workspaceId}/status-page`)
      .set('Authorization', `Bearer ${jwt}`)
    expect(second.body.token).not.toBe(first.body.token)

    // Rotation severs the old link.
    expect((await request(app).get(`/api/status/${first.body.token}`)).status).toBe(404)
    expect((await request(app).get(`/api/status/${second.body.token}`)).status).toBe(200)
  })

  it('refuses management to non-owner members but lets them see the state', async () => {
    const other = await request(app)
      .post('/api/auth/register')
      .send({ email: 'status-member@example.com', password: 'password123', displayName: 'Member' })
    await request(app)
      .post(`/api/workspaces/${workspaceId}/members`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ email: 'status-member@example.com' })

    const view = await request(app)
      .get(`/api/workspaces/${workspaceId}/status-page`)
      .set('Authorization', `Bearer ${other.body.token}`)
    expect(view.status).toBe(200)

    const mint = await request(app)
      .post(`/api/workspaces/${workspaceId}/status-page`)
      .set('Authorization', `Bearer ${other.body.token}`)
    expect(mint.status).toBe(403)

    // Outsiders can't even see that the workspace exists.
    const outsider = await request(app)
      .post('/api/auth/register')
      .send({ email: 'status-outsider@example.com', password: 'password123', displayName: 'Out' })
    const denied = await request(app)
      .get(`/api/workspaces/${workspaceId}/status-page`)
      .set('Authorization', `Bearer ${outsider.body.token}`)
    expect(denied.status).toBe(404)
  })

  it('serves deployed-workflow health without leaking anything actionable', async () => {
    const deployed = await createWorkflow('Nightly ETL')
    await createWorkflow('Half-built draft', { deploy: false })

    seedRun(deployed.id, 'completed', { minutesAgo: 30, durationMs: 2000 })
    seedRun(deployed.id, 'failed', { minutesAgo: 20, durationMs: 500 })
    seedRun(deployed.id, 'completed', { minutesAgo: 10, durationMs: 4000 })
    seedRun(deployed.id, 'completed', { triggerType: 'dry-run', minutesAgo: 5 })

    const minted = await request(app)
      .post(`/api/workspaces/${workspaceId}/status-page`)
      .set('Authorization', `Bearer ${jwt}`)
    const res = await request(app).get(`/api/status/${minted.body.token}`)
    expect(res.status).toBe(200)

    const page = res.body
    const names = page.workflows.map((w) => w.name)
    expect(names).toContain('Nightly ETL')
    expect(names).not.toContain('Half-built draft')

    const etl = page.workflows.find((w) => w.name === 'Nightly ETL')
    expect(etl.runs).toHaveLength(3) // the dry run is not service health
    // Oldest → newest so the bar strip reads left to right.
    expect(etl.runs.map((r) => r.status)).toEqual(['completed', 'failed', 'completed'])
    expect(etl.successRate).toBeCloseTo(2 / 3)
    expect(etl.p50DurationMs).toBe(3000) // median of 2000 and 4000
    expect(etl.lastRunStatus).toBe('completed')

    // Nothing actionable: no ids anywhere in the payload.
    const raw = JSON.stringify(page)
    expect(raw).not.toContain(deployed.id)
    expect(raw).not.toContain(workspaceId)
  })

  it('404s unknown, malformed, and disabled tokens alike', async () => {
    expect((await request(app).get(`/api/status/${'f'.repeat(48)}`)).status).toBe(404)
    expect((await request(app).get('/api/status/short')).status).toBe(404)

    const minted = await request(app)
      .post(`/api/workspaces/${workspaceId}/status-page`)
      .set('Authorization', `Bearer ${jwt}`)
    await request(app)
      .delete(`/api/workspaces/${workspaceId}/status-page`)
      .set('Authorization', `Bearer ${jwt}`)
    expect((await request(app).get(`/api/status/${minted.body.token}`)).status).toBe(404)
  })
})
