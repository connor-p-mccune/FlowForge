// The engine's ready-set scheduler: independent branches run concurrently
// (bounded by EXEC_MAX_PARALLEL), joins wait for every upstream branch, and a
// failure lets in-flight siblings settle before the run fails.

const http = require('http')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'
process.env.EXEC_RETRY_BASE_MS = '1'

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const { runExecution } = require('../services/executionEngine')

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

  const execId = uuidv4()
  db.prepare(
    'INSERT INTO executions (id, workflow_id, status, triggered_by, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(execId, wfId, 'pending', userId, now)
  return { execId, wfId }
}

function getExecution(execId) {
  return db.prepare('SELECT * FROM executions WHERE id = ?').get(execId)
}

function stepFor(execId, nodeId) {
  return db
    .prepare('SELECT * FROM execution_steps WHERE execution_id = ? AND node_id = ?')
    .get(execId, nodeId)
}

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

// A diamond whose two middle branches each delay for `delayMs`.
function diamondGraph(delayMs) {
  return {
    nodes: [
      node('t1', 'trigger-manual'),
      node('a', 'action-delay', { durationMs: delayMs }),
      node('b', 'action-delay', { durationMs: delayMs }),
      node('join', 'output-log', { message: 'done' }),
    ],
    edges: [edge('t1', 'a'), edge('t1', 'b'), edge('a', 'join'), edge('b', 'join')],
  }
}

afterEach(() => {
  delete process.env.EXEC_MAX_PARALLEL
})

describe('parallel execution', () => {
  it('runs both sides of a diamond and merges their outputs at the join', async () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('a', 'transform', { template: '{"left": 1}' }),
        node('b', 'transform', { template: '{"right": 2}' }),
        node('join', 'output-log', { message: '{{a.left}}-{{b.right}}' }),
      ],
      edges: [edge('t1', 'a'), edge('t1', 'b'), edge('a', 'join'), edge('b', 'join')],
    }
    const { execId } = seedWorkflow(graph)
    await runExecution(execId, { publish: () => {} })

    expect(getExecution(execId).status).toBe('completed')
    // The join saw both branches' outputs merged into its input.
    expect(JSON.parse(stepFor(execId, 'join').input_json)).toMatchObject({ left: 1, right: 2 })
    expect(JSON.parse(stepFor(execId, 'join').output_json)).toEqual({ message: '1-2' })
  })

  it('runs independent branches concurrently', async () => {
    const { execId } = seedWorkflow(diamondGraph(150))
    const started = Date.now()
    await runExecution(execId, { publish: () => {} })
    const elapsed = Date.now() - started

    expect(getExecution(execId).status).toBe('completed')
    // Two 150ms delays in parallel finish well under the 300ms a sequential
    // engine would need (generous margin for CI jitter).
    expect(elapsed).toBeLessThan(280)
  })

  it('EXEC_MAX_PARALLEL=1 restores strictly sequential execution', async () => {
    process.env.EXEC_MAX_PARALLEL = '1'
    const { execId } = seedWorkflow(diamondGraph(150))
    const started = Date.now()
    await runExecution(execId, { publish: () => {} })
    const elapsed = Date.now() - started

    expect(getExecution(execId).status).toBe('completed')
    // The two 150ms delays must have run back to back (timers may fire ~ms early).
    expect(elapsed).toBeGreaterThanOrEqual(280)
  })

  it('lets an in-flight sibling finish when the other branch fails, then fails the run', async () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        // Dead port: fails after the retry budget, within a few ms.
        node('broken', 'action-http', { method: 'GET', url: 'http://127.0.0.1:1/', headers: '{}' }),
        node('slow', 'action-delay', { durationMs: 100 }),
        node('after-slow', 'output-log', { message: 'never runs' }),
      ],
      edges: [edge('t1', 'broken'), edge('t1', 'slow'), edge('slow', 'after-slow')],
    }
    const { execId } = seedWorkflow(graph)
    const events = []
    await runExecution(execId, { publish: (p) => events.push(p) })

    expect(getExecution(execId).status).toBe('failed')
    expect(stepFor(execId, 'broken').status).toBe('failed')
    // The delay was already in flight when the HTTP node failed — it settles
    // and records its success rather than being torn down mid-run.
    expect(stepFor(execId, 'slow').status).toBe('succeeded')
    // But nothing new launches after the failure.
    expect(stepFor(execId, 'after-slow').status).toBe('skipped')
    // The run's error names the node that actually failed.
    const failedEvent = events.find((e) => e.kind === 'execution' && e.status === 'failed')
    expect(failedEvent.error).toMatch(/broken/)
  })

  it('caps concurrency at EXEC_MAX_PARALLEL', async () => {
    // Track the peak number of concurrently running delay nodes via a local
    // HTTP server that holds sockets open briefly.
    let active = 0
    let peak = 0
    const server = http.createServer((req, res) => {
      active++
      peak = Math.max(peak, active)
      setTimeout(() => {
        active--
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"ok":true}')
      }, 60)
    })
    await new Promise((resolve) => server.listen(0, resolve))
    const port = server.address().port

    process.env.EXEC_MAX_PARALLEL = '2'
    const httpNode = (id) =>
      node(id, 'action-http', { method: 'GET', url: `http://127.0.0.1:${port}/`, headers: '{}' })
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        httpNode('h1'),
        httpNode('h2'),
        httpNode('h3'),
        httpNode('h4'),
      ],
      edges: [edge('t1', 'h1'), edge('t1', 'h2'), edge('t1', 'h3'), edge('t1', 'h4')],
    }
    const { execId } = seedWorkflow(graph)
    await runExecution(execId, { publish: () => {} })
    server.close()

    expect(getExecution(execId).status).toBe('completed')
    expect(peak).toBeGreaterThanOrEqual(2)
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('cascades skips through nodes whose whole upstream was skipped', async () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('c1', 'condition', { left: '1', operator: 'equals', right: '2' }),
        node('dead1', 'output-log', { message: 'a' }),
        node('dead2', 'output-log', { message: 'b' }),
        node('alive', 'output-log', { message: 'c' }),
      ],
      edges: [
        edge('t1', 'c1'),
        edge('c1', 'dead1', 'true'), // condition is false — this branch is dead
        edge('dead1', 'dead2'),
        edge('c1', 'alive', 'false'),
      ],
    }
    const { execId } = seedWorkflow(graph)
    await runExecution(execId, { publish: () => {} })

    expect(getExecution(execId).status).toBe('completed')
    expect(stepFor(execId, 'dead1').status).toBe('skipped')
    expect(stepFor(execId, 'dead2').status).toBe('skipped')
    expect(stepFor(execId, 'alive').status).toBe('succeeded')
  })
})
