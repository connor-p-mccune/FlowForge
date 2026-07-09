// Run cancellation: the cancel route's pending/running/terminal handling, and
// the engine's cooperative wind-down when cancel_requested flips mid-run.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'
process.env.EXEC_RETRY_BASE_MS = '1'

// Avoid touching Redis — capture what would have been enqueued instead.
const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))
// The pending-cancel path publishes the terminal event itself; keep that off
// the network too.
const mockPublish = jest.fn().mockResolvedValue(1)
jest.mock('../config/redis', () => ({ publish: (...a) => mockPublish(...a) }))

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

// Trigger, then three chained 80ms delays — slow enough to cancel in flight.
const slowGraph = {
  nodes: [
    node('t1', 'trigger-manual'),
    node('d1', 'action-delay', { durationMs: 80 }),
    node('d2', 'action-delay', { durationMs: 80 }),
    node('d3', 'action-delay', { durationMs: 80 }),
  ],
  edges: [edge('t1', 'd1'), edge('d1', 'd2'), edge('d2', 'd3')],
}

function getExecution(id) {
  return db.prepare('SELECT * FROM executions WHERE id = ?').get(id)
}

function getSteps(id) {
  return db.prepare('SELECT * FROM execution_steps WHERE execution_id = ? ORDER BY rowid').all(id)
}

describe('execution cancellation', () => {
  let token
  let workspaceId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'cancel-user@example.com', password: 'password123', displayName: 'Canceller' })
    token = res.body.token
    const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`)
    workspaceId = ws.body.workspaces[0].id
  })

  async function createWorkflow(graph = slowGraph) {
    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/workflows`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: `Cancellable ${uuidv4().slice(0, 8)}` })
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

  it('cancels a queued run immediately and the worker then skips it', async () => {
    const workflow = await createWorkflow()
    const execution = await startRun(workflow.id) // enqueue is mocked — stays pending

    const res = await request(app)
      .post(`/api/executions/${execution.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(202)
    expect(res.body.execution.status).toBe('cancelled')
    expect(getExecution(execution.id).finished_at).toBeTruthy()

    // The worker later picks the job up: the engine must not resurrect the run.
    await runExecution(execution.id, { publish: () => {} })
    expect(getExecution(execution.id).status).toBe('cancelled')
    expect(getSteps(execution.id)).toHaveLength(0)
  })

  it('winds a running execution down at the next scheduling round', async () => {
    const workflow = await createWorkflow()
    const execution = await startRun(workflow.id)

    const events = []
    const run = runExecution(execution.id, { publish: (p) => events.push(p) })
    // Let the run get going (t1 + d1 launch), then request cancellation the way
    // the route does — by flipping the flag on the row.
    await new Promise((r) => setTimeout(r, 30))
    db.prepare('UPDATE executions SET cancel_requested = 1 WHERE id = ?').run(execution.id)
    await run

    const final = getExecution(execution.id)
    expect(final.status).toBe('cancelled')
    expect(final.finished_at).toBeTruthy()

    const steps = Object.fromEntries(getSteps(execution.id).map((s) => [s.node_id, s.status]))
    // The node in flight when the flag flipped ran to completion…
    expect(steps.d1).toBe('succeeded')
    // …and nothing new launched after it settled.
    expect(steps.d3).toBe('skipped')
    expect(events.some((e) => e.kind === 'execution' && e.status === 'cancelled')).toBe(true)
  })

  it('409s when the run has already finished', async () => {
    const workflow = await createWorkflow({
      nodes: [node('t1', 'trigger-manual')],
      edges: [],
    })
    const execution = await startRun(workflow.id)
    await runExecution(execution.id, { publish: () => {} })
    expect(getExecution(execution.id).status).toBe('completed')

    const res = await request(app)
      .post(`/api/executions/${execution.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/already completed/)
  })

  it('cancels via the public API with a trigger-scoped token', async () => {
    const minted = await request(app)
      .post('/api/tokens')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'cancel-test', scopes: ['trigger'] })
    const pat = minted.body.token

    const workflow = await createWorkflow()
    const execution = await startRun(workflow.id) // stays pending (queue mocked)

    const res = await request(app)
      .post(`/api/v1/executions/${execution.id}/cancel`)
      .set('Authorization', `Bearer ${pat}`)
    expect(res.status).toBe(202)
    expect(res.body.execution.status).toBe('cancelled')
    expect(getExecution(execution.id).status).toBe('cancelled')
  })

  it('404s for non-members and unknown executions', async () => {
    const other = await request(app)
      .post('/api/auth/register')
      .send({ email: 'cancel-outsider@example.com', password: 'password123', displayName: 'Outsider' })

    const workflow = await createWorkflow()
    const execution = await startRun(workflow.id)

    const foreign = await request(app)
      .post(`/api/executions/${execution.id}/cancel`)
      .set('Authorization', `Bearer ${other.body.token}`)
    expect(foreign.status).toBe(404)

    const unknown = await request(app)
      .post(`/api/executions/${uuidv4()}/cancel`)
      .set('Authorization', `Bearer ${token}`)
    expect(unknown.status).toBe(404)
  })
})
