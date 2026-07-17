// Run priority lanes: the resolution rules, every enqueue path handing Bull
// the right priority, the per-workflow default knob, and the worker re-park
// carrying the lane forward.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))

const { app } = require('../index')
const db = require('../config/database')
const { isValidPriority, resolvePriority, enqueueOpts } = require('../services/runPriority')

describe('runPriority service', () => {
  it('accepts exactly the three lanes', () => {
    expect(isValidPriority('high')).toBe(true)
    expect(isValidPriority('normal')).toBe(true)
    expect(isValidPriority('low')).toBe(true)
    for (const bad of ['urgent', 'HIGH', 1, null, undefined, '']) {
      expect(isValidPriority(bad)).toBe(false)
    }
  })

  it('resolves request > workflow default > normal', () => {
    expect(resolvePriority('low', { default_priority: 'high' })).toBe('low')
    expect(resolvePriority(null, { default_priority: 'high' })).toBe('high')
    expect(resolvePriority(undefined, {})).toBe('normal')
    // A corrupt stored default must not break runs — it falls through.
    expect(resolvePriority(null, { default_priority: 'zzz' })).toBe('normal')
  })

  it('maps lanes to Bull priorities (lower number wins pickup)', () => {
    expect(enqueueOpts('high')).toEqual({ priority: 1 })
    expect(enqueueOpts('normal')).toEqual({ priority: 5 })
    expect(enqueueOpts('low')).toEqual({ priority: 10 })
    expect(enqueueOpts('nonsense')).toEqual({ priority: 5 })
  })
})

describe('priority through the API', () => {
  let jwt
  let workspaceId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'priority@example.com', password: 'password123', displayName: 'Lanes' })
    jwt = res.body.token
    const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${jwt}`)
    workspaceId = ws.body.workspaces[0].id
  })

  beforeEach(() => mockAdd.mockClear())

  async function createWorkflow(name, extra = {}) {
    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/workflows`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ name })
    const workflow = res.body.workflow
    await request(app)
      .put(`/api/workflows/${workflow.id}/graph`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({
        nodes: [{ id: 't1', type: 'trigger-manual', position: { x: 0, y: 0 }, data: { label: 'Go' } }],
        edges: [],
      })
    if (Object.keys(extra).length) {
      await request(app)
        .put(`/api/workflows/${workflow.id}`)
        .set('Authorization', `Bearer ${jwt}`)
        .send({ name, ...extra })
    }
    return workflow
  }

  it('an execute override picks the lane and records it on the run', async () => {
    const workflow = await createWorkflow('Override')
    const res = await request(app)
      .post(`/api/workflows/${workflow.id}/execute`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ priority: 'high' })
    expect(res.status).toBe(202)
    expect(res.body.execution.priority).toBe('high')
    expect(mockAdd).toHaveBeenCalledWith(expect.anything(), { priority: 1 })
  })

  it('rejects an invalid override without enqueuing', async () => {
    const workflow = await createWorkflow('Invalid override')
    const res = await request(app)
      .post(`/api/workflows/${workflow.id}/execute`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ priority: 'urgent' })
    expect(res.status).toBe(400)
    expect(mockAdd).not.toHaveBeenCalled()
  })

  it('falls back to the workflow default lane', async () => {
    const workflow = await createWorkflow('Bulk job', { default_priority: 'low' })
    const res = await request(app)
      .post(`/api/workflows/${workflow.id}/execute`)
      .set('Authorization', `Bearer ${jwt}`)
    expect(res.status).toBe(202)
    expect(res.body.execution.priority).toBe('low')
    expect(mockAdd).toHaveBeenCalledWith(expect.anything(), { priority: 10 })
  })

  it('PUT validates default_priority', async () => {
    const workflow = await createWorkflow('Knob')
    const bad = await request(app)
      .put(`/api/workflows/${workflow.id}`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ name: 'Knob', default_priority: 'sometimes' })
    expect(bad.status).toBe(400)

    const good = await request(app)
      .put(`/api/workflows/${workflow.id}`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ name: 'Knob', default_priority: 'high' })
    expect(good.status).toBe(200)
    expect(good.body.workflow.default_priority).toBe('high')
  })

  it('dry runs always ride the high lane', async () => {
    const workflow = await createWorkflow('Interactive', { default_priority: 'low' })
    const res = await request(app)
      .post(`/api/workflows/${workflow.id}/test`)
      .set('Authorization', `Bearer ${jwt}`)
    expect(res.status).toBe(202)
    expect(res.body.execution.priority).toBe('high')
    expect(mockAdd).toHaveBeenCalledWith(expect.anything(), { priority: 1 })
  })

  it('a replay keeps the original run lane', async () => {
    const workflow = await createWorkflow('Replayable')
    const first = await request(app)
      .post(`/api/workflows/${workflow.id}/execute`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ priority: 'low' })
    mockAdd.mockClear()

    const replay = await request(app)
      .post(`/api/executions/${first.body.execution.id}/replay`)
      .set('Authorization', `Bearer ${jwt}`)
    expect(replay.status).toBe(202)
    expect(replay.body.execution.priority).toBe('low')
    expect(mockAdd).toHaveBeenCalledWith(expect.anything(), { priority: 10 })
  })

  it('the public trigger takes ?priority= and validates it', async () => {
    const workflow = await createWorkflow('Public lanes')
    const minted = await request(app)
      .post('/api/tokens')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ name: 'lanes', scopes: ['trigger'] })
    const pat = minted.body.token

    const res = await request(app)
      .post(`/api/v1/workflows/${workflow.id}/trigger?priority=high`)
      .set('Authorization', `Bearer ${pat}`)
      .send({ n: 1 })
    expect(res.status).toBe(202)
    expect(mockAdd).toHaveBeenCalledWith(expect.anything(), { priority: 1 })
    const row = db.prepare('SELECT priority FROM executions WHERE id = ?').get(res.body.execution.id)
    expect(row.priority).toBe('high')

    mockAdd.mockClear()
    const bad = await request(app)
      .post(`/api/v1/workflows/${workflow.id}/trigger?priority=asap`)
      .set('Authorization', `Bearer ${pat}`)
      .send({ n: 1 })
    expect(bad.status).toBe(400)
    expect(mockAdd).not.toHaveBeenCalled()
  })
})
