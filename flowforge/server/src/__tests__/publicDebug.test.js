// The debugger on the public API: `?breakAt=` on a trigger, and the two
// endpoints a script needs to walk the pauses.
//
// The scope split gets a test of its own, because it is the decision a reviewer
// would question: reading a pause is `read`, but *resuming* one is `trigger`.
// Resuming decides whether a real call happens and — with an override — with
// what, which is the same category of act as starting the run, so a read-only
// token must not be able to do it.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const request = require('supertest')

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))
jest.mock('../config/redis', () => ({ publish: jest.fn().mockResolvedValue(1) }))

const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')

const node = (id, type, config = {}, label = id) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label, config },
})

const GRAPH = {
  nodes: [
    node('t1', 'trigger-manual', {}, 'Start'),
    node('h1', 'action-http', { url: 'https://api.example.com/x' }, 'Charge card'),
  ],
  edges: [{ id: 'e1', source: 't1', target: 'h1' }],
}

let jwt
let triggerToken
let readToken
let workflowId

const bearer = (req, token) => req.set('Authorization', `Bearer ${token}`)

beforeAll(async () => {
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ email: `dbg-${uuidv4()}@example.com`, password: 'password123', displayName: 'D' })
  jwt = reg.body.token
  const ws = await bearer(request(app).get('/api/workspaces'), jwt)
  const wf = await bearer(
    request(app).post(`/api/workspaces/${ws.body.workspaces[0].id}/workflows`),
    jwt
  ).send({ name: 'Debuggable' })
  workflowId = wf.body.workflow.id
  await bearer(request(app).put(`/api/workflows/${workflowId}/graph`), jwt).send(GRAPH)

  triggerToken = (
    await bearer(request(app).post('/api/tokens'), jwt).send({
      name: 'ci',
      scopes: ['read', 'trigger'],
    })
  ).body.token
  readToken = (
    await bearer(request(app).post('/api/tokens'), jwt).send({ name: 'ro', scopes: ['read'] })
  ).body.token
})

const trigger = (query = '', token = triggerToken) =>
  bearer(request(app).post(`/api/v1/workflows/${workflowId}/trigger${query}`), token).send({})

describe('starting a debug run', () => {
  it('records the breakpoints on the run', async () => {
    const res = await trigger('?breakAt=h1')
    expect(res.status).toBe(202)
    const row = db.prepare('SELECT * FROM executions WHERE id = ?').get(res.body.execution.id)
    expect(JSON.parse(row.debug_json)).toEqual({ breakpoints: ['h1'], stepFromStart: false })
    // Something is waiting on each pause, so the run takes the high lane.
    expect(row.priority).toBe('high')
  })

  it('accepts breakAt=all for every node', async () => {
    const res = await trigger('?breakAt=all')
    const row = db.prepare('SELECT * FROM executions WHERE id = ?').get(res.body.execution.id)
    expect(JSON.parse(row.debug_json).stepFromStart).toBe(true)
  })

  it('refuses a node that is not in the graph rather than running unbroken', async () => {
    // Silently ignoring it would start a run that never pauses, and the caller
    // would wait for a trace that is never coming.
    const res = await trigger('?breakAt=ghost')
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/comma-separated list of node ids/)
  })

  it('leaves an ordinary trigger with no debug session at all', async () => {
    const res = await trigger('')
    const row = db.prepare('SELECT * FROM executions WHERE id = ?').get(res.body.execution.id)
    expect(row.debug_json).toBeNull()
  })
})

describe('walking the pauses', () => {
  let executionId
  let breakId

  beforeEach(() => {
    executionId = uuidv4()
    breakId = uuidv4()
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO executions (id, workflow_id, status, trigger_type, created_at) VALUES (?, ?, 'running', 'api', ?)"
    ).run(executionId, workflowId, now)
    db.prepare(
      `INSERT INTO execution_breaks (id, execution_id, node_id, node_label, status, input_json, config_json, created_at)
       VALUES (?, ?, 'h1', 'Charge card', 'paused', ?, ?, ?)`
    ).run(
      breakId, executionId,
      JSON.stringify({ orderId: 'ord-42' }),
      JSON.stringify({ url: 'https://api.example.com/ord-42' }),
      now
    )
  })

  it('reports the resolved config and input', async () => {
    const res = await bearer(
      request(app).get(`/api/v1/executions/${executionId}/breaks`),
      readToken
    )
    expect(res.status).toBe(200)
    expect(res.body.breaks[0]).toMatchObject({
      nodeId: 'h1',
      nodeLabel: 'Charge card',
      status: 'paused',
      config: { url: 'https://api.example.com/ord-42' },
      input: { orderId: 'ord-42' },
    })
  })

  it('resumes with a trigger token', async () => {
    const res = await bearer(
      request(app).post(`/api/v1/executions/${executionId}/breaks/${breakId}/resume`),
      triggerToken
    ).send({ action: 'continue' })
    expect(res.status).toBe(202)
    expect(
      db.prepare('SELECT status FROM execution_breaks WHERE id = ?').get(breakId).status
    ).toBe('resumed')
  })

  it('refuses to resume with a read-only token', async () => {
    // Resuming decides whether a real call happens and with what — the same
    // category of act as starting the run.
    const res = await bearer(
      request(app).post(`/api/v1/executions/${executionId}/breaks/${breakId}/resume`),
      readToken
    ).send({ action: 'continue' })
    expect(res.status).toBe(403)
  })

  it('409s a second resume rather than pretending it worked', async () => {
    await bearer(
      request(app).post(`/api/v1/executions/${executionId}/breaks/${breakId}/resume`),
      triggerToken
    ).send({})
    const second = await bearer(
      request(app).post(`/api/v1/executions/${executionId}/breaks/${breakId}/resume`),
      triggerToken
    ).send({})
    expect(second.status).toBe(409)
    expect(second.body.error).toMatch(/already resumed/)
  })

  it('rejects an unknown action', async () => {
    const res = await bearer(
      request(app).post(`/api/v1/executions/${executionId}/breaks/${breakId}/resume`),
      triggerToken
    ).send({ action: 'explode' })
    expect(res.status).toBe(400)
  })

  it('404s a break id from another run', async () => {
    const other = uuidv4()
    db.prepare(
      "INSERT INTO executions (id, workflow_id, status, trigger_type, created_at) VALUES (?, ?, 'running', 'api', ?)"
    ).run(other, workflowId, new Date().toISOString())
    const res = await bearer(
      request(app).post(`/api/v1/executions/${other}/breaks/${breakId}/resume`),
      triggerToken
    ).send({})
    expect(res.status).toBe(404)
    // …and it stayed paused, rather than being resumed and then rejected.
    expect(
      db.prepare('SELECT status FROM execution_breaks WHERE id = ?').get(breakId).status
    ).toBe('paused')
  })

  it('404s an execution the token’s owner cannot see', async () => {
    const outsider = await request(app)
      .post('/api/auth/register')
      .send({ email: `out-${uuidv4()}@example.com`, password: 'password123', displayName: 'O' })
    const token = (
      await bearer(request(app).post('/api/tokens'), outsider.body.token).send({
        name: 't',
        scopes: ['read', 'trigger'],
      })
    ).body.token
    const res = await bearer(request(app).get(`/api/v1/executions/${executionId}/breaks`), token)
    expect(res.status).toBe(404)
  })
})
