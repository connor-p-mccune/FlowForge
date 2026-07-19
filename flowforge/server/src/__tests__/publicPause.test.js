// The operational kill switch on the public API:
// POST /api/v1/workflows/:id/pause and .../resume (manage scope). While
// paused, the public trigger is refused; resuming restores it. Read tokens
// can't operate the switch; the paused state surfaces on GET /workflows.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))

const { app } = require('../index')

describe('public pause / resume', () => {
  let jwt
  let manageToken
  let readToken
  let triggerToken
  let workflowId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'pubpause@example.com', password: 'password123', displayName: 'Ops' })
    jwt = res.body.token
    const workspaceId = (
      await request(app).get('/api/workspaces').set('Authorization', `Bearer ${jwt}`)
    ).body.workspaces[0].id
    const wf = await request(app)
      .post(`/api/workspaces/${workspaceId}/workflows`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ name: 'Kill switch' })
    workflowId = wf.body.workflow.id
    await request(app)
      .put(`/api/workflows/${workflowId}/graph`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({
        nodes: [{ id: 't1', type: 'trigger-manual', position: { x: 0, y: 0 }, data: { config: {} } }],
        edges: [],
      })

    const mint = async (scopes) =>
      (
        await request(app)
          .post('/api/tokens')
          .set('Authorization', `Bearer ${jwt}`)
          .send({ name: `t-${scopes.join('-')}`, scopes })
      ).body.token
    manageToken = await mint(['manage', 'read'])
    readToken = await mint(['read'])
    triggerToken = await mint(['trigger', 'read'])
  })

  beforeEach(() => mockAdd.mockClear())

  afterEach(async () => {
    await request(app)
      .post(`/api/v1/workflows/${workflowId}/resume`)
      .set('Authorization', `Bearer ${manageToken}`)
  })

  it('pauses and resumes under the manage scope, idempotently', async () => {
    const paused = await request(app)
      .post(`/api/v1/workflows/${workflowId}/pause`)
      .set('Authorization', `Bearer ${manageToken}`)
    expect(paused.status).toBe(200)
    expect(paused.body).toMatchObject({ workflowId, paused: true })
    expect(paused.body.pausedAt).toBeTruthy()

    // Idempotent — a second pause keeps the same recorded pause instant.
    const again = await request(app)
      .post(`/api/v1/workflows/${workflowId}/pause`)
      .set('Authorization', `Bearer ${manageToken}`)
    expect(again.body.pausedAt).toBe(paused.body.pausedAt)

    const resumed = await request(app)
      .post(`/api/v1/workflows/${workflowId}/resume`)
      .set('Authorization', `Bearer ${manageToken}`)
    expect(resumed.status).toBe(200)
    expect(resumed.body).toMatchObject({ workflowId, paused: false })
  })

  it('refuses new triggers while paused, then accepts them after resume', async () => {
    await request(app)
      .post(`/api/v1/workflows/${workflowId}/pause`)
      .set('Authorization', `Bearer ${manageToken}`)

    const refused = await request(app)
      .post(`/api/v1/workflows/${workflowId}/trigger`)
      .set('Authorization', `Bearer ${triggerToken}`)
      .send({})
    expect(refused.status).toBe(409)
    expect(refused.body.error).toMatch(/paused/)
    expect(mockAdd).not.toHaveBeenCalled()

    await request(app)
      .post(`/api/v1/workflows/${workflowId}/resume`)
      .set('Authorization', `Bearer ${manageToken}`)
    const ok = await request(app)
      .post(`/api/v1/workflows/${workflowId}/trigger`)
      .set('Authorization', `Bearer ${triggerToken}`)
      .send({})
    expect(ok.status).toBe(202)
    expect(mockAdd).toHaveBeenCalledTimes(1)
  })

  it('a read or trigger token cannot operate the switch (manage scope required)', async () => {
    const byRead = await request(app)
      .post(`/api/v1/workflows/${workflowId}/pause`)
      .set('Authorization', `Bearer ${readToken}`)
    expect(byRead.status).toBe(403)
    expect(byRead.body.error).toMatch(/manage/)

    const byTrigger = await request(app)
      .post(`/api/v1/workflows/${workflowId}/pause`)
      .set('Authorization', `Bearer ${triggerToken}`)
    expect(byTrigger.status).toBe(403)
  })

  it('surfaces the paused state on GET /workflows', async () => {
    await request(app)
      .post(`/api/v1/workflows/${workflowId}/pause`)
      .set('Authorization', `Bearer ${manageToken}`)
    const list = await request(app)
      .get('/api/v1/workflows')
      .set('Authorization', `Bearer ${readToken}`)
    const row = list.body.workflows.find((w) => w.id === workflowId)
    expect(row.paused_at).toBeTruthy()
  })
})
