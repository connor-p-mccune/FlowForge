// Scheduled maintenance windows: auto-pause a workflow during its declared
// window and resume it after, reusing the pause kill switch — while never
// touching a manual pause.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))

const { app } = require('../index')
const db = require('../config/database')
const {
  isWithinWindow,
  checkOnce,
} = require('../services/maintenanceWindow')
const { pauseWorkflow } = require('../services/workflowPause')

describe('isWithinWindow', () => {
  // 02:00 UTC daily, open for two hours → active across [02:00, 04:00).
  const cron = '0 2 * * *'
  const dur = 120
  const at = (iso) => new Date(iso)

  it('is active from the start instant up to (but not including) the end', () => {
    expect(isWithinWindow(cron, dur, at('2026-07-20T02:00:00Z'))).toBe(true) // start — inclusive
    expect(isWithinWindow(cron, dur, at('2026-07-20T02:30:00Z'))).toBe(true) // mid
    expect(isWithinWindow(cron, dur, at('2026-07-20T03:59:00Z'))).toBe(true) // just before end
    expect(isWithinWindow(cron, dur, at('2026-07-20T04:00:00Z'))).toBe(false) // end — exclusive
    expect(isWithinWindow(cron, dur, at('2026-07-20T12:00:00Z'))).toBe(false) // well outside
  })

  it('is false for an unset or invalid window', () => {
    expect(isWithinWindow(null, dur, at('2026-07-20T02:30:00Z'))).toBe(false)
    expect(isWithinWindow(cron, null, at('2026-07-20T02:30:00Z'))).toBe(false)
    expect(isWithinWindow('not a cron', dur, at('2026-07-20T02:30:00Z'))).toBe(false)
  })
})

describe('maintenance sweep (checkOnce)', () => {
  let jwt
  let workflowId

  const authed = (req) => req.set('Authorization', `Bearer ${jwt}`)
  const rowOf = (id) => db.prepare('SELECT * FROM workflows WHERE id = ?').get(id)
  const inside = new Date('2026-07-20T02:30:00Z')
  const outside = new Date('2026-07-20T12:00:00Z')

  const setWindow = (id, cron, dur) =>
    db.prepare('UPDATE workflows SET maintenance_cron = ?, maintenance_duration_minutes = ? WHERE id = ?')
      .run(cron, dur, id)

  beforeAll(async () => {
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ email: 'maint@example.com', password: 'password123', displayName: 'Maint' })
    jwt = reg.body.token
    const workspaceId = (await authed(request(app).get('/api/workspaces'))).body.workspaces[0].id
    workflowId = (
      await authed(request(app).post(`/api/workspaces/${workspaceId}/workflows`)).send({ name: 'Windowed' })
    ).body.workflow.id
    setWindow(workflowId, '0 2 * * *', 120)
  })

  afterEach(() => {
    // Reset to active + windowed for the next case.
    db.prepare('UPDATE workflows SET paused_at = NULL, paused_by = NULL, paused_reason = NULL WHERE id = ?')
      .run(workflowId)
    setWindow(workflowId, '0 2 * * *', 120)
  })

  it('auto-pauses inside a window and auto-resumes after', () => {
    const paused = checkOnce(inside)
    expect(paused).toEqual([{ workflowId, event: 'paused' }])
    let row = rowOf(workflowId)
    expect(row.paused_at).toBeTruthy()
    expect(row.paused_reason).toBe('maintenance')

    // Idempotent while still inside — no second pause.
    expect(checkOnce(inside)).toEqual([])

    const resumed = checkOnce(outside)
    expect(resumed).toEqual([{ workflowId, event: 'resumed' }])
    row = rowOf(workflowId)
    expect(row.paused_at).toBeNull()
    expect(row.paused_reason).toBeNull()
  })

  it('never auto-resumes a manual pause when the window ends', () => {
    pauseWorkflow(rowOf(workflowId), null, { reason: 'manual' })
    expect(rowOf(workflowId).paused_reason).toBe('manual')
    // Outside the window, but the pause is manual → left alone.
    expect(checkOnce(outside)).toEqual([])
    expect(rowOf(workflowId).paused_at).toBeTruthy()
  })

  it('does not auto-pause a workflow already paused manually inside a window', () => {
    pauseWorkflow(rowOf(workflowId), null, { reason: 'manual' })
    expect(checkOnce(inside)).toEqual([])
    // The manual reason is preserved — the sweep didn't overwrite it.
    expect(rowOf(workflowId).paused_reason).toBe('manual')
  })

  it('emits maintenance activity events for its transitions', () => {
    checkOnce(inside)
    checkOnce(outside)
    const types = db
      .prepare("SELECT event_type FROM activity_events WHERE entity_id = ? ORDER BY rowid")
      .all(workflowId)
      .map((r) => r.event_type)
    expect(types).toContain('workflow.maintenance_started')
    expect(types).toContain('workflow.maintenance_ended')
  })
})

describe('maintenance window settings (PUT)', () => {
  let jwt
  let workflowId
  const authed = (req) => req.set('Authorization', `Bearer ${jwt}`)

  beforeAll(async () => {
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ email: 'maint-put@example.com', password: 'password123', displayName: 'MP' })
    jwt = reg.body.token
    const workspaceId = (await authed(request(app).get('/api/workspaces'))).body.workspaces[0].id
    workflowId = (
      await authed(request(app).post(`/api/workspaces/${workspaceId}/workflows`)).send({ name: 'Cfg' })
    ).body.workflow.id
  })

  it('validates the cron and the both-or-neither rule', async () => {
    const badCron = await authed(request(app).put(`/api/workflows/${workflowId}`)).send({
      name: 'Cfg', maintenance_cron: 'nope', maintenance_duration_minutes: 60,
    })
    expect(badCron.status).toBe(400)

    const onlyCron = await authed(request(app).put(`/api/workflows/${workflowId}`)).send({
      name: 'Cfg', maintenance_cron: '0 2 * * *', maintenance_duration_minutes: null,
    })
    expect(onlyCron.status).toBe(400)
    expect(onlyCron.body.error).toMatch(/set together/)
  })

  it('persists a valid window', async () => {
    const res = await authed(request(app).put(`/api/workflows/${workflowId}`)).send({
      name: 'Cfg', maintenance_cron: '0 2 * * *', maintenance_duration_minutes: 90,
    })
    expect(res.status).toBe(200)
    expect(res.body.workflow.maintenance_cron).toBe('0 2 * * *')
    expect(res.body.workflow.maintenance_duration_minutes).toBe(90)
  })

  it('releases a maintenance pause when the window is cleared', async () => {
    // Put the workflow into a maintenance pause directly.
    db.prepare(
      "UPDATE workflows SET maintenance_cron = '0 2 * * *', maintenance_duration_minutes = 90, paused_at = ?, paused_reason = 'maintenance' WHERE id = ?"
    ).run(new Date().toISOString(), workflowId)

    const res = await authed(request(app).put(`/api/workflows/${workflowId}`)).send({
      name: 'Cfg', maintenance_cron: null, maintenance_duration_minutes: null,
    })
    expect(res.status).toBe(200)
    // The stranded pause is released rather than left forever.
    expect(res.body.workflow.paused_at).toBeNull()
    expect(res.body.workflow.paused_reason).toBeNull()
  })
})
