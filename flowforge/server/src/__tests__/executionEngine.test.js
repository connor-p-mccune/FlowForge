const http = require('http')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'
process.env.EXEC_RETRY_BASE_MS = '1'

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const { runExecution, resolveTemplates } = require('../services/executionEngine')

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

function getSteps(execId) {
  return db.prepare('SELECT * FROM execution_steps WHERE execution_id = ? ORDER BY rowid').all(execId)
}

function stepFor(execId, nodeId) {
  return getSteps(execId).find((s) => s.node_id === nodeId)
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

describe('resolveTemplates', () => {
  const context = { n1: { value: 42, user: { name: 'Ada' } } }

  it('keeps the referenced type for exact placeholders', () => {
    expect(resolveTemplates('{{n1.value}}', context)).toBe(42)
    expect(resolveTemplates('{{n1.user}}', context)).toEqual({ name: 'Ada' })
  })

  it('interpolates inside larger strings', () => {
    expect(resolveTemplates('Hello {{n1.user.name}}!', context)).toBe('Hello Ada!')
  })

  it('resolves nested objects and leaves non-strings alone', () => {
    expect(resolveTemplates({ a: '{{n1.value}}', b: 7 }, context)).toEqual({ a: 42, b: 7 })
  })

  it('renders missing references as empty string', () => {
    expect(resolveTemplates('x={{nope.field}}', context)).toBe('x=')
  })
})

describe('runExecution', () => {
  it('runs a linear flow and resolves templates between nodes', async () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('tr1', 'transform', { template: '{"greeting": "hello"}' }),
        node('tr2', 'transform', { template: '{"echo": "{{tr1.greeting}} world"}' }),
        node('o1', 'output-log', { message: 'Result: {{tr2.echo}}' }),
      ],
      edges: [edge('t1', 'tr1'), edge('tr1', 'tr2'), edge('tr2', 'o1')],
    }
    const { execId } = seedWorkflow(graph)
    const events = []
    await runExecution(execId, { publish: (p) => events.push(p) })

    expect(getExecution(execId).status).toBe('completed')
    const steps = getSteps(execId)
    expect(steps).toHaveLength(4)
    expect(steps.every((s) => s.status === 'succeeded')).toBe(true)
    expect(JSON.parse(stepFor(execId, 'tr2').output_json)).toEqual({ echo: 'hello world' })
    expect(JSON.parse(stepFor(execId, 'o1').output_json)).toEqual({ message: 'Result: hello world' })

    const kinds = events.map((e) => `${e.kind}:${e.status}`)
    expect(kinds[0]).toBe('execution:running')
    expect(kinds[kinds.length - 1]).toBe('execution:completed')
  })

  it('skips the branch a condition did not take', async () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('c1', 'condition', { left: '5', operator: 'greater_than', right: '3' }),
        node('yes', 'output-log', { message: 'took true' }),
        node('no', 'output-log', { message: 'took false' }),
      ],
      edges: [
        edge('t1', 'c1'),
        edge('c1', 'yes', 'true'),
        edge('c1', 'no', 'false'),
      ],
    }
    const { execId } = seedWorkflow(graph)
    await runExecution(execId, { publish: () => {} })

    expect(getExecution(execId).status).toBe('completed')
    expect(JSON.parse(stepFor(execId, 'c1').output_json)).toEqual({ result: true })
    expect(stepFor(execId, 'yes').status).toBe('succeeded')
    expect(stepFor(execId, 'no').status).toBe('skipped')
  })

  it('fails the execution when the graph has a cycle', async () => {
    const graph = {
      nodes: [node('a', 'transform'), node('b', 'transform')],
      edges: [edge('a', 'b'), edge('b', 'a')],
    }
    const { execId } = seedWorkflow(graph)
    const events = []
    await runExecution(execId, { publish: (p) => events.push(p) })

    expect(getExecution(execId).status).toBe('failed')
    expect(events.some((e) => e.kind === 'execution' && e.status === 'failed' && /cycle/i.test(e.error))).toBe(true)
  })

  it('retries failed nodes with backoff and succeeds when a retry passes', async () => {
    let hits = 0
    const server = http.createServer((req, res) => {
      hits++
      if (hits < 3) {
        res.writeHead(500)
        res.end('boom')
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      }
    })
    await new Promise((resolve) => server.listen(0, resolve))
    const port = server.address().port

    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('h1', 'action-http', { method: 'GET', url: `http://127.0.0.1:${port}/`, headers: '{}' }),
      ],
      edges: [edge('t1', 'h1')],
    }
    const { execId } = seedWorkflow(graph)
    await runExecution(execId, { publish: () => {} })
    server.close()

    expect(hits).toBe(3)
    expect(getExecution(execId).status).toBe('completed')
    const out = JSON.parse(stepFor(execId, 'h1').output_json)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true })
  })

  it('fails after max attempts and skips downstream nodes', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(500)
      res.end('always broken')
    })
    await new Promise((resolve) => server.listen(0, resolve))
    const port = server.address().port

    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('h1', 'action-http', { method: 'GET', url: `http://127.0.0.1:${port}/`, headers: '{}' }),
        node('o1', 'output-log', { message: 'never runs' }),
      ],
      edges: [edge('t1', 'h1'), edge('h1', 'o1')],
    }
    const { execId } = seedWorkflow(graph)
    const events = []
    await runExecution(execId, { publish: (p) => events.push(p) })
    server.close()

    expect(getExecution(execId).status).toBe('failed')
    expect(stepFor(execId, 'h1').status).toBe('failed')
    expect(stepFor(execId, 'h1').error).toMatch(/HTTP 500/)
    expect(stepFor(execId, 'o1').status).toBe('skipped')
  })

  it('merges upstream outputs and passes them through delay nodes', async () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('tr1', 'transform', { template: '{"a": 1}' }),
        node('d1', 'action-delay', { durationMs: 5 }),
        node('o1', 'output-log', {}),
      ],
      edges: [edge('t1', 'tr1'), edge('tr1', 'd1'), edge('d1', 'o1')],
    }
    const { execId } = seedWorkflow(graph)
    await runExecution(execId, { publish: () => {} })

    expect(getExecution(execId).status).toBe('completed')
    const delayOut = JSON.parse(stepFor(execId, 'd1').output_json)
    expect(delayOut.a).toBe(1)
    expect(delayOut.delayedMs).toBe(5)
    const logInput = JSON.parse(stepFor(execId, 'o1').input_json)
    expect(logInput.a).toBe(1)
  })
})
