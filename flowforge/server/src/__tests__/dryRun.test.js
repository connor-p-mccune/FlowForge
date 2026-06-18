const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

// Avoid touching Redis — capture what would have been enqueued instead.
const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))

const { app } = require('../index')

const oneNodeGraph = {
  nodes: [{ id: 't1', type: 'trigger-manual', position: { x: 0, y: 0 }, data: { label: 'Start' } }],
  edges: [],
}

describe('dry-run (test mode) execution', () => {
  let token
  let userId
  let workspaceId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'dryrun-user@example.com', password: 'password123', displayName: 'Tester' })
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

  it('enqueues a run with dryRun: true and marks it trigger_type "dry-run"', async () => {
    const workflow = await createWorkflow('Testable')
    const res = await request(app)
      .post(`/api/workflows/${workflow.id}/test`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(202)

    const execution = res.body.execution
    expect(execution.status).toBe('pending')
    expect(execution.trigger_type).toBe('dry-run')
    // triggered_by stays the user FK (who ran the test), not a literal marker.
    expect(execution.triggered_by).toBe(userId)

    expect(mockAdd).toHaveBeenCalledTimes(1)
    expect(mockAdd).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: execution.id, workflowId: workflow.id, dryRun: true })
    )
  })

  it('rejects a test run on an empty workflow', async () => {
    const workflow = await createWorkflow('Empty', { nodes: [], edges: [] })
    const res = await request(app)
      .post(`/api/workflows/${workflow.id}/test`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(400)
    expect(mockAdd).not.toHaveBeenCalled()
  })

  it('hides test runs from non-members', async () => {
    const workflow = await createWorkflow('Private')
    const other = await request(app)
      .post('/api/auth/register')
      .send({ email: 'dryrun-other@example.com', password: 'password123', displayName: 'Other' })
    const res = await request(app)
      .post(`/api/workflows/${workflow.id}/test`)
      .set('Authorization', `Bearer ${other.body.token}`)
    expect(res.status).toBe(404)
    expect(mockAdd).not.toHaveBeenCalled()
  })

  it('requires authentication', async () => {
    const res = await request(app).post('/api/workflows/whatever/test')
    expect(res.status).toBe(401)
  })

  it('replaying a dry-run stays a dry-run so it never fires real actions', async () => {
    const workflow = await createWorkflow('ReplayTest')
    const test = await request(app)
      .post(`/api/workflows/${workflow.id}/test`)
      .set('Authorization', `Bearer ${token}`)
    const originalId = test.body.execution.id
    mockAdd.mockClear()

    const res = await request(app)
      .post(`/api/executions/${originalId}/replay`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(202)
    expect(res.body.execution.trigger_type).toBe('dry-run')
    expect(mockAdd).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }))
  })
})
