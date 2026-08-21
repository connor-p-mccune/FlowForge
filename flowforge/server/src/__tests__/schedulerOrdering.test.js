// The engine's launch order, end to end.
//
// nodePriority.test.js proves the rule is right in simulation; this proves the
// engine actually applies it. The observable is execution_steps.completed_seq —
// the column the rollback pass already relies on, stamped the moment a runner
// returns — so with EXEC_MAX_PARALLEL=1 it is exactly the launch order.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'
process.env.EXEC_RETRY_BASE_MS = '1'

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const { runExecution } = require('../services/executionEngine')
const stepTimings = require('../services/stepTimings')

const node = (id, type, config = {}) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label: id, config },
})
const edge = (source, target) => ({ id: `${source}-${target}`, source, target })

// A trigger fanning out to two quick nodes and one slow one, with the slow one
// declared last — how somebody who added it later would have drawn it, and the
// exact case where declaration order costs a run its duration.
const FAN_OUT = {
  nodes: [
    node('t1', 'trigger-manual'),
    node('fast-a', 'output-log', { message: 'a' }),
    node('fast-b', 'output-log', { message: 'b' }),
    node('slow', 'output-log', { message: 'slow' }),
  ],
  edges: [edge('t1', 'fast-a'), edge('t1', 'fast-b'), edge('t1', 'slow')],
}

function seedWorkflow(graph) {
  const userId = uuidv4()
  const wsId = uuidv4()
  const wfId = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, `${userId}@test.com`, 'x', 'Test', now)
  db.prepare(
    'INSERT INTO workspaces (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(wsId, 'WS', userId, now, now)
  db.prepare(
    'INSERT INTO workflows (id, workspace_id, name, graph_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(wfId, wsId, 'WF', JSON.stringify(graph), userId, now, now)
  return { userId, wfId }
}

// A completed historical run whose step durations are `{ nodeId: ms }`. This is
// the sample expectedDurations() reads: succeeded steps of completed, non-dry
// runs.
function seedHistory(wfId, userId, durations) {
  const execId = uuidv4()
  const base = Date.parse('2026-01-01T00:00:00.000Z')
  const iso = (ms) => new Date(base + ms).toISOString()
  db.prepare(
    `INSERT INTO executions (id, workflow_id, status, triggered_by, started_at, finished_at, created_at)
     VALUES (?, ?, 'completed', ?, ?, ?, ?)`
  ).run(execId, wfId, userId, iso(0), iso(5000), iso(0))
  for (const [nodeId, ms] of Object.entries(durations)) {
    db.prepare(
      `INSERT INTO execution_steps (id, execution_id, node_id, node_type, status, started_at, finished_at)
       VALUES (?, ?, ?, 'output-log', 'succeeded', ?, ?)`
    ).run(uuidv4(), execId, nodeId, iso(0), iso(ms))
  }
}

function queueRun(wfId, userId) {
  const execId = uuidv4()
  db.prepare(
    'INSERT INTO executions (id, workflow_id, status, triggered_by, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(execId, wfId, 'pending', userId, new Date().toISOString())
  return execId
}

// Node ids in the order their runners returned.
function launchOrder(execId) {
  return db
    .prepare(
      `SELECT node_id FROM execution_steps
       WHERE execution_id = ? AND completed_seq IS NOT NULL
       ORDER BY completed_seq`
    )
    .all(execId)
    .map((r) => r.node_id)
}

beforeEach(() => {
  stepTimings.resetCache()
  process.env.EXEC_MAX_PARALLEL = '1'
})

afterEach(() => {
  delete process.env.EXEC_MAX_PARALLEL
  delete process.env.EXEC_SCHEDULER
  stepTimings.resetCache()
})

describe('launch order', () => {
  it('starts the slowest branch first, though it is declared last', async () => {
    const { userId, wfId } = seedWorkflow(FAN_OUT)
    seedHistory(wfId, userId, { 't1': 1, 'fast-a': 10, 'fast-b': 10, slow: 900 })

    const execId = queueRun(wfId, userId)
    await runExecution(execId, { publish: () => {} })

    expect(db.prepare('SELECT status FROM executions WHERE id = ?').get(execId).status).toBe('completed')
    expect(launchOrder(execId)).toEqual(['t1', 'slow', 'fast-a', 'fast-b'])
  })

  it('EXEC_SCHEDULER=topological restores declaration order exactly', async () => {
    process.env.EXEC_SCHEDULER = 'topological'
    const { userId, wfId } = seedWorkflow(FAN_OUT)
    seedHistory(wfId, userId, { 't1': 1, 'fast-a': 10, 'fast-b': 10, slow: 900 })

    const execId = queueRun(wfId, userId)
    await runExecution(execId, { publish: () => {} })

    expect(launchOrder(execId)).toEqual(['t1', 'fast-a', 'fast-b', 'slow'])
  })

  it('falls back to declaration order when the workflow has no history', async () => {
    // Every weight is equal, so the rank is the node's height — and the three
    // leaves are all height 1, which leaves the topological tie-break in charge.
    const { userId, wfId } = seedWorkflow(FAN_OUT)
    const execId = queueRun(wfId, userId)
    await runExecution(execId, { publish: () => {} })

    expect(launchOrder(execId)).toEqual(['t1', 'fast-a', 'fast-b', 'slow'])
  })

  it('prefers the deeper chain over a leaf when nothing has history', async () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('leaf', 'output-log', { message: 'leaf' }),
        node('chain-1', 'output-log', { message: '1' }),
        node('chain-2', 'output-log', { message: '2' }),
      ],
      edges: [edge('t1', 'leaf'), edge('t1', 'chain-1'), edge('chain-1', 'chain-2')],
    }
    const { userId, wfId } = seedWorkflow(graph)
    const execId = queueRun(wfId, userId)
    await runExecution(execId, { publish: () => {} })

    // `leaf` is declared first, but `chain-1` has two nodes' worth of work
    // behind it and the run cannot finish until that chain does.
    const order = launchOrder(execId)
    expect(order.indexOf('chain-1')).toBeLessThan(order.indexOf('leaf'))
    // The next decision is a genuine tie — one node of remaining work either
    // way — so it falls to the topological tie-break and `leaf` (declared
    // first) goes ahead of `chain-2`. Pinned because a tie resolving
    // arbitrarily is how a schedule stops being reproducible.
    expect(order).toEqual(['t1', 'chain-1', 'leaf', 'chain-2'])
  })
})

describe('launch order is semantically inert', () => {
  it('produces the same statuses and outputs under either ordering', async () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('c1', 'condition', { left: '1', operator: 'equals', right: '2' }),
        node('dead', 'output-log', { message: 'dead' }),
        node('alive', 'output-log', { message: 'alive' }),
        node('tail', 'output-log', { message: 'tail' }),
      ],
      edges: [
        { id: 'e1', source: 't1', target: 'c1' },
        { id: 'e2', source: 'c1', target: 'dead', sourceHandle: 'true' },
        { id: 'e3', source: 'c1', target: 'alive', sourceHandle: 'false' },
        { id: 'e4', source: 'alive', target: 'tail' },
      ],
    }
    const snapshot = async (ordering) => {
      if (ordering) process.env.EXEC_SCHEDULER = ordering
      else delete process.env.EXEC_SCHEDULER
      stepTimings.resetCache()
      const { userId, wfId } = seedWorkflow(graph)
      const execId = queueRun(wfId, userId)
      await runExecution(execId, { publish: () => {} })
      return db
        .prepare(
          'SELECT node_id, status, output_json FROM execution_steps WHERE execution_id = ? ORDER BY node_id'
        )
        .all(execId)
    }

    expect(await snapshot('critical-path')).toEqual(await snapshot('topological'))
  })

  it('does not consult step history when the graph cannot fill the cap', async () => {
    process.env.EXEC_MAX_PARALLEL = '8'
    const spy = jest.spyOn(stepTimings, 'expectedDurations')
    const { userId, wfId } = seedWorkflow(FAN_OUT)
    const execId = queueRun(wfId, userId)
    await runExecution(execId, { publish: () => {} })

    // Four nodes, eight slots: the ready set can never outgrow the capacity, so
    // there is never a choice to make and the query is skipped entirely.
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
