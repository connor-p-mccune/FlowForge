// Approval node: the cooperative wait (approve / reject / timeout / cancel),
// branch routing through the approved/rejected handles, and the request-side
// notifications. The respond API route has its own suite (approvals.test.js).

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'
process.env.EXEC_RETRY_BASE_MS = '1'
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

// Trigger → approval → (approved → logYes, rejected → logNo)
function approvalGraph(approvalConfig = {}) {
  return {
    nodes: [
      node('t1', 'trigger-manual'),
      node('gate', 'approval', approvalConfig),
      node('logYes', 'output-log', { message: 'approved path' }),
      node('logNo', 'output-log', { message: 'rejected path' }),
    ],
    edges: [
      { id: 't1-gate', source: 't1', target: 'gate' },
      { id: 'gate-yes', source: 'gate', target: 'logYes', sourceHandle: 'true' },
      { id: 'gate-no', source: 'gate', target: 'logNo', sourceHandle: 'false' },
    ],
  }
}

const getExecution = (id) => db.prepare('SELECT * FROM executions WHERE id = ?').get(id)
const getSteps = (id) =>
  Object.fromEntries(
    db.prepare('SELECT node_id, status FROM execution_steps WHERE execution_id = ?')
      .all(id)
      .map((s) => [s.node_id, s.status])
  )
const getApproval = (executionId) =>
  db.prepare('SELECT * FROM execution_approvals WHERE execution_id = ?').get(executionId)

// The runner inserts its row asynchronously once the node launches — poll for it.
async function waitForApproval(executionId, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const row = getApproval(executionId)
    if (row) return row
    if (Date.now() > deadline) throw new Error('approval row never appeared')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('approval node', () => {
  let token
  let userId
  let workspaceId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'approver@example.com', password: 'password123', displayName: 'Approver' })
    token = res.body.token
    userId = res.body.user.id
    const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`)
    workspaceId = ws.body.workspaces[0].id
  })

  async function createWorkflow(graph) {
    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/workflows`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: `Gated ${uuidv4().slice(0, 8)}` })
    const workflow = res.body.workflow
    await request(app)
      .put(`/api/workflows/${workflow.id}/graph`)
      .set('Authorization', `Bearer ${token}`)
      .send(graph)
    return workflow
  }

  async function startRun(workflowId) {
    const res = await request(app)
      .post(`/api/workflows/${workflowId}/execute`)
      .set('Authorization', `Bearer ${token}`)
    return res.body.execution
  }

  function respond(approvalId, status) {
    db.prepare(
      "UPDATE execution_approvals SET status = ?, responded_at = ?, responded_by = ? WHERE id = ? AND status = 'pending'"
    ).run(status, new Date().toISOString(), userId, approvalId)
  }

  it('runs the approved branch and skips the rejected one', async () => {
    const workflow = await createWorkflow(approvalGraph())
    const execution = await startRun(workflow.id)

    const events = []
    const run = runExecution(execution.id, { publish: (p) => events.push(p) })
    const approval = await waitForApproval(execution.id)
    expect(approval.status).toBe('pending')
    expect(approval.node_id).toBe('gate')
    respond(approval.id, 'approved')
    await run

    expect(getExecution(execution.id).status).toBe('completed')
    const steps = getSteps(execution.id)
    expect(steps.logYes).toBe('succeeded')
    expect(steps.logNo).toBe('skipped')

    // The canvas learns about the wait over the exec-update channel.
    const approvalEvent = events.find((e) => e.kind === 'approval')
    expect(approvalEvent).toMatchObject({
      executionId: execution.id,
      nodeId: 'gate',
      approvalId: approval.id,
      status: 'pending',
    })

    // The gate's output records who decided.
    const gateStep = db
      .prepare('SELECT output_json FROM execution_steps WHERE execution_id = ? AND node_id = ?')
      .get(execution.id, 'gate')
    expect(JSON.parse(gateStep.output_json)).toMatchObject({
      result: true,
      outcome: 'approved',
      respondedBy: 'Approver',
    })
  })

  it('runs the rejected branch on rejection', async () => {
    const workflow = await createWorkflow(approvalGraph())
    const execution = await startRun(workflow.id)

    const run = runExecution(execution.id, { publish: () => {} })
    const approval = await waitForApproval(execution.id)
    respond(approval.id, 'rejected')
    await run

    expect(getExecution(execution.id).status).toBe('completed')
    const steps = getSteps(execution.id)
    expect(steps.logYes).toBe('skipped')
    expect(steps.logNo).toBe('succeeded')
  })

  it('times out down the rejected branch by default', async () => {
    // 0.001 minutes = 60ms — expires before anyone responds.
    const workflow = await createWorkflow(approvalGraph({ timeoutMinutes: 0.001 }))
    const execution = await startRun(workflow.id)

    await runExecution(execution.id, { publish: () => {} })

    expect(getExecution(execution.id).status).toBe('completed')
    const steps = getSteps(execution.id)
    expect(steps.logYes).toBe('skipped')
    expect(steps.logNo).toBe('succeeded')
    expect(getApproval(execution.id).status).toBe('timed-out')
  })

  it('fails the run on timeout when onTimeout is fail', async () => {
    const workflow = await createWorkflow(
      approvalGraph({ timeoutMinutes: 0.001, onTimeout: 'fail' })
    )
    const execution = await startRun(workflow.id)

    await runExecution(execution.id, { publish: () => {} })

    const final = getExecution(execution.id)
    expect(final.status).toBe('failed')
    expect(getApproval(execution.id).status).toBe('timed-out')
  })

  it('settles the wait when the run is cancelled', async () => {
    const workflow = await createWorkflow(approvalGraph())
    const execution = await startRun(workflow.id)

    const run = runExecution(execution.id, { publish: () => {} })
    await waitForApproval(execution.id)
    db.prepare('UPDATE executions SET cancel_requested = 1 WHERE id = ?').run(execution.id)
    await run

    expect(getExecution(execution.id).status).toBe('cancelled')
    expect(getApproval(execution.id).status).toBe('cancelled')
    expect(getSteps(execution.id).logYes).toBe('skipped')
  })

  it('auto-approves in dry runs without filing a request', async () => {
    const workflow = await createWorkflow(approvalGraph())
    const res = await request(app)
      .post(`/api/workflows/${workflow.id}/test`)
      .set('Authorization', `Bearer ${token}`)
    const execution = res.body.execution

    await runExecution(execution.id, { publish: () => {}, dryRun: true })

    expect(getExecution(execution.id).status).toBe('completed')
    expect(getApproval(execution.id)).toBeUndefined()
    const steps = getSteps(execution.id)
    expect(steps.logYes).toBe('succeeded')
    expect(steps.logNo).toBe('skipped')
  })

  it('notifies workspace members when an approval is requested', async () => {
    const workflow = await createWorkflow(approvalGraph())
    const execution = await startRun(workflow.id)

    const run = runExecution(execution.id, { publish: () => {} })
    const approval = await waitForApproval(execution.id)

    const notifications = db
      .prepare("SELECT * FROM notifications WHERE user_id = ? AND type = 'approval-requested'")
      .all(userId)
    expect(notifications.length).toBeGreaterThan(0)
    expect(notifications.at(-1).link).toContain(`/workflow/${workflow.id}?execution=${execution.id}`)

    respond(approval.id, 'approved')
    await run
  })
})
