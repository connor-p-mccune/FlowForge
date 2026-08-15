// The rollback surface: the run detail carrying its compensations, the manual
// rollback endpoint (session + public API), and the run-settings policy.
//
// The endpoint's job is not to run compensations — the engine does that, and
// compensation.test.js pins the semantics. Its job is to refuse the three
// requests that would be dangerous: rolling back a run that is still going,
// rolling back a successful one, and repeating a compensation that already
// took.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'
process.env.EXEC_RETRY_BASE_MS = '1'

jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: jest.fn() }) }))
jest.mock('../config/redis', () => ({ publish: jest.fn().mockResolvedValue(1) }))

const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')
const { runExecution } = require('../services/executionEngine')

const node = (id, type, config = {}) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label: id, config },
})
const edge = (source, target) => ({ id: `${source}-${target}`, source, target })

const failingHttp = (id, extra = {}) =>
  node(id, 'action-http', { method: 'GET', url: 'http://127.0.0.1:1/', headers: '{}', ...extra })

describe('rollback API', () => {
  let jwt
  let workspaceId
  let workflowId
  let apiToken

  const authed = (req) => req.set('Authorization', `Bearer ${jwt}`)
  const asToken = (req) => req.set('Authorization', `Bearer ${apiToken}`)

  const graph = {
    nodes: [
      node('t1', 'trigger-manual'),
      node('charge', 'output-log', { message: 'charged' }),
      failingHttp('ship'),
      node('refund', 'output-log', { compensates: 'charge', message: 'refunded' }),
    ],
    edges: [edge('t1', 'charge'), edge('charge', 'ship')],
  }

  // Start a run of the seeded workflow and drive it through the engine directly,
  // so the test doesn't depend on the Bull worker.
  async function runOnce() {
    const execId = uuidv4()
    db.prepare(
      'INSERT INTO executions (id, workflow_id, status, trigger_type, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(execId, workflowId, 'pending', 'manual', new Date().toISOString())
    await runExecution(execId, { publish: () => {} })
    return execId
  }

  beforeAll(async () => {
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ email: 'rollback@example.com', password: 'password123', displayName: 'Roller' })
    jwt = reg.body.token
    const ws = await authed(request(app).get('/api/workspaces'))
    workspaceId = ws.body.workspaces[0].id
    const wf = await authed(request(app).post(`/api/workspaces/${workspaceId}/workflows`))
      .send({ name: 'Saga' })
    workflowId = wf.body.workflow.id
    await authed(request(app).put(`/api/workflows/${workflowId}/graph`)).send(graph)
    const minted = await authed(request(app).post('/api/tokens'))
      .send({ name: 'rollback-suite', scopes: ['trigger', 'read'] })
    apiToken = minted.body.token
  })

  it('reports the rollback and its compensations on the run detail', async () => {
    const execId = await runOnce()
    const res = await authed(request(app).get(`/api/executions/${execId}`))
    expect(res.status).toBe(200)
    expect(res.body.execution.rollback_status).toBe('completed')
    expect(res.body.compensations).toHaveLength(1)
    expect(res.body.compensations[0]).toMatchObject({
      node_id: 'refund',
      target_node_id: 'charge',
      status: 'succeeded',
      seq: 0,
    })
    // A compensation is not a step: it must not appear in the step list, which
    // the timeline, the critical path and per-type analytics all read.
    expect(res.body.steps.map((s) => s.node_id)).not.toContain('refund')
  })

  it('exposes the rollback status and compensations on the public API', async () => {
    const execId = await runOnce()
    const res = await asToken(request(app).get(`/api/v1/executions/${execId}`))
    expect(res.status).toBe(200)
    expect(res.body.execution.rollbackStatus).toBe('completed')
    expect(res.body.compensations[0]).toMatchObject({
      target_node_id: 'charge',
      status: 'succeeded',
    })
  })

  it('refuses to roll back a run with nothing outstanding', async () => {
    const execId = await runOnce()
    const res = await authed(request(app).post(`/api/executions/${execId}/rollback`))
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/nothing to roll back/i)
  })

  it('refuses to roll back a run that is not failed or cancelled', async () => {
    const execId = uuidv4()
    db.prepare(
      'INSERT INTO executions (id, workflow_id, status, created_at) VALUES (?, ?, ?, ?)'
    ).run(execId, workflowId, 'running', new Date().toISOString())
    const res = await authed(request(app).post(`/api/executions/${execId}/rollback`))
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/only a failed or cancelled run/i)
  })

  it('runs the outstanding compensation and audits it', async () => {
    // A workflow whose compensation is broken lands partial.
    const wf = await authed(request(app).post(`/api/workspaces/${workspaceId}/workflows`))
      .send({ name: 'Broken saga' })
    const brokenId = wf.body.workflow.id
    const broken = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('charge', 'output-log', { message: 'charged' }),
        failingHttp('ship'),
        failingHttp('refund', { compensates: 'charge' }),
      ],
      edges: [edge('t1', 'charge'), edge('charge', 'ship')],
    }
    await authed(request(app).put(`/api/workflows/${brokenId}/graph`)).send(broken)

    const execId = uuidv4()
    db.prepare(
      'INSERT INTO executions (id, workflow_id, status, created_at) VALUES (?, ?, ?, ?)'
    ).run(execId, brokenId, 'pending', new Date().toISOString())
    await runExecution(execId, { publish: () => {} })
    expect(
      db.prepare('SELECT rollback_status FROM executions WHERE id = ?').get(execId).rollback_status
    ).toBe('partial')

    // Repair the compensation, then retry the rollback through the API.
    const fixed = {
      ...broken,
      nodes: broken.nodes.map((n) =>
        n.id === 'refund'
          ? node('refund', 'output-log', { compensates: 'charge', message: 'refunded' })
          : n
      ),
    }
    await authed(request(app).put(`/api/workflows/${brokenId}/graph`)).send(fixed)

    const res = await authed(request(app).post(`/api/executions/${execId}/rollback`))
    expect(res.status).toBe(200)
    expect(res.body.outcome).toBe('completed')

    const audit = db.prepare(
      "SELECT * FROM audit_log WHERE workspace_id = ? AND action = 'execution.rolled_back'"
    ).all(workspaceId)
    expect(audit).toHaveLength(1)
    expect(JSON.parse(audit[0].metadata).outcome).toBe('completed')
  })

  it('accepts a rollback policy on the workflow and refuses an unknown one', async () => {
    const ok = await authed(request(app).put(`/api/workflows/${workflowId}`))
      .send({ name: 'Saga', rollback_policy: 'failure-or-cancel' })
    expect(ok.status).toBe(200)
    expect(ok.body.workflow.rollback_policy).toBe('failure-or-cancel')

    const bad = await authed(request(app).put(`/api/workflows/${workflowId}`))
      .send({ name: 'Saga', rollback_policy: 'sometimes' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/rollback_policy/)

    // Restore, and confirm an untouched update leaves the policy alone.
    await authed(request(app).put(`/api/workflows/${workflowId}`))
      .send({ name: 'Saga', rollback_policy: 'failure' })
    const untouched = await authed(request(app).put(`/api/workflows/${workflowId}`))
      .send({ name: 'Saga renamed' })
    expect(untouched.body.workflow.rollback_policy).toBe('failure')
  })

  it('accepts a crash-recovery policy and refuses an unknown one', async () => {
    // The sibling of rollback_policy: rollback decides what to undo when a run
    // ends badly, recovery decides what to do when the worker running it stops
    // existing. Both are per-workflow judgement calls rather than platform
    // settings, so both are validated at the door.
    const ok = await authed(request(app).put(`/api/workflows/${workflowId}`))
      .send({ name: 'Saga', recovery_policy: 'manual' })
    expect(ok.status).toBe(200)
    expect(ok.body.workflow.recovery_policy).toBe('manual')

    const bad = await authed(request(app).put(`/api/workflows/${workflowId}`))
      .send({ name: 'Saga', recovery_policy: 'whenever' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/recovery_policy/)

    const untouched = await authed(request(app).put(`/api/workflows/${workflowId}`))
      .send({ name: 'Saga' })
    expect(untouched.body.workflow.recovery_policy).toBe('manual')

    await authed(request(app).put(`/api/workflows/${workflowId}`))
      .send({ name: 'Saga', recovery_policy: 'safe' })
  })

  it('surfaces a disabled rollback in the Issues panel', async () => {
    await authed(request(app).put(`/api/workflows/${workflowId}`))
      .send({ name: 'Saga renamed', rollback_policy: 'off' })
    const res = await authed(request(app).post(`/api/workflows/${workflowId}/lint`)).send({})
    expect(res.body.issues.map((i) => i.code)).toContain('rollback-disabled')
    await authed(request(app).put(`/api/workflows/${workflowId}`))
      .send({ name: 'Saga renamed', rollback_policy: 'failure' })
  })
})
