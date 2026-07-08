process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'
process.env.EXEC_RETRY_BASE_MS = '1'

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
const edge = (source, target) => ({ id: `${source}-${target}`, source, target })

function seedUser() {
  const userId = uuidv4()
  db.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, `${userId}@test.com`, 'x', 'Test', new Date().toISOString())
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
  db.prepare(
    "INSERT INTO executions (id, workflow_id, status, triggered_by, trigger_type, created_at) VALUES (?, ?, 'pending', ?, 'manual', ?)"
  ).run(execId, wfId, userId, new Date().toISOString())
  return execId
}

const getExecution = (id) => db.prepare('SELECT * FROM executions WHERE id = ?').get(id)
const stepFor = (execId, nodeId) =>
  db.prepare('SELECT * FROM execution_steps WHERE execution_id = ? AND node_id = ?').get(execId, nodeId)
const childrenOf = (execId) =>
  db.prepare('SELECT * FROM executions WHERE parent_execution_id = ? ORDER BY rowid').all(execId)

// Echo workflow: passes its trigger payload straight through to a return node,
// so each iteration's output is exactly { item, index, total }.
function echoGraph() {
  return {
    nodes: [node('c-trigger', 'trigger-manual'), node('c-return', 'output-return')],
    edges: [edge('c-trigger', 'c-return')],
  }
}

function parentGraph(targetId, forEachConfig = {}) {
  return {
    nodes: [
      node('p-trigger', 'trigger-manual'),
      node('p-each', 'for-each', { workflowId: targetId, ...forEachConfig }),
    ],
    edges: [edge('p-trigger', 'p-each')],
  }
}

describe('for-each node', () => {
  let userId
  let wsId
  let echoWfId

  beforeAll(() => {
    userId = seedUser()
    wsId = seedWorkspace(userId)
    echoWfId = insertWorkflow(uuidv4(), wsId, userId, echoGraph())
  })

  it('runs the target once per item, in order, and aggregates the results', async () => {
    const parentId = insertWorkflow(
      uuidv4(), wsId, userId,
      parentGraph(echoWfId, { items: '["alpha","beta","gamma"]' })
    )
    const execId = seedExecution(parentId, userId)

    await runExecution(execId, { publish: noop })

    expect(getExecution(execId).status).toBe('completed')
    const out = JSON.parse(stepFor(execId, 'p-each').output_json)
    expect(out).toMatchObject({ count: 3, succeeded: 3, failed: 0 })
    expect(out.results.map((r) => r.item)).toEqual(['alpha', 'beta', 'gamma'])
    expect(out.results.map((r) => r.index)).toEqual([0, 1, 2])
    expect(out.results.every((r) => r.total === 3)).toBe(true)

    // One child execution per item, each linked back to the for-each node.
    const children = childrenOf(execId)
    expect(children).toHaveLength(3)
    expect(children.every((c) => c.parent_node_id === 'p-each')).toBe(true)
    expect(children.every((c) => c.status === 'completed')).toBe(true)
  })

  it('keeps array type when items is an exact template reference to upstream output', async () => {
    const parentId = insertWorkflow(uuidv4(), wsId, userId, {
      nodes: [
        node('p-trigger', 'trigger-manual'),
        node('p-list', 'transform', { template: '{"users": [{"name": "ada"}, {"name": "lin"}]}' }),
        node('p-each', 'for-each', { workflowId: echoWfId, items: '{{p-list.users}}' }),
      ],
      edges: [edge('p-trigger', 'p-list'), edge('p-list', 'p-each')],
    })
    const execId = seedExecution(parentId, userId)

    await runExecution(execId, { publish: noop })

    const out = JSON.parse(stepFor(execId, 'p-each').output_json)
    expect(out.count).toBe(2)
    expect(out.results.map((r) => r.item.name)).toEqual(['ada', 'lin'])
  })

  it('fails the node when items is not an array', async () => {
    const parentId = insertWorkflow(
      uuidv4(), wsId, userId,
      parentGraph(echoWfId, { items: '"not an array"' })
    )
    const execId = seedExecution(parentId, userId)
    await runExecution(execId, { publish: noop })

    expect(getExecution(execId).status).toBe('failed')
    expect(stepFor(execId, 'p-each').error).toMatch(/must be an array/)
  })

  it('enforces the item cap', async () => {
    const big = JSON.stringify(Array.from({ length: 101 }, (_, i) => i))
    const parentId = insertWorkflow(uuidv4(), wsId, userId, parentGraph(echoWfId, { items: big }))
    const execId = seedExecution(parentId, userId)
    await runExecution(execId, { publish: noop })

    expect(getExecution(execId).status).toBe('failed')
    expect(stepFor(execId, 'p-each').error).toMatch(/capped at 100/)
  })

  it('fails fast by default, reporting which item broke', async () => {
    // The middle "item" is a workflow id fed to an inner sub-workflow node —
    // 'missing' resolves to no workflow, so only that iteration fails.
    const dispatchId = uuidv4()
    insertWorkflow(dispatchId, wsId, userId, {
      nodes: [
        node('c-trigger', 'trigger-manual'),
        node('c-sub', 'sub-workflow', { workflowId: '{{c-trigger.item}}' }),
      ],
      edges: [edge('c-trigger', 'c-sub')],
    })
    const items = JSON.stringify([echoWfId, 'missing', echoWfId])
    const parentId = insertWorkflow(uuidv4(), wsId, userId, parentGraph(dispatchId, { items }))
    const execId = seedExecution(parentId, userId)

    await runExecution(execId, { publish: noop })

    expect(getExecution(execId).status).toBe('failed')
    expect(stepFor(execId, 'p-each').error).toMatch(/item 2\/3 failed/)
  })

  it('continueOnError records per-item failures and completes the run', async () => {
    const dispatchId = uuidv4()
    insertWorkflow(dispatchId, wsId, userId, {
      nodes: [
        node('c-trigger', 'trigger-manual'),
        node('c-sub', 'sub-workflow', { workflowId: '{{c-trigger.item}}' }),
      ],
      edges: [edge('c-trigger', 'c-sub')],
    })
    const items = JSON.stringify([echoWfId, 'missing', echoWfId])
    const parentId = insertWorkflow(
      uuidv4(), wsId, userId,
      parentGraph(dispatchId, { items, continueOnError: true })
    )
    const execId = seedExecution(parentId, userId)

    await runExecution(execId, { publish: noop })

    expect(getExecution(execId).status).toBe('completed')
    const out = JSON.parse(stepFor(execId, 'p-each').output_json)
    expect(out).toMatchObject({ count: 3, succeeded: 2, failed: 1 })
    expect(out.results[1]).toBeNull()
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0].index).toBe(1)
  })

  it('rejects a self-referencing loop (cycle guard)', async () => {
    const selfId = uuidv4()
    insertWorkflow(selfId, wsId, userId, parentGraph(selfId, { items: '[1]' }))
    const execId = seedExecution(selfId, userId)
    await runExecution(execId, { publish: noop })

    expect(getExecution(execId).status).toBe('failed')
    expect(stepFor(execId, 'p-each').error).toMatch(/circular/i)
  })

  it('refuses a target outside the parent workspace', async () => {
    const otherWs = seedWorkspace(userId)
    const foreignEcho = insertWorkflow(uuidv4(), otherWs, userId, echoGraph())
    const parentId = insertWorkflow(
      uuidv4(), wsId, userId,
      parentGraph(foreignEcho, { items: '[1]' })
    )
    const execId = seedExecution(parentId, userId)
    await runExecution(execId, { publish: noop })

    expect(getExecution(execId).status).toBe('failed')
    expect(stepFor(execId, 'p-each').error).toMatch(/not found/i)
  })

  it('runs zero items as a successful no-op', async () => {
    const parentId = insertWorkflow(uuidv4(), wsId, userId, parentGraph(echoWfId, { items: '[]' }))
    const execId = seedExecution(parentId, userId)
    await runExecution(execId, { publish: noop })

    expect(getExecution(execId).status).toBe('completed')
    const out = JSON.parse(stepFor(execId, 'p-each').output_json)
    expect(out).toMatchObject({ count: 0, succeeded: 0, failed: 0, results: [] })
  })
})
