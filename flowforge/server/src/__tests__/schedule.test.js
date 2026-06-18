process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

// Keep the real validateCron (so the invalid-cron → 400 path is genuinely
// exercised) but stub the side-effecting functions, so deploy/archive/delete
// never start real cron timers or touch Redis.
jest.mock('../services/scheduler', () => {
  const actual = jest.requireActual('../services/scheduler')
  return {
    ...actual,
    registerSchedule: jest.fn(),
    unregisterSchedule: jest.fn(),
    restoreSchedules: jest.fn(),
  }
})

const request = require('supertest')
const scheduler = require('../services/scheduler')
const { app } = require('../index')

describe('schedule deploy / archive / delete wiring', () => {
  let token
  let workspaceId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'sched@example.com', password: 'password123', displayName: 'Sched' })
    token = res.body.token
    const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`)
    workspaceId = ws.body.workspaces[0].id
  })

  const authed = (req) => req.set('Authorization', `Bearer ${token}`)
  beforeEach(() => jest.clearAllMocks())

  async function createWorkflow(name = 'Sched WF') {
    const res = await authed(
      request(app).post(`/api/workspaces/${workspaceId}/workflows`).send({ name })
    )
    return res.body.workflow
  }
  const saveGraph = (id, graph) =>
    authed(request(app).put(`/api/workflows/${id}/graph`).send(graph))

  const scheduleGraph = (cron) => ({
    nodes: [
      { id: 's1', type: 'trigger-schedule', position: { x: 0, y: 0 }, data: { label: 'Sched', config: { cron } } },
    ],
    edges: [],
  })

  it('deploy marks the workflow deployed and registers the cron', async () => {
    const wf = await createWorkflow()
    await saveGraph(wf.id, scheduleGraph('0 9 * * 1'))

    const deploy = await authed(request(app).post(`/api/workflows/${wf.id}/deploy`))
    expect(deploy.status).toBe(201)
    expect(deploy.body.version.version).toBe(1)
    expect(scheduler.registerSchedule).toHaveBeenCalledWith(wf.id, '0 9 * * 1')

    const reload = await authed(request(app).get(`/api/workflows/${wf.id}`))
    expect(reload.body.workflow.status).toBe('deployed')
  })

  it('rejects deploy with a 400 when the cron is invalid, leaving status untouched', async () => {
    const wf = await createWorkflow()
    await saveGraph(wf.id, scheduleGraph('not-a-cron'))

    const deploy = await authed(request(app).post(`/api/workflows/${wf.id}/deploy`))
    expect(deploy.status).toBe(400)
    expect(deploy.body.error).toMatch(/cron/i)
    expect(scheduler.registerSchedule).not.toHaveBeenCalled()

    const reload = await authed(request(app).get(`/api/workflows/${wf.id}`))
    expect(reload.body.workflow.status).toBe('draft')
  })

  it('deploying a non-schedule workflow clears any stale schedule', async () => {
    const wf = await createWorkflow()
    await saveGraph(wf.id, {
      nodes: [{ id: 'm', type: 'trigger-manual', position: { x: 0, y: 0 }, data: {} }],
      edges: [],
    })

    const deploy = await authed(request(app).post(`/api/workflows/${wf.id}/deploy`))
    expect(deploy.status).toBe(201)
    expect(scheduler.registerSchedule).not.toHaveBeenCalled()
    expect(scheduler.unregisterSchedule).toHaveBeenCalledWith(wf.id)
  })

  it('archive marks the workflow archived and unregisters the schedule', async () => {
    const wf = await createWorkflow()
    await saveGraph(wf.id, scheduleGraph('0 9 * * *'))
    await authed(request(app).post(`/api/workflows/${wf.id}/deploy`))
    jest.clearAllMocks()

    const archive = await authed(request(app).post(`/api/workflows/${wf.id}/archive`))
    expect(archive.status).toBe(200)
    expect(archive.body.workflow.status).toBe('archived')
    expect(scheduler.unregisterSchedule).toHaveBeenCalledWith(wf.id)
  })

  it('delete unregisters the schedule', async () => {
    const wf = await createWorkflow()
    await saveGraph(wf.id, scheduleGraph('0 9 * * *'))
    await authed(request(app).post(`/api/workflows/${wf.id}/deploy`))
    jest.clearAllMocks()

    const del = await authed(request(app).delete(`/api/workflows/${wf.id}`))
    expect(del.status).toBe(204)
    expect(scheduler.unregisterSchedule).toHaveBeenCalledWith(wf.id)
  })

  it('blocks archive for non-members', async () => {
    const wf = await createWorkflow()
    const other = await request(app)
      .post('/api/auth/register')
      .send({ email: 'sched-other@example.com', password: 'password123', displayName: 'Other' })

    const archive = await request(app)
      .post(`/api/workflows/${wf.id}/archive`)
      .set('Authorization', `Bearer ${other.body.token}`)
    expect(archive.status).toBe(404)
    expect(scheduler.unregisterSchedule).not.toHaveBeenCalled()
  })
})
