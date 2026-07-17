const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

// Avoid touching Redis — capture what would have been enqueued instead.
const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))

const { app } = require('../index')

describe('webhooks', () => {
  let token
  let workspaceId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'hook-user@example.com', password: 'password123', displayName: 'Hooker' })
    token = res.body.token
    const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`)
    workspaceId = ws.body.workspaces[0].id
  })

  beforeEach(() => mockAdd.mockClear())

  async function createWorkflow(name, graph) {
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

  const oneNodeGraph = {
    nodes: [{ id: 't1', type: 'trigger-webhook', position: { x: 0, y: 0 }, data: { label: 'Hook' } }],
    edges: [],
  }

  it('creates, lists, and deletes a webhook', async () => {
    const workflow = await createWorkflow('Hooked', oneNodeGraph)

    const create = await request(app)
      .post(`/api/workflows/${workflow.id}/webhooks`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'My hook' })
    expect(create.status).toBe(201)
    expect(create.body.webhook.webhook_key).toBeTruthy()
    expect(create.body.webhook.name).toBe('My hook')
    const webhookId = create.body.webhook.id

    const list = await request(app)
      .get(`/api/workflows/${workflow.id}/webhooks`)
      .set('Authorization', `Bearer ${token}`)
    expect(list.status).toBe(200)
    expect(list.body.webhooks.some((w) => w.id === webhookId)).toBe(true)

    const del = await request(app)
      .delete(`/api/webhooks/${webhookId}`)
      .set('Authorization', `Bearer ${token}`)
    expect(del.status).toBe(204)

    const after = await request(app)
      .get(`/api/workflows/${workflow.id}/webhooks`)
      .set('Authorization', `Bearer ${token}`)
    expect(after.body.webhooks.length).toBe(0)
  })

  it('triggers a workflow via the public endpoint and enqueues the body as payload', async () => {
    const workflow = await createWorkflow('Triggerable', oneNodeGraph)
    const create = await request(app)
      .post(`/api/workflows/${workflow.id}/webhooks`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
    const key = create.body.webhook.webhook_key

    // No auth header — this is a public endpoint
    const fire = await request(app).post(`/api/webhooks/${key}`).send({ hello: 'world' })
    expect(fire.status).toBe(202)
    expect(fire.body.executionId).toBeTruthy()

    expect(mockAdd).toHaveBeenCalledTimes(1)
    expect(mockAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: fire.body.executionId,
        workflowId: workflow.id,
        payload: { hello: 'world' },
      }),
      { priority: 5 }
    )

    // The execution row exists and is owned by the workflow's workspace
    const exec = await request(app)
      .get(`/api/executions/${fire.body.executionId}`)
      .set('Authorization', `Bearer ${token}`)
    expect(exec.status).toBe(200)
    expect(exec.body.execution.status).toBe('pending')
    expect(exec.body.execution.triggered_by).toBeNull()
  })

  it('returns 404 for an unknown webhook key', async () => {
    const res = await request(app).post('/api/webhooks/does-not-exist').send({})
    expect(res.status).toBe(404)
    expect(mockAdd).not.toHaveBeenCalled()
  })

  it('rejects triggering a workflow with no nodes', async () => {
    const workflow = await createWorkflow('Empty', null)
    const create = await request(app)
      .post(`/api/workflows/${workflow.id}/webhooks`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
    const key = create.body.webhook.webhook_key

    const fire = await request(app).post(`/api/webhooks/${key}`).send({})
    expect(fire.status).toBe(400)
    expect(mockAdd).not.toHaveBeenCalled()
  })

  it('hides webhook management from non-members', async () => {
    const workflow = await createWorkflow('Private', oneNodeGraph)
    const other = await request(app)
      .post('/api/auth/register')
      .send({ email: 'hook-other@example.com', password: 'password123', displayName: 'Other' })

    const res = await request(app)
      .post(`/api/workflows/${workflow.id}/webhooks`)
      .set('Authorization', `Bearer ${other.body.token}`)
      .send({})
    expect(res.status).toBe(404)
  })
})
