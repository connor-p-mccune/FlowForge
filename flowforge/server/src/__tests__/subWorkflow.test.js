const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'
process.env.EXEC_RETRY_BASE_MS = '1'

// The route test requires ../index, which pulls in routes that talk to Bull.
// Mock the queue so nothing touches Redis (mirrors replay.test.js).
const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const { runExecution } = require('../services/executionEngine')

const noop = () => {}

const node = (id, type, config = {}, label = id) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label, config },
})
const edge = (source, target, sourceHandle = null) => ({
  id: `${source}-${target}${sourceHandle ? `-${sourceHandle}` : ''}`,
  source,
  target,
  sourceHandle,
})

function seedUser() {
  const userId = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, `${userId}@test.com`, 'x', 'Test', now)
  return userId
}

function seedWorkspace(userId) {
  const wsId = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO workspaces (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(wsId, 'WS', userId, now, now)
  return wsId
}

// Insert a workflow with a caller-chosen id so a graph can reference its own id
// (needed for the self-reference cycle test). status defaults to 'deployed' since
// a sub-workflow target must be deployed to be callable.
function insertWorkflow(wfId, wsId, userId, graph, status = 'deployed') {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(wfId, wsId, `WF-${wfId.slice(0, 4)}`, JSON.stringify(graph), status, userId, now, now)
  return wfId
}

function seedExecution(wfId, userId) {
  const execId = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO executions (id, workflow_id, status, triggered_by, trigger_type, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(execId, wfId, 'pending', userId, 'manual', now)
  return execId
}

function getExecution(id) {
  return db.prepare('SELECT * FROM executions WHERE id = ?').get(id)
}
function getSteps(execId) {
  return db.prepare('SELECT * FROM execution_steps WHERE execution_id = ? ORDER BY rowid').all(execId)
}
function stepFor(execId, nodeId) {
  return getSteps(execId).find((s) => s.node_id === nodeId)
}
function childOf(parentExecId) {
  return db.prepare('SELECT * FROM executions WHERE parent_execution_id = ? ORDER BY rowid').all(parentExecId)
}

// A deployed "alert" sub-workflow: a trigger pass-through into a return node, so
// its final output is the trigger payload the parent hands in.
function childGraph() {
  return {
    nodes: [node('c-trigger', 'trigger-manual'), node('c-return', 'output-return')],
    edges: [edge('c-trigger', 'c-return')],
  }
}

// A parent that calls `targetId` as a sub-workflow after a manual trigger.
function parentGraph(targetId, targetName = 'Alert') {
  return {
    nodes: [
      node('p-trigger', 'trigger-manual'),
      node('p-sub', 'sub-workflow', { workflowId: targetId, workflowName: targetName }),
    ],
    edges: [edge('p-trigger', 'p-sub')],
  }
}

describe('sub-workflow node — engine', () => {
  it('runs the target workflow and adopts its output (happy path)', async () => {
    const userId = seedUser()
    const wsId = seedWorkspace(userId)
    const childWfId = insertWorkflow(uuidv4(), wsId, userId, childGraph())
    const parentWfId = insertWorkflow(uuidv4(), wsId, userId, parentGraph(childWfId))
    const parentExecId = seedExecution(parentWfId, userId)

    await runExecution(parentExecId, { publish: noop, payload: { msg: 'hello' } })

    expect(getExecution(parentExecId).status).toBe('completed')

    // The sub-workflow node's output is the child's final (return-node) output,
    // which carried the parent's trigger payload through.
    const subOut = JSON.parse(stepFor(parentExecId, 'p-sub').output_json)
    expect(subOut).toMatchObject({ msg: 'hello' })
  })

  it('records a child execution linked back to the parent execution + node', async () => {
    const userId = seedUser()
    const wsId = seedWorkspace(userId)
    const childWfId = insertWorkflow(uuidv4(), wsId, userId, childGraph())
    const parentWfId = insertWorkflow(uuidv4(), wsId, userId, parentGraph(childWfId))
    const parentExecId = seedExecution(parentWfId, userId)

    await runExecution(parentExecId, { publish: noop, payload: { msg: 'hi' } })

    const children = childOf(parentExecId)
    expect(children).toHaveLength(1)
    const child = children[0]
    expect(child.workflow_id).toBe(childWfId)
    expect(child.parent_node_id).toBe('p-sub')
    expect(child.status).toBe('completed')
    expect(child.trigger_type).toBe('sub-workflow')
    expect(JSON.parse(child.trigger_data)).toMatchObject({ msg: 'hi' })

    // The child run wrote its own steps.
    expect(getSteps(child.id).length).toBeGreaterThan(0)
  })

  it('rejects a direct self-reference as a cycle, before creating any child run', async () => {
    const userId = seedUser()
    const wsId = seedWorkspace(userId)
    const selfId = uuidv4()
    // The workflow's sub-workflow node points at its own id.
    insertWorkflow(selfId, wsId, userId, parentGraph(selfId))
    const execId = seedExecution(selfId, userId)

    await runExecution(execId, { publish: noop, payload: {} })

    expect(getExecution(execId).status).toBe('failed')
    expect(stepFor(execId, 'p-sub').error).toMatch(/Circular workflow reference detected/)
    // Cycle guard runs before any INSERT — no child execution row exists.
    expect(childOf(execId)).toHaveLength(0)
  })

  it('detects an indirect P→C→P cycle deeper in the call tree', async () => {
    const userId = seedUser()
    const wsId = seedWorkspace(userId)
    const parentId = uuidv4()
    const childId = uuidv4()
    // P calls C; C calls P.
    insertWorkflow(parentId, wsId, userId, parentGraph(childId))
    insertWorkflow(childId, wsId, userId, parentGraph(parentId))
    const execId = seedExecution(parentId, userId)

    await runExecution(execId, { publish: noop, payload: {} })

    // P fails because C failed; C failed because it hit the cycle guard on P.
    expect(getExecution(execId).status).toBe('failed')
    const children = childOf(execId)
    expect(children).toHaveLength(1)
    const child = children[0]
    expect(child.status).toBe('failed')
    expect(stepFor(child.id, 'p-sub').error).toMatch(/Circular workflow reference detected/)
    // The cycle stopped here — P was never invoked a second time.
    expect(childOf(child.id)).toHaveLength(0)
  })

  it('fails when the target workflow is not deployed', async () => {
    const userId = seedUser()
    const wsId = seedWorkspace(userId)
    const draftId = insertWorkflow(uuidv4(), wsId, userId, childGraph(), 'draft')
    const parentWfId = insertWorkflow(uuidv4(), wsId, userId, parentGraph(draftId))
    const execId = seedExecution(parentWfId, userId)

    await runExecution(execId, { publish: noop, payload: {} })

    expect(getExecution(execId).status).toBe('failed')
    expect(stepFor(execId, 'p-sub').error).toMatch(/not deployed/)
    expect(childOf(execId)).toHaveLength(0)
  })

  it('fails when the target workflow does not exist', async () => {
    const userId = seedUser()
    const wsId = seedWorkspace(userId)
    const parentWfId = insertWorkflow(uuidv4(), wsId, userId, parentGraph(uuidv4()))
    const execId = seedExecution(parentWfId, userId)

    await runExecution(execId, { publish: noop, payload: {} })

    expect(getExecution(execId).status).toBe('failed')
    expect(stepFor(execId, 'p-sub').error).toMatch(/Sub-workflow not found/)
  })

  it('refuses to call a workflow in another workspace', async () => {
    const userId = seedUser()
    const wsA = seedWorkspace(userId)
    const wsB = seedWorkspace(userId)
    const childWfId = insertWorkflow(uuidv4(), wsB, userId, childGraph())
    const parentWfId = insertWorkflow(uuidv4(), wsA, userId, parentGraph(childWfId))
    const execId = seedExecution(parentWfId, userId)

    await runExecution(execId, { publish: noop, payload: {} })

    expect(getExecution(execId).status).toBe('failed')
    expect(stepFor(execId, 'p-sub').error).toMatch(/Sub-workflow not found/)
    expect(childOf(execId)).toHaveLength(0)
  })

  it('returns the output-return node output as the final output', async () => {
    const userId = seedUser()
    const wsId = seedWorkspace(userId)
    const graph = {
      nodes: [
        node('t', 'trigger-manual'),
        node('x', 'transform', { template: '{"fromTransform": true}' }),
        node('r', 'output-return'),
      ],
      edges: [edge('t', 'x'), edge('x', 'r')],
    }
    const wfId = insertWorkflow(uuidv4(), wsId, userId, graph)
    const execId = seedExecution(wfId, userId)

    const out = await runExecution(execId, { publish: noop, payload: { seed: 1 } })
    expect(out).toMatchObject({ fromTransform: true })
  })

  it('falls back to the last node output when there is no output-return node', async () => {
    const userId = seedUser()
    const wsId = seedWorkspace(userId)
    const graph = {
      nodes: [
        node('t', 'trigger-manual'),
        node('x', 'transform', { template: '{"last": "node"}' }),
      ],
      edges: [edge('t', 'x')],
    }
    const wfId = insertWorkflow(uuidv4(), wsId, userId, graph)
    const execId = seedExecution(wfId, userId)

    const out = await runExecution(execId, { publish: noop, payload: {} })
    expect(out).toMatchObject({ last: 'node' })
  })
})

describe('GET /api/executions/:id — child call tree', () => {
  const { app } = require('../index')
  let token
  let workspaceId
  let userId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'subwf-route@example.com', password: 'password123', displayName: 'Sub' })
    token = res.body.token
    userId = res.body.user.id
    const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`)
    workspaceId = ws.body.workspaces[0].id
  })

  it('nests the spawned sub-workflow run under the calling step', async () => {
    const childWfId = insertWorkflow(uuidv4(), workspaceId, userId, childGraph())
    const parentWfId = insertWorkflow(uuidv4(), workspaceId, userId, parentGraph(childWfId))
    const parentExecId = seedExecution(parentWfId, userId)

    await runExecution(parentExecId, { publish: noop, payload: { msg: 'route' } })

    const res = await request(app)
      .get(`/api/executions/${parentExecId}`)
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.steps.length).toBe(2)
    expect(res.body.childExecutions).toHaveLength(1)
    const child = res.body.childExecutions[0]
    expect(child.execution.parent_node_id).toBe('p-sub')
    expect(child.execution.workflow_id).toBe(childWfId)
    expect(child.steps.length).toBeGreaterThan(0)
    expect(Array.isArray(child.childExecutions)).toBe(true)
  })

  it('returns an empty child tree for a run with no sub-workflow nodes', async () => {
    const wfId = insertWorkflow(uuidv4(), workspaceId, userId, {
      nodes: [node('t', 'trigger-manual')],
      edges: [],
    })
    const execId = seedExecution(wfId, userId)
    await runExecution(execId, { publish: noop, payload: {} })

    const res = await request(app)
      .get(`/api/executions/${execId}`)
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.childExecutions).toEqual([])
  })
})
