// Workflow pause — the operational kill switch. While paused, no new real
// run starts at any entry point (manual, public API, webhook, schedule,
// error-handler escalation), in-flight semantics are untouched, and dry runs
// stay allowed so the person debugging the incident can still test fixes.
// Pause and resume are idempotent; the first pause wins the audit trail.

const request = require('supertest')
const { v4: uuidv4 } = require('uuid')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))

const mockRedis = { set: jest.fn().mockResolvedValue('OK'), del: jest.fn().mockResolvedValue(1) }
jest.mock('../config/redis', () => mockRedis)

const { app } = require('../index')
const db = require('../config/database')
const { runScheduledExecution } = require('../services/scheduler')
const { triggerErrorHandler } = require('../services/errorHandler')

describe('workflow pause', () => {
  let jwt
  let workspaceId
  let workflowId
  let webhookKey
  let apiToken

  const authed = (req) => req.set('Authorization', `Bearer ${jwt}`)

  beforeAll(async () => {
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ email: 'pause@example.com', password: 'password123', displayName: 'Pauser' })
    jwt = reg.body.token
    const ws = await authed(request(app).get('/api/workspaces'))
    workspaceId = ws.body.workspaces[0].id
    const wf = await authed(request(app).post(`/api/workspaces/${workspaceId}/workflows`))
      .send({ name: 'Pausable' })
    workflowId = wf.body.workflow.id
    await authed(request(app).put(`/api/workflows/${workflowId}/graph`)).send({
      nodes: [
        { id: 't1', type: 'trigger-webhook', position: { x: 0, y: 0 }, data: { label: 'Hook' } },
      ],
      edges: [],
    })
    const hook = await authed(request(app).post(`/api/workflows/${workflowId}/webhooks`)).send({})
    webhookKey = hook.body.webhook.webhook_key

    const minted = await authed(request(app).post('/api/tokens'))
      .send({ name: 'pause-suite', scopes: ['trigger', 'read'] })
    apiToken = minted.body.token
  })

  beforeEach(() => mockAdd.mockClear())

  afterEach(async () => {
    // Leave the workflow running for the next test regardless of outcome.
    await authed(request(app).post(`/api/workflows/${workflowId}/resume`))
  })

  it('pauses and resumes idempotently, keeping the first pause as the audit trail', async () => {
    const paused = await authed(request(app).post(`/api/workflows/${workflowId}/pause`))
    expect(paused.status).toBe(200)
    expect(paused.body.workflow.paused_at).toBeTruthy()
    const firstPausedAt = paused.body.workflow.paused_at

    // A second pause is a safe no-op — the recorded pause survives.
    const again = await authed(request(app).post(`/api/workflows/${workflowId}/pause`))
    expect(again.status).toBe(200)
    expect(again.body.workflow.paused_at).toBe(firstPausedAt)

    const resumed = await authed(request(app).post(`/api/workflows/${workflowId}/resume`))
    expect(resumed.status).toBe(200)
    expect(resumed.body.workflow.paused_at).toBeNull()
    expect(resumed.body.workflow.paused_by).toBeNull()

    // Resuming an active workflow is equally safe.
    const reresumed = await authed(request(app).post(`/api/workflows/${workflowId}/resume`))
    expect(reresumed.status).toBe(200)
  })

  it('logs pause and resume to the activity feed', async () => {
    await authed(request(app).post(`/api/workflows/${workflowId}/pause`))
    await authed(request(app).post(`/api/workflows/${workflowId}/resume`))
    const types = db
      .prepare('SELECT event_type FROM activity_events WHERE workspace_id = ? ORDER BY rowid')
      .all(workspaceId)
      .map((r) => r.event_type)
    expect(types).toContain('workflow.paused')
    expect(types).toContain('workflow.resumed')
  })

  it('refuses the switch to viewers and hides it from non-members', async () => {
    const viewer = await request(app)
      .post('/api/auth/register')
      .send({ email: 'pause-viewer@example.com', password: 'password123', displayName: 'V' })
    await authed(request(app).post(`/api/workspaces/${workspaceId}/members`))
      .send({ email: 'pause-viewer@example.com', role: 'viewer' })
    const denied = await request(app)
      .post(`/api/workflows/${workflowId}/pause`)
      .set('Authorization', `Bearer ${viewer.body.token}`)
    expect(denied.status).toBe(403)

    const stranger = await request(app)
      .post('/api/auth/register')
      .send({ email: 'pause-stranger@example.com', password: 'password123', displayName: 'S' })
    const hidden = await request(app)
      .post(`/api/workflows/${workflowId}/pause`)
      .set('Authorization', `Bearer ${stranger.body.token}`)
    expect(hidden.status).toBe(404)
  })

  it('refuses manual runs while paused and allows them again after resume', async () => {
    await authed(request(app).post(`/api/workflows/${workflowId}/pause`))
    const refused = await authed(request(app).post(`/api/workflows/${workflowId}/execute`))
    expect(refused.status).toBe(409)
    expect(refused.body.error).toMatch(/paused/)
    expect(mockAdd).not.toHaveBeenCalled()

    await authed(request(app).post(`/api/workflows/${workflowId}/resume`))
    const ok = await authed(request(app).post(`/api/workflows/${workflowId}/execute`))
    expect(ok.status).toBe(202)
    expect(mockAdd).toHaveBeenCalledTimes(1)
  })

  it('still allows dry runs while paused — debugging is why you paused it', async () => {
    await authed(request(app).post(`/api/workflows/${workflowId}/pause`))
    const dry = await authed(request(app).post(`/api/workflows/${workflowId}/test`))
    expect(dry.status).toBe(202)
    expect(mockAdd).toHaveBeenCalledTimes(1)
  })

  it('acknowledges webhook deliveries without firing while paused', async () => {
    await authed(request(app).post(`/api/workflows/${workflowId}/pause`))
    const res = await request(app).post(`/api/webhooks/${webhookKey}`).send({ event: 'push' })
    expect(res.status).toBe(202)
    expect(res.body).toEqual({ accepted: false, reason: 'paused' })
    expect(mockAdd).not.toHaveBeenCalled()
    // An acknowledged-but-skipped delivery is not a firing.
    const hook = db.prepare('SELECT last_triggered_at FROM webhooks WHERE webhook_key = ?').get(webhookKey)
    expect(hook.last_triggered_at).toBeNull()
  })

  it('refuses public API triggers with a 409 while paused', async () => {
    await authed(request(app).post(`/api/workflows/${workflowId}/pause`))
    const res = await request(app)
      .post(`/api/v1/workflows/${workflowId}/trigger`)
      .set('Authorization', `Bearer ${apiToken}`)
      .send({ any: 'payload' })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/paused/)
    expect(mockAdd).not.toHaveBeenCalled()
  })

  it('an idempotent retry still replays a run that landed before the pause', async () => {
    const first = await request(app)
      .post(`/api/v1/workflows/${workflowId}/trigger`)
      .set('Authorization', `Bearer ${apiToken}`)
      .set('Idempotency-Key', 'pre-pause-key')
      .send({ n: 1 })
    expect(first.status).toBe(202)

    await authed(request(app).post(`/api/workflows/${workflowId}/pause`))
    const retry = await request(app)
      .post(`/api/v1/workflows/${workflowId}/trigger`)
      .set('Authorization', `Bearer ${apiToken}`)
      .set('Idempotency-Key', 'pre-pause-key')
      .send({ n: 1 })
    expect(retry.status).toBe(202)
    expect(retry.body.replayed).toBe(true)
    expect(retry.body.execution.id).toBe(first.body.execution.id)
  })

  it('refuses replay and resume of past runs while paused, except dry-run lineage', async () => {
    const now = new Date().toISOString()
    const failedId = uuidv4()
    db.prepare(
      "INSERT INTO executions (id, workflow_id, status, trigger_type, created_at) VALUES (?, ?, 'failed', 'manual', ?)"
    ).run(failedId, workflowId, now)
    const dryId = uuidv4()
    db.prepare(
      "INSERT INTO executions (id, workflow_id, status, trigger_type, created_at) VALUES (?, ?, 'failed', 'dry-run', ?)"
    ).run(dryId, workflowId, now)

    await authed(request(app).post(`/api/workflows/${workflowId}/pause`))

    const replay = await authed(request(app).post(`/api/executions/${failedId}/replay`))
    expect(replay.status).toBe(409)
    const resume = await authed(request(app).post(`/api/executions/${failedId}/resume`))
    expect(resume.status).toBe(409)
    expect(mockAdd).not.toHaveBeenCalled()

    // A dry-run replay fires no side effects, so the switch doesn't apply.
    const dryReplay = await authed(request(app).post(`/api/executions/${dryId}/replay`))
    expect(dryReplay.status).toBe(202)
    expect(mockAdd).toHaveBeenCalledTimes(1)
  })

  it('drops schedule ticks while paused without unregistering the schedule', async () => {
    db.prepare("UPDATE workflows SET status = 'deployed' WHERE id = ?").run(workflowId)
    await authed(request(app).post(`/api/workflows/${workflowId}/pause`))
    await runScheduledExecution(workflowId)
    expect(mockAdd).not.toHaveBeenCalled()

    await authed(request(app).post(`/api/workflows/${workflowId}/resume`))
    await runScheduledExecution(workflowId)
    expect(mockAdd).toHaveBeenCalledTimes(1)
    db.prepare("UPDATE workflows SET status = 'draft' WHERE id = ?").run(workflowId)
  })

  it('skips a paused error-handler workflow instead of launching it', async () => {
    // A second workflow whose failures escalate to the (paused) handler.
    const failing = await authed(request(app).post(`/api/workspaces/${workspaceId}/workflows`))
      .send({ name: 'Fails' })
    db.prepare("UPDATE workflows SET status = 'deployed', error_workflow_id = ? WHERE id = ?")
      .run(workflowId, failing.body.workflow.id)
    db.prepare("UPDATE workflows SET status = 'deployed' WHERE id = ?").run(workflowId)

    const executionId = uuidv4()
    db.prepare(
      "INSERT INTO executions (id, workflow_id, status, trigger_type, created_at) VALUES (?, ?, 'failed', 'manual', ?)"
    ).run(executionId, failing.body.workflow.id, new Date().toISOString())

    await authed(request(app).post(`/api/workflows/${workflowId}/pause`))
    expect(await triggerErrorHandler(executionId)).toBeNull()

    await authed(request(app).post(`/api/workflows/${workflowId}/resume`))
    expect(await triggerErrorHandler(executionId)).toBeTruthy()
    db.prepare("UPDATE workflows SET status = 'draft' WHERE id = ?").run(workflowId)
  })
})
