// Per-node error handling: a node's on-error policy decides what an exhausted
// failure does. 'fail' (default) fails the run as before; 'continue' settles
// the error object as the node's output and proceeds down the normal edges;
// 'branch' activates only the edge wired to the node's dedicated 'error'
// handle. Either way the step itself records 'caught' — the node really did
// fail, and the timeline should say so.

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

const getExecution = (execId) => db.prepare('SELECT * FROM executions WHERE id = ?').get(execId)
const getSteps = (execId) =>
  db.prepare('SELECT * FROM execution_steps WHERE execution_id = ? ORDER BY rowid').all(execId)
const stepFor = (execId, nodeId) => getSteps(execId).find((s) => s.node_id === nodeId)

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

// An HTTP node pointed at a closed port fails on every attempt — a
// deterministic failure without external dependencies.
const failingHttp = (id, extra = {}) =>
  node(id, 'action-http', { method: 'GET', url: 'http://127.0.0.1:1/', headers: '{}', ...extra })

describe('on-error policy', () => {
  it('continue: the run completes and downstream receives the error object', async () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        failingHttp('h1', { onError: 'continue' }),
        node('o1', 'output-log', { message: 'failed={{h1.failed}} msg={{h1.error.message}}' }),
      ],
      edges: [edge('t1', 'h1'), edge('h1', 'o1')],
    }
    const { execId } = seedWorkflow(graph)
    await runExecution(execId, { publish: () => {} })

    expect(getExecution(execId).status).toBe('completed')
    const h1 = stepFor(execId, 'h1')
    expect(h1.status).toBe('caught')
    expect(h1.error).toBeTruthy()
    const output = JSON.parse(h1.output_json)
    expect(output.failed).toBe(true)
    expect(output.error.nodeId).toBe('h1')
    expect(output.error.nodeType).toBe('action-http')

    const o1 = stepFor(execId, 'o1')
    expect(o1.status).toBe('succeeded')
    expect(JSON.parse(o1.output_json).message).toMatch(/^failed=true msg=/)
  })

  it('branch: only the error edge activates, the normal edge is skipped', async () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        failingHttp('h1', { onError: 'branch' }),
        node('ok', 'output-log', { message: 'happy path' }),
        node('err', 'output-log', { message: 'caught {{h1.error.message}}' }),
      ],
      edges: [edge('t1', 'h1'), edge('h1', 'ok'), edge('h1', 'err', 'error')],
    }
    const { execId } = seedWorkflow(graph)
    await runExecution(execId, { publish: () => {} })

    expect(getExecution(execId).status).toBe('completed')
    expect(stepFor(execId, 'h1').status).toBe('caught')
    expect(stepFor(execId, 'ok').status).toBe('skipped')
    expect(stepFor(execId, 'err').status).toBe('succeeded')
    expect(JSON.parse(stepFor(execId, 'err').output_json).message).toMatch(/^caught /)
  })

  it('branch: on success the error edge stays dark and the normal edge runs', async () => {
    let hits = 0
    const server = http.createServer((req, res) => {
      hits++
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok": true}')
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port

    try {
      const graph = {
        nodes: [
          node('t1', 'trigger-manual'),
          node('h1', 'action-http', {
            method: 'GET',
            url: `http://127.0.0.1:${port}/`,
            headers: '{}',
            onError: 'branch',
          }),
          node('ok', 'output-log', { message: 'happy path' }),
          node('err', 'output-log', { message: 'caught' }),
        ],
        edges: [edge('t1', 'h1'), edge('h1', 'ok'), edge('h1', 'err', 'error')],
      }
      const { execId } = seedWorkflow(graph)
      await runExecution(execId, { publish: () => {} })

      expect(hits).toBe(1)
      expect(getExecution(execId).status).toBe('completed')
      expect(stepFor(execId, 'h1').status).toBe('succeeded')
      expect(stepFor(execId, 'ok').status).toBe('succeeded')
      expect(stepFor(execId, 'err').status).toBe('skipped')
    } finally {
      server.close()
    }
  })

  it('retries are exhausted before the failure is caught', async () => {
    let hits = 0
    const server = http.createServer((req, res) => {
      hits++
      res.writeHead(500)
      res.end('boom')
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port

    try {
      const graph = {
        nodes: [
          node('t1', 'trigger-manual'),
          node('h1', 'action-http', {
            method: 'GET',
            url: `http://127.0.0.1:${port}/`,
            headers: '{}',
            onError: 'continue',
          }),
          node('o1', 'output-log', { message: 'after' }),
        ],
        edges: [edge('t1', 'h1'), edge('h1', 'o1')],
      }
      const { execId } = seedWorkflow(graph)
      await runExecution(execId, { publish: () => {} })

      // EXEC_MAX_ATTEMPTS defaults to 3 — the catch applies only afterwards.
      expect(hits).toBe(3)
      expect(stepFor(execId, 'h1').status).toBe('caught')
      expect(getExecution(execId).status).toBe('completed')
    } finally {
      server.close()
    }
  })

  it('default policy still fails the run and skips downstream', async () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        failingHttp('h1'),
        node('o1', 'output-log', { message: 'never' }),
      ],
      edges: [edge('t1', 'h1'), edge('h1', 'o1')],
    }
    const { execId } = seedWorkflow(graph)
    await runExecution(execId, { publish: () => {} })

    expect(getExecution(execId).status).toBe('failed')
    expect(stepFor(execId, 'h1').status).toBe('failed')
    expect(stepFor(execId, 'o1').status).toBe('skipped')
  })

  it('branching node types ignore the policy — routing must stay unambiguous', async () => {
    // A condition node with onError set still fails the run when it throws:
    // its edges route on the true/false result, so a caught failure would have
    // no meaningful handle to take.
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('c1', 'condition', { operator: 'expression', expression: '(', onError: 'continue' }),
        node('o1', 'output-log', { message: 'never' }, 'after'),
      ],
      edges: [edge('t1', 'c1'), edge('c1', 'o1', 'true')],
    }
    const { execId } = seedWorkflow(graph)
    await runExecution(execId, { publish: () => {} })

    expect(getExecution(execId).status).toBe('failed')
    expect(stepFor(execId, 'c1').status).toBe('failed')
  })

  it('publishes a caught step event with both output and error', async () => {
    const graph = {
      nodes: [node('t1', 'trigger-manual'), failingHttp('h1', { onError: 'continue' })],
      edges: [edge('t1', 'h1')],
    }
    const { execId } = seedWorkflow(graph)
    const events = []
    await runExecution(execId, { publish: (p) => events.push(p) })

    const caught = events.find((e) => e.kind === 'step' && e.status === 'caught')
    expect(caught).toBeTruthy()
    expect(caught.nodeId).toBe('h1')
    expect(caught.output.failed).toBe(true)
    expect(caught.error).toBeTruthy()
  })

  it('a stale error edge from a fail-policy node never activates', async () => {
    // The author wired an error branch but left the policy at 'fail' (the
    // linter flags this). On success the error edge must stay inactive.
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('tr1', 'transform', { template: '{"ok": true}' }),
        node('err', 'output-log', { message: 'should not run' }),
      ],
      edges: [edge('t1', 'tr1'), edge('tr1', 'err', 'error')],
    }
    const { execId } = seedWorkflow(graph)
    await runExecution(execId, { publish: () => {} })

    expect(getExecution(execId).status).toBe('completed')
    expect(stepFor(execId, 'err').status).toBe('skipped')
  })
})
