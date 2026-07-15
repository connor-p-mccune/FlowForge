// Error-handler workflows: a failed real run triggers the workflow designated
// in workflows.error_workflow_id with the failure context as its payload. The
// loop guard (handler runs carry trigger_type 'error-handler', which never
// fires a handler) caps any chain at depth one.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))

const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')
const { triggerErrorHandler } = require('../services/errorHandler')

let token
let userId
let workspaceId

const GRAPH = JSON.stringify({
  nodes: [{ id: 't1', type: 'trigger-manual', data: { label: 'start', config: {} } }],
  edges: [],
})

function seedWorkflow({ name = 'WF', status = 'deployed', errorWorkflowId = null, graph = GRAPH, workspace = workspaceId } = {}) {
  const id = uuidv4()
  db.prepare(
    `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by, error_workflow_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, workspace, name, graph, status, userId, errorWorkflowId)
  return id
}

function seedFailedRun(workflowId, { triggerType = 'manual', withStep = true } = {}) {
  const id = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO executions (id, workflow_id, status, triggered_by, trigger_type, started_at, finished_at, created_at)
     VALUES (?, ?, 'failed', ?, ?, ?, ?, ?)`
  ).run(id, workflowId, userId, triggerType, now, now, now)
  if (withStep) {
    db.prepare(
      `INSERT INTO execution_steps (id, execution_id, node_id, node_type, status, error, started_at, finished_at)
       VALUES (?, ?, 'h1', 'action-http', 'failed', 'HTTP 500: upstream exploded', ?, ?)`
    ).run(uuidv4(), id, now, now)
  }
  return id
}

beforeAll(async () => {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: 'errwf@example.com', password: 'password123', displayName: 'Err' })
  token = res.body.token
  userId = db.prepare('SELECT id FROM users WHERE email = ?').get('errwf@example.com').id
  workspaceId = (await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`))
    .body.workspaces[0].id
})

beforeEach(() => mockAdd.mockClear())

describe('triggerErrorHandler', () => {
  it('enqueues the handler with the failure context as its payload', async () => {
    const handlerId = seedWorkflow({ name: 'Pager' })
    const mainId = seedWorkflow({ name: 'Sync', errorWorkflowId: handlerId })
    const execId = seedFailedRun(mainId)

    const handlerExecId = await triggerErrorHandler(execId)
    expect(handlerExecId).toBeTruthy()

    const row = db.prepare('SELECT * FROM executions WHERE id = ?').get(handlerExecId)
    expect(row.workflow_id).toBe(handlerId)
    expect(row.trigger_type).toBe('error-handler')
    const payload = JSON.parse(row.trigger_data)
    expect(payload).toMatchObject({
      event: 'execution.failed',
      workflowId: mainId,
      workflowName: 'Sync',
      executionId: execId,
      error: { nodeId: 'h1', nodeType: 'action-http', message: 'HTTP 500: upstream exploded' },
    })

    expect(mockAdd).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: handlerExecId, workflowId: handlerId })
    )
  })

  it('reports a pre-node failure honestly when no step failed', async () => {
    const handlerId = seedWorkflow({ name: 'Pager2' })
    const mainId = seedWorkflow({ name: 'Sync2', errorWorkflowId: handlerId })
    const execId = seedFailedRun(mainId, { withStep: false })

    const handlerExecId = await triggerErrorHandler(execId)
    const payload = JSON.parse(
      db.prepare('SELECT trigger_data FROM executions WHERE id = ?').get(handlerExecId).trigger_data
    )
    expect(payload.error.nodeId).toBeNull()
    expect(payload.error.message).toMatch(/before any node executed/)
  })

  it('never cascades: a failed handler run does not fire a handler', async () => {
    const handlerId = seedWorkflow({ name: 'Pager3' })
    // The handler is (mis)configured to handle its own failures.
    db.prepare('UPDATE workflows SET error_workflow_id = ? WHERE id = ?').run(handlerId, handlerId)
    const execId = seedFailedRun(handlerId, { triggerType: 'error-handler' })

    expect(await triggerErrorHandler(execId)).toBeNull()
    expect(mockAdd).not.toHaveBeenCalled()
  })

  it('skips dry runs, non-failed runs, and undeployed or missing handlers', async () => {
    const handlerId = seedWorkflow({ name: 'Pager4', status: 'draft' })
    const mainId = seedWorkflow({ name: 'Sync4', errorWorkflowId: handlerId })

    // Undeployed handler.
    expect(await triggerErrorHandler(seedFailedRun(mainId))).toBeNull()

    // Dry run.
    expect(await triggerErrorHandler(seedFailedRun(mainId, { triggerType: 'dry-run' }))).toBeNull()

    // Run that did not fail.
    const okId = uuidv4()
    db.prepare(
      "INSERT INTO executions (id, workflow_id, status, triggered_by, created_at) VALUES (?, ?, 'completed', ?, ?)"
    ).run(okId, mainId, userId, new Date().toISOString())
    expect(await triggerErrorHandler(okId)).toBeNull()

    // No handler configured at all.
    const plainId = seedWorkflow({ name: 'Plain' })
    expect(await triggerErrorHandler(seedFailedRun(plainId))).toBeNull()

    expect(mockAdd).not.toHaveBeenCalled()
  })

  it('refuses a handler that moved to another workspace', async () => {
    const outsider = await request(app)
      .post('/api/auth/register')
      .send({ email: 'errwf-other@example.com', password: 'password123', displayName: 'Other' })
    const otherWs = (
      await request(app).get('/api/workspaces').set('Authorization', `Bearer ${outsider.body.token}`)
    ).body.workspaces[0].id
    const otherUserId = db.prepare('SELECT id FROM users WHERE email = ?').get('errwf-other@example.com').id

    const foreignHandler = uuidv4()
    db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by)
       VALUES (?, ?, 'Foreign', ?, 'deployed', ?)`
    ).run(foreignHandler, otherWs, GRAPH, otherUserId)

    const mainId = seedWorkflow({ name: 'Sync5', errorWorkflowId: foreignHandler })
    expect(await triggerErrorHandler(seedFailedRun(mainId))).toBeNull()
    expect(mockAdd).not.toHaveBeenCalled()
  })
})

describe('PUT /api/workflows/:id error_workflow_id', () => {
  it('sets, keeps, and clears the handler', async () => {
    const handlerId = seedWorkflow({ name: 'Handler' })
    const mainId = seedWorkflow({ name: 'Main' })

    const set = await request(app)
      .put(`/api/workflows/${mainId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Main', error_workflow_id: handlerId })
    expect(set.status).toBe(200)
    expect(set.body.workflow.error_workflow_id).toBe(handlerId)

    // An update that doesn't mention the field keeps it.
    const keep = await request(app)
      .put(`/api/workflows/${mainId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Main renamed' })
    expect(keep.body.workflow.error_workflow_id).toBe(handlerId)

    const clear = await request(app)
      .put(`/api/workflows/${mainId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Main renamed', error_workflow_id: null })
    expect(clear.body.workflow.error_workflow_id).toBeNull()
  })

  it('400s for self, unknown ids, and other-workspace workflows', async () => {
    const mainId = seedWorkflow({ name: 'Main2' })

    const self = await request(app)
      .put(`/api/workflows/${mainId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Main2', error_workflow_id: mainId })
    expect(self.status).toBe(400)
    expect(self.body.error).toMatch(/own error handler/)

    const unknown = await request(app)
      .put(`/api/workflows/${mainId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Main2', error_workflow_id: uuidv4() })
    expect(unknown.status).toBe(400)
    expect(unknown.body.error).toMatch(/same workspace/)
  })
})
