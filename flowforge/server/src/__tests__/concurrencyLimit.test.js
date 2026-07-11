// Per-workflow concurrency limits: the gate service's admission/slot logic and
// the 'reject' policy's 409s across every run entry point.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))
const mockPublish = jest.fn().mockResolvedValue(1)
jest.mock('../config/redis', () => ({ publish: (...a) => mockPublish(...a) }))

const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')
const { admitRun, acquireSlot, releaseSlot, limitFor, _activeRuns } = require('../services/concurrencyGate')

const node = (id, type, config = {}) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label: id, config },
})

const simpleGraph = {
  nodes: [node('t1', 'trigger-manual'), node('log', 'output-log', { message: 'hi' })],
  edges: [{ id: 't1-log', source: 't1', target: 'log' }],
}

describe('per-workflow concurrency limits', () => {
  let token
  let workspaceId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'limits-user@example.com', password: 'password123', displayName: 'Limiter' })
    token = res.body.token
    const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`)
    workspaceId = ws.body.workspaces[0].id
  })

  afterEach(() => {
    _activeRuns.clear()
  })

  async function createWorkflow({ limit, policy } = {}) {
    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/workflows`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: `Limited ${uuidv4().slice(0, 8)}` })
    const workflow = res.body.workflow
    await request(app)
      .put(`/api/workflows/${workflow.id}/graph`)
      .set('Authorization', `Bearer ${token}`)
      .send(simpleGraph)
    if (limit !== undefined || policy !== undefined) {
      db.prepare(
        'UPDATE workflows SET max_concurrent_runs = ?, concurrency_policy = ? WHERE id = ?'
      ).run(limit ?? null, policy ?? 'queue', workflow.id)
    }
    return db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflow.id)
  }

  function seedRun(workflowId, status, triggerType = 'manual') {
    const id = uuidv4()
    db.prepare(
      'INSERT INTO executions (id, workflow_id, status, trigger_type, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, workflowId, status, triggerType, new Date().toISOString())
    return id
  }

  describe('gate service', () => {
    it('admits everything when no limit is set', async () => {
      const workflow = await createWorkflow()
      seedRun(workflow.id, 'running')
      expect(limitFor(workflow)).toBeNull()
      expect(admitRun(workflow).ok).toBe(true)
    })

    it('admits under the cap and refuses at it — reject policy only', async () => {
      const workflow = await createWorkflow({ limit: 2, policy: 'reject' })
      seedRun(workflow.id, 'running')
      expect(admitRun(workflow).ok).toBe(true)

      seedRun(workflow.id, 'pending')
      const refused = admitRun(workflow)
      expect(refused.ok).toBe(false)
      expect(refused.error).toMatch(/Concurrency limit reached/)
      expect(refused.error).toMatch(/limit 2/)

      // The same saturation under 'queue' is accepted — the worker parks it.
      db.prepare("UPDATE workflows SET concurrency_policy = 'queue' WHERE id = ?").run(workflow.id)
      const queued = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflow.id)
      expect(admitRun(queued).ok).toBe(true)
    })

    it('ignores dry runs and settled runs when counting', async () => {
      const workflow = await createWorkflow({ limit: 1, policy: 'reject' })
      seedRun(workflow.id, 'running', 'dry-run')
      seedRun(workflow.id, 'completed')
      seedRun(workflow.id, 'failed')
      expect(admitRun(workflow).ok).toBe(true)
    })

    it('caps and frees worker slots per workflow', async () => {
      const workflow = await createWorkflow({ limit: 2 })
      expect(acquireSlot(workflow.id)).toBe(true)
      expect(acquireSlot(workflow.id)).toBe(true)
      expect(acquireSlot(workflow.id)).toBe(false)

      releaseSlot(workflow.id)
      expect(acquireSlot(workflow.id)).toBe(true)

      // A different workflow is unaffected.
      const other = await createWorkflow({ limit: 1 })
      expect(acquireSlot(other.id)).toBe(true)
    })

    it('never blocks a workflow without a limit', async () => {
      const workflow = await createWorkflow()
      for (let i = 0; i < 20; i++) expect(acquireSlot(workflow.id)).toBe(true)
    })
  })

  describe('settings API', () => {
    it('updates and clears the limit through PUT /workflows/:id', async () => {
      const workflow = await createWorkflow()
      const set = await request(app)
        .put(`/api/workflows/${workflow.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: workflow.name, max_concurrent_runs: 3, concurrency_policy: 'reject' })
      expect(set.status).toBe(200)
      expect(set.body.workflow.max_concurrent_runs).toBe(3)
      expect(set.body.workflow.concurrency_policy).toBe('reject')

      // Omitting the fields leaves them untouched…
      const rename = await request(app)
        .put(`/api/workflows/${workflow.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Renamed' })
      expect(rename.body.workflow.max_concurrent_runs).toBe(3)

      // …and null clears the cap.
      const clear = await request(app)
        .put(`/api/workflows/${workflow.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Renamed', max_concurrent_runs: null })
      expect(clear.body.workflow.max_concurrent_runs).toBeNull()
    })

    it('rejects invalid settings', async () => {
      const workflow = await createWorkflow()
      for (const bad of [0, -1, 1.5, 101, 'two']) {
        const res = await request(app)
          .put(`/api/workflows/${workflow.id}`)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: workflow.name, max_concurrent_runs: bad })
        expect(res.status).toBe(400)
      }
      const badPolicy = await request(app)
        .put(`/api/workflows/${workflow.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: workflow.name, concurrency_policy: 'drop' })
      expect(badPolicy.status).toBe(400)
      expect(badPolicy.body.error).toMatch(/queue.*reject/)
    })
  })

  describe("'reject' policy at the entry points", () => {
    it('409s a manual run at the cap; a dry run still goes through', async () => {
      const workflow = await createWorkflow({ limit: 1, policy: 'reject' })
      seedRun(workflow.id, 'running')

      const run = await request(app)
        .post(`/api/workflows/${workflow.id}/execute`)
        .set('Authorization', `Bearer ${token}`)
      expect(run.status).toBe(409)
      expect(run.body.error).toMatch(/Concurrency limit reached/)

      const test = await request(app)
        .post(`/api/workflows/${workflow.id}/test`)
        .set('Authorization', `Bearer ${token}`)
      expect(test.status).toBe(202)
    })

    it('409s the public trigger, but idempotent replays still return their run', async () => {
      const minted = await request(app)
        .post('/api/tokens')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'limits-test', scopes: ['trigger'] })
      const pat = minted.body.token

      const workflow = await createWorkflow({ limit: 1, policy: 'reject' })

      // First trigger lands under the cap and records its idempotency key.
      const first = await request(app)
        .post(`/api/v1/workflows/${workflow.id}/trigger`)
        .set('Authorization', `Bearer ${pat}`)
        .set('Idempotency-Key', 'k-1')
        .send({ n: 1 })
      expect(first.status).toBe(202)

      // The workflow is now at its cap (the run sits pending — queue mocked).
      const second = await request(app)
        .post(`/api/v1/workflows/${workflow.id}/trigger`)
        .set('Authorization', `Bearer ${pat}`)
        .send({ n: 2 })
      expect(second.status).toBe(409)

      // A retry of the first request must still get its original run back.
      const retry = await request(app)
        .post(`/api/v1/workflows/${workflow.id}/trigger`)
        .set('Authorization', `Bearer ${pat}`)
        .set('Idempotency-Key', 'k-1')
        .send({ n: 1 })
      expect(retry.status).toBe(202)
      expect(retry.body.replayed).toBe(true)
      expect(retry.body.execution.id).toBe(first.body.execution.id)
    })

    it('409s an inbound webhook at the cap', async () => {
      const workflow = await createWorkflow({ limit: 1, policy: 'reject' })
      seedRun(workflow.id, 'running')

      const created = await request(app)
        .post(`/api/workflows/${workflow.id}/webhooks`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'inbound' })
      const key = created.body.webhook.webhook_key

      const res = await request(app).post(`/api/webhooks/${key}`).send({ ping: true })
      expect(res.status).toBe(409)
    })

    it('409s replay and resume at the cap', async () => {
      const workflow = await createWorkflow({ limit: 1, policy: 'reject' })
      const failedId = seedRun(workflow.id, 'failed')
      seedRun(workflow.id, 'running')

      const replay = await request(app)
        .post(`/api/executions/${failedId}/replay`)
        .set('Authorization', `Bearer ${token}`)
      expect(replay.status).toBe(409)

      const resume = await request(app)
        .post(`/api/executions/${failedId}/resume`)
        .set('Authorization', `Bearer ${token}`)
      expect(resume.status).toBe(409)
      expect(resume.body.error).toMatch(/Concurrency limit reached/)
    })
  })
})
