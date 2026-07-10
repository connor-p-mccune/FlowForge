// Approvals over the public API: the token-scoped inbox, settling a gate with
// the dedicated `approve` scope, and the scope boundary itself — a
// trigger-scoped token must not be able to wave runs through their own gates.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'
process.env.APPROVAL_POLL_MS = '20'

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))
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

const gatedGraph = {
  nodes: [
    node('t1', 'trigger-manual'),
    node('gate', 'approval', { message: 'Ship it?' }),
    node('done', 'output-log', { message: 'shipped' }),
  ],
  edges: [
    { id: 't1-gate', source: 't1', target: 'gate' },
    { id: 'gate-done', source: 'gate', target: 'done', sourceHandle: 'true' },
  ],
}

async function waitForApproval(executionId, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const row = db
      .prepare('SELECT * FROM execution_approvals WHERE execution_id = ?')
      .get(executionId)
    if (row) return row
    if (Date.now() > deadline) throw new Error('approval row never appeared')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('public API approvals', () => {
  let session
  let fullToken // trigger + read + approve
  let triggerOnlyToken
  let workflowId

  beforeAll(async () => {
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ email: 'pub-approve@example.com', password: 'password123', displayName: 'PubApprover' })
    session = reg.body.token
    const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${session}`)
    const workspaceId = ws.body.workspaces[0].id

    const created = await request(app)
      .post(`/api/workspaces/${workspaceId}/workflows`)
      .set('Authorization', `Bearer ${session}`)
      .send({ name: 'Gated release' })
    workflowId = created.body.workflow.id
    await request(app)
      .put(`/api/workflows/${workflowId}/graph`)
      .set('Authorization', `Bearer ${session}`)
      .send(gatedGraph)

    const full = await request(app)
      .post('/api/tokens')
      .set('Authorization', `Bearer ${session}`)
      .send({ name: 'full', scopes: ['trigger', 'read', 'approve'] })
    fullToken = full.body.token
    const limited = await request(app)
      .post('/api/tokens')
      .set('Authorization', `Bearer ${session}`)
      .send({ name: 'limited', scopes: ['trigger', 'read'] })
    triggerOnlyToken = limited.body.token
  })

  async function startGatedRun() {
    const res = await request(app)
      .post(`/api/workflows/${workflowId}/execute`)
      .set('Authorization', `Bearer ${session}`)
    const execution = res.body.execution
    const run = runExecution(execution.id, { publish: () => {} })
    const approval = await waitForApproval(execution.id)
    return { execution, approval, run }
  }

  it('lists the pending inbox and approves a run end-to-end', async () => {
    const { execution, approval, run } = await startGatedRun()

    const inbox = await request(app)
      .get('/api/v1/approvals')
      .set('Authorization', `Bearer ${fullToken}`)
    expect(inbox.status).toBe(200)
    const mine = inbox.body.approvals.find((a) => a.id === approval.id)
    expect(mine).toMatchObject({
      executionId: execution.id,
      workflowName: 'Gated release',
      status: 'pending',
      message: 'Ship it?',
    })

    const res = await request(app)
      .post(`/api/v1/approvals/${approval.id}/respond`)
      .set('Authorization', `Bearer ${fullToken}`)
      .send({ decision: 'approve', note: 'ok from CI' })
    expect(res.status).toBe(200)
    expect(res.body.approval).toMatchObject({
      status: 'approved',
      respondedBy: 'PubApprover',
      note: 'ok from CI',
    })

    await run
    const final = db.prepare('SELECT status FROM executions WHERE id = ?').get(execution.id)
    expect(final.status).toBe('completed')
  })

  it('requires the approve scope to respond (403), and read to list', async () => {
    const { approval, run } = await startGatedRun()

    const denied = await request(app)
      .post(`/api/v1/approvals/${approval.id}/respond`)
      .set('Authorization', `Bearer ${triggerOnlyToken}`)
      .send({ decision: 'approve' })
    expect(denied.status).toBe(403)
    expect(denied.body.error).toMatch(/"approve" scope/)

    // trigger+read can still see the inbox…
    const inbox = await request(app)
      .get('/api/v1/approvals')
      .set('Authorization', `Bearer ${triggerOnlyToken}`)
    expect(inbox.status).toBe(200)

    // …and the gate is still pending until a properly-scoped token settles it.
    await request(app)
      .post(`/api/v1/approvals/${approval.id}/respond`)
      .set('Authorization', `Bearer ${fullToken}`)
      .send({ decision: 'reject' })
    await run
  })

  it('validates decisions, 404s unknown ids, and 409s double responses', async () => {
    const { approval, run } = await startGatedRun()

    const bad = await request(app)
      .post(`/api/v1/approvals/${approval.id}/respond`)
      .set('Authorization', `Bearer ${fullToken}`)
      .send({ decision: 'shrug' })
    expect(bad.status).toBe(400)

    const unknown = await request(app)
      .post(`/api/v1/approvals/${uuidv4()}/respond`)
      .set('Authorization', `Bearer ${fullToken}`)
      .send({ decision: 'approve' })
    expect(unknown.status).toBe(404)

    await request(app)
      .post(`/api/v1/approvals/${approval.id}/respond`)
      .set('Authorization', `Bearer ${fullToken}`)
      .send({ decision: 'approve' })
    const second = await request(app)
      .post(`/api/v1/approvals/${approval.id}/respond`)
      .set('Authorization', `Bearer ${fullToken}`)
      .send({ decision: 'reject' })
    expect(second.status).toBe(409)
    expect(second.body.error).toMatch(/already approved/)

    await run
  })
})
