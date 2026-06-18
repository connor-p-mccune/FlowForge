const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

// Avoid touching Redis — capture what would have been enqueued instead.
const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))

const { app } = require('../index')
const { runExecution } = require('../services/executionEngine')

const oneNodeGraph = {
  nodes: [{ id: 't1', type: 'trigger-webhook', position: { x: 0, y: 0 }, data: { label: 'Hook' } }],
  edges: [],
}

describe('execution replay', () => {
  let token
  let userId
  let workspaceId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'replay-user@example.com', password: 'password123', displayName: 'Replayer' })
    token = res.body.token
    userId = res.body.user.id
    const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`)
    workspaceId = ws.body.workspaces[0].id
  })

  beforeEach(() => mockAdd.mockClear())

  async function createWorkflow(name, graph = oneNodeGraph) {
    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/workflows`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name })
    const workflow = res.body.workflow
    if (graph) {
      await request(app)
        .put(`/api/workflows/${workflow.id}/graph`)
        .set('Authorization', `Bearer ${token}`)
        .send(graph)
    }
    return workflow
  }

  async function fireWebhook(workflowId, body) {
    const create = await request(app)
      .post(`/api/workflows/${workflowId}/webhooks`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
    const fire = await request(app).post(`/api/webhooks/${create.body.webhook.webhook_key}`).send(body)
    return fire.body.executionId
  }

  it('persists the trigger body as trigger_data on a webhook execution', async () => {
    const workflow = await createWorkflow('Hooked')
    const executionId = await fireWebhook(workflow.id, { hello: 'world' })

    const exec = await request(app)
      .get(`/api/executions/${executionId}`)
      .set('Authorization', `Bearer ${token}`)
    expect(exec.body.execution.trigger_type).toBe('webhook')
    expect(JSON.parse(exec.body.execution.trigger_data)).toEqual({ hello: 'world' })
  })

  it('replays a webhook run: new execution, same trigger data, re-enqueued payload', async () => {
    const workflow = await createWorkflow('Replayable')
    const originalId = await fireWebhook(workflow.id, { order: 42, user: 'ada' })
    mockAdd.mockClear()

    const res = await request(app)
      .post(`/api/executions/${originalId}/replay`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(202)

    const replay = res.body.execution
    // The new execution is returned — not the original.
    expect(replay.id).not.toBe(originalId)
    expect(replay.workflow_id).toBe(workflow.id)
    expect(replay.status).toBe('pending')
    expect(replay.trigger_type).toBe('replay')
    // triggered_by is the user who clicked Replay (the FK stays valid).
    expect(replay.triggered_by).toBe(userId)
    // Same trigger payload as the original run.
    expect(JSON.parse(replay.trigger_data)).toEqual({ order: 42, user: 'ada' })

    // Re-enqueued with the original body as the payload, like a live webhook.
    expect(mockAdd).toHaveBeenCalledTimes(1)
    expect(mockAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: replay.id,
        workflowId: workflow.id,
        payload: { order: 42, user: 'ada' },
      })
    )
  })

  it('replays a manual run with an empty payload', async () => {
    const workflow = await createWorkflow('ManualReplay')
    const run = await request(app)
      .post(`/api/workflows/${workflow.id}/execute`)
      .set('Authorization', `Bearer ${token}`)
    const originalId = run.body.execution.id
    expect(run.body.execution.trigger_type).toBe('manual')
    mockAdd.mockClear()

    const res = await request(app)
      .post(`/api/executions/${originalId}/replay`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(202)
    expect(res.body.execution.trigger_type).toBe('replay')
    expect(res.body.execution.trigger_data).toBeNull()
    expect(mockAdd).toHaveBeenCalledWith(expect.objectContaining({ payload: {} }))
  })

  it('returns 404 for an unknown execution', async () => {
    const res = await request(app)
      .post('/api/executions/does-not-exist/replay')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
    expect(mockAdd).not.toHaveBeenCalled()
  })

  it('hides replay from non-members', async () => {
    const workflow = await createWorkflow('Private')
    const originalId = await fireWebhook(workflow.id, { secret: true })
    mockAdd.mockClear()

    const other = await request(app)
      .post('/api/auth/register')
      .send({ email: 'replay-other@example.com', password: 'password123', displayName: 'Other' })
    const res = await request(app)
      .post(`/api/executions/${originalId}/replay`)
      .set('Authorization', `Bearer ${other.body.token}`)
    expect(res.status).toBe(404)
    expect(mockAdd).not.toHaveBeenCalled()
  })

  it('requires authentication', async () => {
    const res = await request(app).post('/api/executions/whatever/replay')
    expect(res.status).toBe(401)
  })

  it('reproduces the original output (same trigger data → same result)', async () => {
    // A workflow whose output depends on the trigger payload, so identical input
    // must yield identical output.
    const graph = {
      nodes: [
        { id: 't1', type: 'trigger-webhook', position: { x: 0, y: 0 }, data: { label: 'Hook' } },
        {
          id: 'o1',
          type: 'output-log',
          position: { x: 0, y: 80 },
          data: { label: 'Out', config: { message: 'order {{t1.order}}' } },
        },
      ],
      edges: [{ id: 'e1', source: 't1', target: 'o1' }],
    }
    const workflow = await createWorkflow('Echo', graph)
    const originalId = await fireWebhook(workflow.id, { order: 99 })

    // The Bull worker is mocked in this suite, so drive the engine directly to
    // materialise the original run's output.
    await runExecution(originalId, { payload: { order: 99 }, publish: () => {} })

    const res = await request(app)
      .post(`/api/executions/${originalId}/replay`)
      .set('Authorization', `Bearer ${token}`)
    const replayId = res.body.execution.id
    // No payload passed — the engine reads trigger_data straight off the new row.
    await runExecution(replayId, { publish: () => {} })

    const outputFor = async (id) => {
      const detail = await request(app)
        .get(`/api/executions/${id}`)
        .set('Authorization', `Bearer ${token}`)
      return detail.body.steps.find((s) => s.node_id === 'o1').output_json
    }
    const originalOutput = await outputFor(originalId)
    const replayOutput = await outputFor(replayId)

    expect(replayOutput).toBe(originalOutput)
    expect(JSON.parse(replayOutput)).toEqual({ message: 'order 99' })
  })

  it('exposes workflowUpdatedAt on the executions list for the modified-since check', async () => {
    const workflow = await createWorkflow('Listed')
    await fireWebhook(workflow.id, { a: 1 })

    const list = await request(app)
      .get(`/api/workflows/${workflow.id}/executions`)
      .set('Authorization', `Bearer ${token}`)
    expect(list.status).toBe(200)
    expect(list.body.workflowUpdatedAt).toBeTruthy()
    expect(list.body.executions.length).toBeGreaterThan(0)
  })
})
