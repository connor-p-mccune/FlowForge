// The run explanation over both surfaces.
//
// Read-only over rows the engine already wrote, so `read` is the whole
// authorisation story — and the membership check goes through the run's
// *workflow*, so a stranger gets the same 404 a missing id does.

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

const n = (id, type, config = {}, label = id) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label, config },
})
const e = (source, target, sourceHandle) => ({
  id: `e-${source}-${target}${sourceHandle || ''}`,
  source,
  target,
  ...(sourceHandle ? { sourceHandle } : {}),
})

const GRAPH = {
  nodes: [
    n('t', 'trigger-webhook', {}, 'Start'),
    n('risky', 'condition', { operator: 'expression', expression: 'total > 100' }, 'High risk?'),
    n('charge', 'action-http', { method: 'POST', url: 'https://x/y' }, 'Charge card'),
    n('mail', 'action-email', {}, 'Send receipt'),
    n('log', 'output-log', {}, 'Log it'),
  ],
  edges: [e('t', 'risky'), e('risky', 'charge', 'false'), e('charge', 'mail'), e('risky', 'log', 'true')],
}

describe('run explanation endpoints', () => {
  let jwt
  let readToken
  let userId
  let workspaceId
  let executionId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'explain@example.com', password: 'password123', displayName: 'Ex' })
    jwt = res.body.token
    userId = db.prepare('SELECT id FROM users WHERE email = ?').get('explain@example.com').id
    workspaceId = (
      await request(app).get('/api/workspaces').set('Authorization', `Bearer ${jwt}`)
    ).body.workspaces[0].id

    const workflowId = uuidv4()
    db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by)
       VALUES (?, ?, 'Orders', ?, 'deployed', ?)`
    ).run(workflowId, workspaceId, JSON.stringify(GRAPH), userId)

    executionId = uuidv4()
    db.prepare(
      "INSERT INTO executions (id, workflow_id, status, created_at) VALUES (?, ?, 'completed', ?)"
    ).run(executionId, workflowId, new Date().toISOString())

    const step = db.prepare(
      `INSERT INTO execution_steps (id, execution_id, node_id, node_type, status, input_json, output_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    step.run(uuidv4(), executionId, 't', 'trigger-webhook', 'succeeded', null, JSON.stringify({ total: 850 }))
    step.run(
      uuidv4(),
      executionId,
      'risky',
      'condition',
      'succeeded',
      JSON.stringify({ total: 850 }),
      JSON.stringify({ result: true })
    )
    step.run(uuidv4(), executionId, 'log', 'output-log', 'succeeded', null, null)
    step.run(uuidv4(), executionId, 'charge', 'action-http', 'skipped', null, null)
    step.run(uuidv4(), executionId, 'mail', 'action-email', 'skipped', null, null)

    readToken = (
      await request(app)
        .post('/api/tokens')
        .set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'reader', scopes: ['read'] })
    ).body.token
  })

  describe('GET /api/v1/executions/:id/explain', () => {
    const get = (id = executionId, token = readToken) =>
      request(app).get(`/api/v1/executions/${id}/explain`).set('Authorization', `Bearer ${token}`)

    it('answers why the email did not send', async () => {
      const res = await get()
      expect(res.status).toBe(200)
      const mail = res.body.steps.find((s) => s.nodeId === 'mail')
      expect(mail.status).toBe('skipped')
      expect(mail.because).toMatchObject({ label: 'High risk?', outcome: 'true' })
      expect(mail.because.reads).toEqual([{ path: 'total', value: '850' }])
    })

    it('reports what each decision closed off', async () => {
      const decision = (await get()).body.decisions[0]
      expect(decision).toMatchObject({ label: 'High risk?', outcome: 'true', closed: ['false'] })
    })

    it('attributes every skipped step it reports', async () => {
      expect((await get()).body.summary).toMatchObject({ skipped: 2, unexplained: 0 })
    })

    it('refuses a token with no read scope', async () => {
      const writeOnly = (
        await request(app)
          .post('/api/tokens')
          .set('Authorization', `Bearer ${jwt}`)
          .send({ name: 'runner', scopes: ['trigger'] })
      ).body.token
      expect((await get(executionId, writeOnly)).status).toBe(403)
    })

    it('404s a run the token cannot see', async () => {
      expect((await get(uuidv4())).status).toBe(404)
    })
  })

  describe('GET /api/executions/:id/explain', () => {
    it('answers the same question for the run panel', async () => {
      const session = await request(app)
        .get(`/api/executions/${executionId}/explain`)
        .set('Authorization', `Bearer ${jwt}`)
      const token = await request(app)
        .get(`/api/v1/executions/${executionId}/explain`)
        .set('Authorization', `Bearer ${readToken}`)
      expect(session.status).toBe(200)
      expect(session.body.steps).toEqual(token.body.steps)
    })

    it('gives a stranger the same 404 a missing id does', async () => {
      // The membership check goes through the run's workflow, so the endpoint
      // never confirms an execution id to somebody who cannot see it.
      const outsider = (
        await request(app)
          .post('/api/auth/register')
          .send({ email: 'outsider-e@example.com', password: 'password123', displayName: 'Out' })
      ).body.token
      const real = await request(app)
        .get(`/api/executions/${executionId}/explain`)
        .set('Authorization', `Bearer ${outsider}`)
      const missing = await request(app)
        .get(`/api/executions/${uuidv4()}/explain`)
        .set('Authorization', `Bearer ${outsider}`)
      expect(real.status).toBe(404)
      expect(real.body).toEqual(missing.body)
    })

    it('needs a session', async () => {
      expect((await request(app).get(`/api/executions/${executionId}/explain`)).status).toBe(401)
    })
  })
})
