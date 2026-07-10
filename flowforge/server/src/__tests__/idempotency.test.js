// Idempotency-Key on POST /api/v1/workflows/:id/trigger: replaying the same
// key returns the original run, a key pinned to a different body conflicts,
// keys are scoped per workflow, and expired keys are swept.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))
jest.mock('../config/redis', () => ({ publish: jest.fn().mockResolvedValue(1) }))

const { app } = require('../index')
const db = require('../config/database')

const graph = {
  nodes: [{ id: 't1', type: 'trigger-manual', position: { x: 0, y: 0 }, data: { label: 't1', config: {} } }],
  edges: [],
}

describe('trigger idempotency', () => {
  let pat
  let workflowId
  let otherWorkflowId

  beforeAll(async () => {
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ email: 'idem@example.com', password: 'password123', displayName: 'Idem' })
    const session = reg.body.token
    const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${session}`)
    const workspaceId = ws.body.workspaces[0].id

    async function makeWorkflow(name) {
      const created = await request(app)
        .post(`/api/workspaces/${workspaceId}/workflows`)
        .set('Authorization', `Bearer ${session}`)
        .send({ name })
      await request(app)
        .put(`/api/workflows/${created.body.workflow.id}/graph`)
        .set('Authorization', `Bearer ${session}`)
        .send(graph)
      return created.body.workflow.id
    }
    workflowId = await makeWorkflow('Idempotent A')
    otherWorkflowId = await makeWorkflow('Idempotent B')

    const minted = await request(app)
      .post('/api/tokens')
      .set('Authorization', `Bearer ${session}`)
      .send({ name: 'idem-test', scopes: ['trigger', 'read'] })
    pat = minted.body.token
  })

  beforeEach(() => {
    mockAdd.mockClear()
  })

  function trigger(wfId, { key, body = { order: 1 } } = {}) {
    const req = request(app)
      .post(`/api/v1/workflows/${wfId}/trigger`)
      .set('Authorization', `Bearer ${pat}`)
      .send(body)
    if (key !== undefined) req.set('Idempotency-Key', key)
    return req
  }

  it('replays the original run for a repeated key + body', async () => {
    const first = await trigger(workflowId, { key: 'deploy-42' })
    expect(first.status).toBe(202)
    expect(first.body.replayed).toBeUndefined()

    const second = await trigger(workflowId, { key: 'deploy-42' })
    expect(second.status).toBe(202)
    expect(second.body.replayed).toBe(true)
    expect(second.headers['idempotent-replay']).toBe('true')
    expect(second.body.execution.id).toBe(first.body.execution.id)
    expect(second.body.statusUrl).toBe(first.body.statusUrl)

    // Only one run was actually created and enqueued.
    expect(mockAdd).toHaveBeenCalledTimes(1)
    const rows = db.prepare(
      "SELECT COUNT(*) AS n FROM executions WHERE workflow_id = ? AND trigger_type = 'api'"
    ).get(workflowId)
    expect(rows.n).toBe(1)
  })

  it('409s when the same key arrives with a different body', async () => {
    await trigger(workflowId, { key: 'pinned', body: { a: 1 } })
    const conflict = await trigger(workflowId, { key: 'pinned', body: { a: 2 } })
    expect(conflict.status).toBe(409)
    expect(conflict.body.error).toMatch(/different request body/)
    expect(mockAdd).toHaveBeenCalledTimes(1)
  })

  it('scopes keys per workflow', async () => {
    const a = await trigger(workflowId, { key: 'shared-key' })
    const b = await trigger(otherWorkflowId, { key: 'shared-key' })
    expect(a.status).toBe(202)
    expect(b.status).toBe(202)
    expect(b.body.replayed).toBeUndefined()
    expect(a.body.execution.id).not.toBe(b.body.execution.id)
  })

  it('starts distinct runs without a key, and rejects malformed keys', async () => {
    const one = await trigger(workflowId)
    const two = await trigger(workflowId)
    expect(one.body.execution.id).not.toBe(two.body.execution.id)

    const tooLong = await trigger(workflowId, { key: 'x'.repeat(256) })
    expect(tooLong.status).toBe(400)
    const blank = await trigger(workflowId, { key: '   ' })
    expect(blank.status).toBe(400)
  })

  it('treats an expired key as fresh', async () => {
    const first = await trigger(workflowId, { key: 'stale' })
    // Age the row past the 24h TTL.
    db.prepare('UPDATE idempotency_keys SET created_at = ? WHERE key = ?').run(
      new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), 'stale'
    )
    const second = await trigger(workflowId, { key: 'stale' })
    expect(second.status).toBe(202)
    expect(second.body.replayed).toBeUndefined()
    expect(second.body.execution.id).not.toBe(first.body.execution.id)
  })
})
