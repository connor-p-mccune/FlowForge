// Schedule backfill: planning a historical window into scheduled occurrences,
// submitting them as runs that carry their logical date, and the guardrails
// that keep one click from creating ten thousand jobs.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))
// Cancelling a queued run publishes its terminal event; keep that off the
// network, like the other cancellation suites.
const mockPublish = jest.fn().mockResolvedValue(1)
jest.mock('../config/redis', () => ({ publish: (...a) => mockPublish(...a) }))

// Deploying a scheduled workflow registers a real node-cron task, which holds
// the event loop open long after the assertions finish. The scheduler's own
// behaviour is covered in schedule.test.js; here it only has to not fire.
jest.mock('../services/scheduler', () => {
  const actual = jest.requireActual('../services/scheduler')
  return { ...actual, registerSchedule: jest.fn(), unregisterSchedule: jest.fn(), restoreSchedules: jest.fn() }
})

const { app } = require('../index')
const db = require('../config/database')
const { planBackfill, MAX_OCCURRENCES } = require('../services/backfill')

// A workflow row shaped the way the service reads it, without going through
// the API — the planner is a pure function of (graph, window).
function workflowWith(cron, timezone) {
  return {
    id: 'wf-plan',
    workspace_id: 'ws',
    name: 'Nightly',
    status: 'deployed',
    graph_json: JSON.stringify({
      nodes: [
        {
          id: 's1',
          type: 'trigger-schedule',
          data: { config: { cron, ...(timezone ? { timezone } : {}) } },
        },
      ],
      edges: [],
    }),
  }
}

describe('planBackfill', () => {
  it('reconstructs the occurrences that would have fired in the window', () => {
    const plan = planBackfill(workflowWith('0 9 * * *'), {
      from: '2026-03-01T00:00:00Z',
      to: '2026-03-04T00:00:00Z',
    })
    expect(plan.total).toBe(3)
    expect(plan.occurrences.map((o) => o.logicalDate)).toEqual([
      '2026-03-01T09:00:00.000Z',
      '2026-03-02T09:00:00.000Z',
      '2026-03-03T09:00:00.000Z',
    ])
  })

  it('is half-open at the from end, so a backfill does not repeat its boundary', () => {
    // Starting exactly at a fire time must not re-create that occurrence: the
    // natural way to resume a partial backfill is "from the last one I ran".
    const plan = planBackfill(workflowWith('0 9 * * *'), {
      from: '2026-03-01T09:00:00Z',
      to: '2026-03-03T00:00:00Z',
    })
    expect(plan.occurrences.map((o) => o.logicalDate)).toEqual(['2026-03-02T09:00:00.000Z'])
  })

  it('reproduces the schedule’s own DST behaviour in a zoned workflow', () => {
    // A backfill has to generate what the live scheduler *would* have fired,
    // not a naive UTC grid — otherwise a backfill across a DST change silently
    // disagrees with the runs around it.
    const plan = planBackfill(workflowWith('0 9 * * *', 'America/New_York'), {
      from: '2026-03-07T00:00:00Z',
      to: '2026-03-10T00:00:00Z',
    })
    expect(plan.timeZone).toBe('America/New_York')
    expect(plan.occurrences.map((o) => o.logicalDate)).toEqual([
      '2026-03-07T14:00:00.000Z', // 09:00 EST
      '2026-03-08T13:00:00.000Z', // 09:00 EDT — the clocks moved, the local hour held
      '2026-03-09T13:00:00.000Z',
    ])
  })

  it('clamps a window that runs into the future', () => {
    // "From last week until tomorrow" is a reasonable thing to ask and an
    // obvious thing to mean; generating runs for occurrences the scheduler is
    // still going to fire would create duplicates.
    const from = new Date(Date.now() - 3 * 86400000).toISOString()
    const to = new Date(Date.now() + 30 * 86400000).toISOString()
    const plan = planBackfill(workflowWith('0 9 * * *'), { from, to })
    expect(plan.error).toBeUndefined()
    expect(new Date(plan.to).getTime()).toBeLessThanOrEqual(Date.now())
    // And nothing it planned is in the future.
    for (const o of plan.occurrences) {
      expect(new Date(o.logicalDate).getTime()).toBeLessThanOrEqual(Date.now())
    }
  })

  it('refuses a window that would create more runs than the cap', () => {
    // Refuse rather than truncate: "I asked for a year and got the first 1000"
    // is a worse outcome than being told to narrow the range.
    const plan = planBackfill(workflowWith('* * * * *'), {
      from: '2026-03-01T00:00:00Z',
      to: '2026-03-31T00:00:00Z',
    })
    expect(plan.error).toMatch(new RegExp(`more than ${MAX_OCCURRENCES} runs`))
  })

  it('rejects a workflow with no schedule trigger', () => {
    const manual = {
      id: 'wf-manual',
      graph_json: JSON.stringify({ nodes: [{ id: 't', type: 'trigger-manual' }], edges: [] }),
    }
    const plan = planBackfill(manual, { from: '2026-03-01T00:00:00Z', to: '2026-03-02T00:00:00Z' })
    expect(plan.error).toMatch(/no schedule trigger/)
  })

  it('validates the window itself', () => {
    const wf = workflowWith('0 9 * * *')
    expect(planBackfill(wf, { from: 'nonsense', to: '2026-03-02T00:00:00Z' }).error).toMatch(/from/)
    expect(planBackfill(wf, { from: '2026-03-02T00:00:00Z', to: 'nope' }).error).toMatch(/to/)
    expect(
      planBackfill(wf, { from: '2026-03-02T00:00:00Z', to: '2026-03-01T00:00:00Z' }).error
    ).toMatch(/must be after/)
    expect(
      planBackfill(wf, { from: '2000-01-01T00:00:00Z', to: '2026-03-01T00:00:00Z' }).error
    ).toMatch(/five years/)
  })
})

describe('backfill routes', () => {
  let token
  let workspaceId
  let workflowId

  beforeAll(async () => {
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ email: 'backfill@example.com', password: 'password123', displayName: 'BF' })
    token = reg.body.token
    const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`)
    workspaceId = ws.body.workspaces[0].id
  })

  const authed = (req) => req.set('Authorization', `Bearer ${token}`)

  beforeEach(async () => {
    mockAdd.mockClear()
    const created = await authed(
      request(app).post(`/api/workspaces/${workspaceId}/workflows`).send({ name: 'Nightly sync' })
    )
    workflowId = created.body.workflow.id
    await authed(request(app).put(`/api/workflows/${workflowId}/graph`)).send({
      nodes: [
        {
          id: 's1',
          type: 'trigger-schedule',
          position: { x: 0, y: 0 },
          data: { label: 'Schedule', config: { cron: '0 9 * * *' } },
        },
      ],
      edges: [],
    })
    await authed(request(app).post(`/api/workflows/${workflowId}/deploy`))
  })

  it('previews a window without creating anything', async () => {
    const res = await authed(request(app).post(`/api/workflows/${workflowId}/backfill`)).send({
      preview: true,
      from: '2026-03-01T00:00:00Z',
      to: '2026-03-05T00:00:00Z',
    })
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(4)
    expect(res.body.willRun).toBe(4)
    expect(mockAdd).not.toHaveBeenCalled()
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM executions WHERE workflow_id = ?').get(workflowId).n
    ).toBe(0)
  })

  it('creates one run per occurrence, each carrying its logical date', async () => {
    const res = await authed(request(app).post(`/api/workflows/${workflowId}/backfill`)).send({
      from: '2026-03-01T00:00:00Z',
      to: '2026-03-04T00:00:00Z',
    })
    expect(res.status).toBe(202)
    expect(res.body.created).toBe(3)
    expect(mockAdd).toHaveBeenCalledTimes(3)

    const rows = db
      .prepare('SELECT * FROM executions WHERE workflow_id = ? ORDER BY logical_date')
      .all(workflowId)
    expect(rows).toHaveLength(3)
    expect(rows[0].logical_date).toBe('2026-03-01T09:00:00.000Z')
    expect(rows.every((r) => r.trigger_type === 'backfill')).toBe(true)
    expect(rows.every((r) => r.backfill_id === res.body.backfillId)).toBe(true)

    // The graph reads the logical date through the trigger payload, exactly
    // like a webhook body — no new templating concept.
    expect(JSON.parse(rows[0].trigger_data)).toEqual({
      logicalDate: '2026-03-01T09:00:00.000Z',
      backfill: true,
    })
    expect(mockAdd.mock.calls[0][0].payload.logicalDate).toBe('2026-03-01T09:00:00.000Z')
  })

  it('rides the low lane so bulk work never starves live traffic', async () => {
    const res = await authed(request(app).post(`/api/workflows/${workflowId}/backfill`)).send({
      from: '2026-03-01T00:00:00Z',
      to: '2026-03-03T00:00:00Z',
    })
    expect(res.body.priority).toBe('low')
    // Bull priority 10 = the low lane.
    expect(mockAdd.mock.calls[0][1]).toEqual({ priority: 10 })
  })

  it('skips occurrences that already have a run, so re-submitting is safe', async () => {
    await authed(request(app).post(`/api/workflows/${workflowId}/backfill`)).send({
      from: '2026-03-01T00:00:00Z',
      to: '2026-03-04T00:00:00Z',
    })
    mockAdd.mockClear()

    // An overlapping range: two of the three days already ran.
    const second = await authed(request(app).post(`/api/workflows/${workflowId}/backfill`)).send({
      from: '2026-03-02T00:00:00Z',
      to: '2026-03-06T00:00:00Z',
    })
    expect(second.status).toBe(202)
    expect(second.body.skipped).toBe(2)
    expect(second.body.created).toBe(2) // the 4th and 5th
    expect(mockAdd).toHaveBeenCalledTimes(2)
  })

  it('refuses a range that is already fully covered', async () => {
    await authed(request(app).post(`/api/workflows/${workflowId}/backfill`)).send({
      from: '2026-03-01T00:00:00Z',
      to: '2026-03-04T00:00:00Z',
    })
    const again = await authed(request(app).post(`/api/workflows/${workflowId}/backfill`)).send({
      from: '2026-03-01T00:00:00Z',
      to: '2026-03-04T00:00:00Z',
    })
    expect(again.status).toBe(400)
    expect(again.body.error).toMatch(/already has a run/)
  })

  it('re-runs covered occurrences when skipExisting is false', async () => {
    await authed(request(app).post(`/api/workflows/${workflowId}/backfill`)).send({
      from: '2026-03-01T00:00:00Z',
      to: '2026-03-03T00:00:00Z',
    })
    mockAdd.mockClear()
    const again = await authed(request(app).post(`/api/workflows/${workflowId}/backfill`)).send({
      from: '2026-03-01T00:00:00Z',
      to: '2026-03-03T00:00:00Z',
      skipExisting: false,
    })
    expect(again.status).toBe(202)
    expect(again.body.created).toBe(2)
  })

  it('is refused while the workflow is paused', async () => {
    // Bulk historical traffic is exactly what pausing is meant to stop.
    await authed(request(app).post(`/api/workflows/${workflowId}/pause`))
    const res = await authed(request(app).post(`/api/workflows/${workflowId}/backfill`)).send({
      from: '2026-03-01T00:00:00Z',
      to: '2026-03-04T00:00:00Z',
    })
    expect(res.status).toBe(409)
    expect(mockAdd).not.toHaveBeenCalled()
  })

  it('is refused for a draft workflow', async () => {
    const draft = await authed(
      request(app).post(`/api/workspaces/${workspaceId}/workflows`).send({ name: 'Draft' })
    )
    const res = await authed(
      request(app).post(`/api/workflows/${draft.body.workflow.id}/backfill`)
    ).send({ from: '2026-03-01T00:00:00Z', to: '2026-03-04T00:00:00Z' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/deployed/)
  })

  it('reports batch progress derived from the runs themselves', async () => {
    const submit = await authed(request(app).post(`/api/workflows/${workflowId}/backfill`)).send({
      from: '2026-03-01T00:00:00Z',
      to: '2026-03-04T00:00:00Z',
    })
    // Settle one of them the way the engine would.
    const first = db
      .prepare('SELECT id FROM executions WHERE workflow_id = ? ORDER BY logical_date LIMIT 1')
      .get(workflowId)
    db.prepare("UPDATE executions SET status = 'completed' WHERE id = ?").run(first.id)

    const res = await authed(request(app).get(`/api/workflows/${workflowId}/backfills`))
    expect(res.status).toBe(200)
    const batch = res.body.backfills.find((b) => b.backfillId === submit.body.backfillId)
    expect(batch).toMatchObject({ total: 3, completed: 1, active: 2, failed: 0 })
    expect(batch.firstLogicalDate).toBe('2026-03-01T09:00:00.000Z')
  })

  it('cancels the unsettled remainder of a batch, leaving finished runs alone', async () => {
    const submit = await authed(request(app).post(`/api/workflows/${workflowId}/backfill`)).send({
      from: '2026-03-01T00:00:00Z',
      to: '2026-03-04T00:00:00Z',
    })
    const first = db
      .prepare('SELECT id FROM executions WHERE workflow_id = ? ORDER BY logical_date LIMIT 1')
      .get(workflowId)
    db.prepare("UPDATE executions SET status = 'completed' WHERE id = ?").run(first.id)

    const res = await authed(
      request(app).post(
        `/api/workflows/${workflowId}/backfills/${submit.body.backfillId}/cancel`
      )
    )
    expect(res.status).toBe(200)
    expect(res.body.cancelled).toBe(2)

    const statuses = db
      .prepare('SELECT status FROM executions WHERE workflow_id = ? ORDER BY logical_date')
      .all(workflowId)
      .map((r) => r.status)
    // The finished run keeps its outcome — cancelling stops the queue, it does
    // not erase what already happened.
    expect(statuses).toEqual(['completed', 'cancelled', 'cancelled'])
  })

  it('refuses a viewer', async () => {
    const viewer = await request(app)
      .post('/api/auth/register')
      .send({ email: 'bf-viewer@example.com', password: 'password123', displayName: 'V' })
    await authed(request(app).post(`/api/workspaces/${workspaceId}/members`)).send({
      email: 'bf-viewer@example.com',
      role: 'viewer',
    })
    const res = await request(app)
      .post(`/api/workflows/${workflowId}/backfill`)
      .set('Authorization', `Bearer ${viewer.body.token}`)
      .send({ from: '2026-03-01T00:00:00Z', to: '2026-03-04T00:00:00Z' })
    expect(res.status).toBe(403)
  })
})
