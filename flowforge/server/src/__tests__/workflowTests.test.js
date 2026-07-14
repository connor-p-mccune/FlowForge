// Workflow test scenarios: CRUD, validation, and running a scenario/suite
// through the dry-run engine with FXL assertions over the run's output.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'
process.env.EXEC_RETRY_BASE_MS = '1'

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))

const jwt = require('jsonwebtoken')
const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')

let token, userId, wsId, wf

const NODE = (id, type, config = {}) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label: id, config },
})

// trigger → transform (computes { total, status }) → return.
function insertWorkflow() {
  const id = uuidv4()
  const graph = {
    nodes: [
      NODE('t', 'trigger-manual'),
      NODE('tf', 'transform', { template: '{"total": "{{t.amount}}", "status": "ok"}' }),
      NODE('ret', 'output-return'),
    ],
    edges: [
      { source: 't', target: 'tf' },
      { source: 'tf', target: 'ret' },
    ],
  }
  db.prepare(
    "INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by) VALUES (?, ?, ?, ?, 'deployed', ?)"
  ).run(id, wsId, 'Tested Flow', JSON.stringify(graph), userId)
  return id
}

const authed = (req) => req.set('Authorization', `Bearer ${token}`)

async function createScenario(body) {
  return authed(request(app).post(`/api/workflows/${wf}/tests`)).send(body)
}

beforeAll(async () => {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: 'tester@example.com', password: 'password123', displayName: 'Tester' })
  token = res.body.token
  userId = jwt.decode(token).id
  const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`)
  wsId = ws.body.workspaces[0].id
  wf = insertWorkflow()
})

describe('scenario CRUD', () => {
  it('requires authentication', async () => {
    const res = await request(app).get(`/api/workflows/${wf}/tests`)
    expect(res.status).toBe(401)
  })

  it('creates, lists, updates, and deletes a scenario', async () => {
    const created = await createScenario({
      name: 'happy path',
      input: { amount: 100 },
      assertions: [{ expression: 'output.status == "ok"', description: 'returns ok' }],
    })
    expect(created.status).toBe(201)
    const id = created.body.test.id
    expect(created.body.test.input).toEqual({ amount: 100 })
    expect(created.body.test.assertions).toHaveLength(1)

    const list = await authed(request(app).get(`/api/workflows/${wf}/tests`))
    expect(list.body.tests.map((t) => t.id)).toContain(id)

    const updated = await authed(request(app).put(`/api/workflows/${wf}/tests/${id}`)).send({
      name: 'renamed',
      input: { amount: 5 },
      assertions: [{ expression: 'output.total == 5' }],
    })
    expect(updated.status).toBe(200)
    expect(updated.body.test.name).toBe('renamed')
    expect(updated.body.test.input).toEqual({ amount: 5 })

    const del = await authed(request(app).delete(`/api/workflows/${wf}/tests/${id}`))
    expect(del.status).toBe(204)
    const after = await authed(request(app).get(`/api/workflows/${wf}/tests`))
    expect(after.body.tests.map((t) => t.id)).not.toContain(id)
  })

  it('rejects a missing name, no assertions, and an invalid FXL assertion', async () => {
    expect((await createScenario({ assertions: [{ expression: 'true' }] })).status).toBe(400)
    expect((await createScenario({ name: 'x', assertions: [] })).status).toBe(400)
    const bad = await createScenario({ name: 'x', assertions: [{ expression: 'amount >' }] })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/not valid FXL/)
  })

  it('404s for a workflow the user cannot see', async () => {
    const other = await request(app)
      .post('/api/auth/register')
      .send({ email: 'tester-out@example.com', password: 'password123', displayName: 'Out' })
    const res = await request(app)
      .get(`/api/workflows/${wf}/tests`)
      .set('Authorization', `Bearer ${other.body.token}`)
    expect(res.status).toBe(404)
  })
})

describe('running scenarios', () => {
  it('runs a scenario and passes when every assertion holds', async () => {
    const created = await createScenario({
      name: 'totals up',
      input: { amount: 100 },
      assertions: [
        { expression: 'status == "completed"' },
        { expression: 'output.status == "ok"' },
        { expression: 'output.total == 100' },
        { expression: 'steps["t"].amount == 100' },
      ],
    })
    const id = created.body.test.id
    const res = await authed(request(app).post(`/api/workflows/${wf}/tests/${id}/run`))
    expect(res.status).toBe(200)
    expect(res.body.result.passed).toBe(true)
    expect(res.body.result.runStatus).toBe('completed')
    expect(res.body.result.assertions.every((a) => a.passed)).toBe(true)
  })

  it('fails the scenario when an assertion does not hold, pinpointing which', async () => {
    const created = await createScenario({
      name: 'wrong expectation',
      input: { amount: 100 },
      assertions: [
        { expression: 'output.status == "ok"' },
        { expression: 'output.total == 999', description: 'this is wrong' },
      ],
    })
    const id = created.body.test.id
    const res = await authed(request(app).post(`/api/workflows/${wf}/tests/${id}/run`))
    expect(res.body.result.passed).toBe(false)
    const failing = res.body.result.assertions.filter((a) => !a.passed)
    expect(failing).toHaveLength(1)
    expect(failing[0].expression).toBe('output.total == 999')
  })

  it('records the scenario run as a dry-run, so it is excluded from insights', async () => {
    const created = await createScenario({
      name: 'dry-run check',
      input: { amount: 1 },
      assertions: [{ expression: 'status == "completed"' }],
    })
    const before = db.prepare("SELECT COUNT(*) n FROM executions WHERE workflow_id = ? AND trigger_type != 'dry-run'").get(wf).n
    await authed(request(app).post(`/api/workflows/${wf}/tests/${created.body.test.id}/run`))
    const nonDry = db.prepare("SELECT COUNT(*) n FROM executions WHERE workflow_id = ? AND trigger_type != 'dry-run'").get(wf).n
    expect(nonDry).toBe(before)
    // The run was recorded as a dry-run.
    expect(db.prepare("SELECT COUNT(*) n FROM executions WHERE workflow_id = ? AND trigger_type = 'dry-run'").get(wf).n).toBeGreaterThan(0)
  })

  it('runs the whole suite and rolls up ok/passed/failed', async () => {
    const fresh = insertWorkflow()
    const mk = (body) => authed(request(app).post(`/api/workflows/${fresh}/tests`)).send(body)
    await mk({ name: 'ok1', input: { amount: 2 }, assertions: [{ expression: 'output.total == 2' }] })
    await mk({ name: 'bad', input: { amount: 2 }, assertions: [{ expression: 'output.total == 3' }] })

    const res = await authed(request(app).post(`/api/workflows/${fresh}/tests/run`))
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(2)
    expect(res.body.passed).toBe(1)
    expect(res.body.failed).toBe(1)
    expect(res.body.ok).toBe(false)
  })

  it('reports ok:true only when every scenario passes', async () => {
    const fresh = insertWorkflow()
    await authed(request(app).post(`/api/workflows/${fresh}/tests`)).send({
      name: 'only', input: { amount: 7 }, assertions: [{ expression: 'output.total == 7' }],
    })
    const res = await authed(request(app).post(`/api/workflows/${fresh}/tests/run`))
    expect(res.body.ok).toBe(true)
    expect(res.body.total).toBe(1)
  })
})

describe('public API CI gate (POST /api/v1/workflows/:id/tests/run)', () => {
  async function mintApiToken(scopes) {
    const res = await authed(request(app).post('/api/tokens')).send({ name: 'ci', scopes })
    return res.body.token
  }

  it('runs the suite for a trigger-scoped token and gates on ok', async () => {
    const fresh = insertWorkflow()
    await authed(request(app).post(`/api/workflows/${fresh}/tests`)).send({
      name: 'passes', input: { amount: 9 }, assertions: [{ expression: 'output.total == 9' }],
    })
    await authed(request(app).post(`/api/workflows/${fresh}/tests`)).send({
      name: 'fails', input: { amount: 9 }, assertions: [{ expression: 'output.total == 0' }],
    })
    const apiToken = await mintApiToken(['trigger'])
    const res = await request(app)
      .post(`/api/v1/workflows/${fresh}/tests/run`)
      .set('Authorization', `Bearer ${apiToken}`)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(res.body.passed).toBe(1)
    expect(res.body.failed).toBe(1)
  })

  it('rejects a token without the trigger scope', async () => {
    const fresh = insertWorkflow()
    const apiToken = await mintApiToken(['read'])
    const res = await request(app)
      .post(`/api/v1/workflows/${fresh}/tests/run`)
      .set('Authorization', `Bearer ${apiToken}`)
    expect(res.status).toBe(403)
  })
})
