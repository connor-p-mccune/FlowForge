// The run query endpoint.
//
// A POST because a predicate is a program, not a parameter — a useful one runs
// past what belongs in a URL, and quoting an expression full of brackets and
// quotes through a query string is a worse experience than a body.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: jest.fn().mockResolvedValue(undefined) }) }))
jest.mock('../config/redis', () => ({ publish: jest.fn().mockResolvedValue(1) }))

const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')

const iso = (ms) => new Date(ms).toISOString()
const BASE = Date.parse('2026-08-01T00:00:00.000Z')

describe('POST /api/v1/workflows/:id/query', () => {
  let jwt
  let readToken
  let triggerToken
  let userId
  let workflowId

  const seedRun = ({ status, offset, durationMs = 1000, trigger = null, steps = [] }) => {
    const id = uuidv4()
    const created = BASE + offset
    db.prepare(
      `INSERT INTO executions (id, workflow_id, status, triggered_by, trigger_data,
                               created_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, workflowId, status, userId, trigger ? JSON.stringify(trigger) : null,
      iso(created), iso(created), iso(created + durationMs)
    )
    for (const step of steps) {
      db.prepare(
        `INSERT INTO execution_steps (id, execution_id, node_id, node_type, status, output_json, started_at, finished_at)
         VALUES (?, ?, ?, 'action-http', ?, ?, ?, ?)`
      ).run(
        uuidv4(), id, step.nodeId, step.status || 'succeeded',
        JSON.stringify(step.output || {}), iso(created), iso(created + 100)
      )
    }
    return id
  }

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'query@example.com', password: 'password123', displayName: 'Q' })
    jwt = res.body.token
    userId = db.prepare('SELECT id FROM users WHERE email = ?').get('query@example.com').id
    const workspaceId = (
      await request(app).get('/api/workspaces').set('Authorization', `Bearer ${jwt}`)
    ).body.workspaces[0].id

    workflowId = uuidv4()
    db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by)
       VALUES (?, ?, 'Orders', '{"nodes":[],"edges":[]}', 'deployed', ?)`
    ).run(workflowId, workspaceId, userId)

    readToken = (
      await request(app).post('/api/tokens').set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'reader', scopes: ['read'] })
    ).body.token
    triggerToken = (
      await request(app).post('/api/tokens').set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'runner', scopes: ['trigger'] })
    ).body.token
  })

  const query = (body, id = workflowId, token = readToken) =>
    request(app)
      .post(`/api/v1/workflows/${id}/query`)
      .set('Authorization', `Bearer ${token}`)
      .send(body)

  it('answers a question about run history', async () => {
    const failed = seedRun({
      status: 'failed', offset: 1000,
      steps: [{ nodeId: 'charge', status: 'failed', output: { status: 503 } }],
    })
    seedRun({
      status: 'failed', offset: 2000,
      steps: [{ nodeId: 'charge', output: { status: 200 } }],
    })

    const res = await query({ where: 'status == "failed" and steps.charge.output.status >= 500' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.runs.map((r) => r.id)).toEqual([failed])
  })

  it('explains its own plan, so a slow query says why', async () => {
    const res = await query({ where: 'status == "failed" and steps.charge.output.status >= 500' })
    expect(res.body.plan.pushedDown).toEqual(['status == "failed"'])
    expect(res.body.plan.loadedSteps).toBe(true)
    expect(res.body.plan.scanned).toBeGreaterThan(0)
  })

  it('reads the trigger payload', async () => {
    const big = seedRun({ status: 'trig', offset: 3000, trigger: { order: { total: 4000 } } })
    seedRun({ status: 'trig', offset: 4000, trigger: { order: { total: 5 } } })
    const res = await query({ where: 'status == "trig" and trigger.order.total > 1000' })
    expect(res.body.runs.map((r) => r.id)).toEqual([big])
  })

  it('returns computed fields the caller did not have to derive', async () => {
    seedRun({ status: 'shape', offset: 5000, durationMs: 4321 })
    const res = await query({ where: 'status == "shape"' })
    expect(res.body.runs[0]).toMatchObject({ status: 'shape', durationMs: 4321, waitMs: 0 })
  })

  it('respects a limit', async () => {
    for (let i = 0; i < 4; i += 1) seedRun({ status: 'many', offset: 6000 + i })
    const res = await query({ where: 'status == "many"', limit: 2 })
    expect(res.body.runs).toHaveLength(2)
  })

  it('rejects a predicate that does not parse, with the position', async () => {
    const res = await query({ where: 'status ==' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBeTruthy()
    expect(res.body).toHaveProperty('position')
  })

  it('requires a predicate rather than returning every run', async () => {
    expect((await query({})).status).toBe(400)
    expect((await query({ where: '   ' })).status).toBe(400)
  })

  it('refuses a predicate too long to be a predicate', async () => {
    expect((await query({ where: `status == "${'x'.repeat(4100)}"` })).status).toBe(400)
  })

  it('refuses a token without the read scope', async () => {
    expect((await query({ where: 'status == "failed"' }, workflowId, triggerToken)).status).toBe(403)
  })

  it('404s for an unknown workflow', async () => {
    expect((await query({ where: 'status == "failed"' }, uuidv4())).status).toBe(404)
  })

  it('404s for a workflow the caller is not a member of', async () => {
    const other = await request(app)
      .post('/api/auth/register')
      .send({ email: 'outsider-q@example.com', password: 'password123', displayName: 'Out' })
    const outsiderToken = (
      await request(app).post('/api/tokens').set('Authorization', `Bearer ${other.body.token}`)
        .send({ name: 'r', scopes: ['read'] })
    ).body.token
    expect((await query({ where: 'status == "failed"' }, workflowId, outsiderToken)).status).toBe(404)
  })
})
