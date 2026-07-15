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

  it('sticky notes never execute and cannot break the run', async () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('memo', 'note', { text: 'explains the flow', color: 'blue' }),
        node('o1', 'output-log', { message: 'ran' }),
      ],
      edges: [
        edge('t1', 'o1'),
        // Only possible in a hand-edited import — the UI renders notes without
        // handles. The engine must drop it with the note, not choke on it.
        edge('memo', 'o1'),
      ],
    }
    const { execId } = seedWorkflow(graph)
    await runExecution(execId, { publish: () => {} })

    expect(getExecution(execId).status).toBe('completed')
    const steps = getSteps(execId)
    expect(steps.map((s) => s.node_id).sort()).toEqual(['o1', 't1'])
    expect(stepFor(execId, 'o1').status).toBe('succeeded')
  })

  it('feeds the passed-in trigger payload into trigger-node output', async () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-webhook'),
        node('o1', 'output-log', { message: 'hi {{t1.name}}' }),
      ],
      edges: [edge('t1', 'o1')],
    }
    const { execId } = seedWorkflow(graph)
    await runExecution(execId, { payload: { name: 'Ada' }, publish: () => {} })

    expect(JSON.parse(stepFor(execId, 't1').output_json)).toMatchObject({ triggered: true, name: 'Ada' })
    expect(JSON.parse(stepFor(execId, 'o1').output_json)).toEqual({ message: 'hi Ada' })
  })

  it('falls back to the execution row trigger_data when no payload is passed (replay)', async () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-webhook'),
        node('o1', 'output-log', { message: 'order {{t1.order}}' }),
      ],
      edges: [edge('t1', 'o1')],
    }
    const { execId } = seedWorkflow(graph)
    db.prepare('UPDATE executions SET trigger_data = ? WHERE id = ?').run(
      JSON.stringify({ order: 7 }),
      execId
    )
    await runExecution(execId, { publish: () => {} }) // no payload — engine reads the row

    expect(JSON.parse(stepFor(execId, 't1').output_json)).toMatchObject({ order: 7 })
    expect(JSON.parse(stepFor(execId, 'o1').output_json)).toEqual({ message: 'order 7' })
  })

  it('in dry-run mode intercepts side-effecting nodes but runs logic for real', async () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('tr1', 'transform', { template: '{"amount": 42}' }),
        node('c1', 'condition', { left: '{{tr1.amount}}', operator: 'greater_than', right: '10' }),
        // A dead port: a real fetch would throw, so a clean success proves the
        // HTTP call was never made.
        node('h1', 'action-http', { method: 'POST', url: 'http://127.0.0.1:1/', body: 'hi' }),
        node('e1', 'action-email', { to: 'a@b.com', subject: 'Hi', body: 'Body' }),
      ],
      edges: [edge('t1', 'tr1'), edge('tr1', 'c1'), edge('c1', 'h1', 'true'), edge('h1', 'e1')],
    }
    const { execId } = seedWorkflow(graph)
    const events = []
    await runExecution(execId, { dryRun: true, publish: (p) => events.push(p) })

    expect(getExecution(execId).status).toBe('completed')
    // Logic nodes ran for real.
    expect(JSON.parse(stepFor(execId, 'tr1').output_json)).toEqual({ amount: 42 })
    expect(JSON.parse(stepFor(execId, 'c1').output_json)).toEqual({ result: true })
    // Side-effecting nodes were intercepted.
    const httpOut = JSON.parse(stepFor(execId, 'h1').output_json)
    expect(httpOut.dryRun).toBe(true)
    expect(httpOut.wouldHaveSent.url).toBe('http://127.0.0.1:1/')
    expect(JSON.parse(stepFor(execId, 'e1').output_json)).toEqual({
      dryRun: true,
      wouldHaveSent: { to: 'a@b.com', subject: 'Hi', body: 'Body' },
    })
    // Execution-level events advertise the dry run so clients can show the banner.
    expect(events.some((e) => e.kind === 'execution' && e.status === 'running' && e.dryRun === true)).toBe(true)
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

  it('routes a switch down the first matching case and skips the rest', async () => {
    // amount 250 → not "high" (>1000), matches "mid" (>100). Only the mid
    // branch runs; the high, low, and default branches are skipped.
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('sw', 'switch', {
          cases: [
            { label: 'high', expression: 'amount > 1000' },
            { label: 'mid', expression: 'amount > 100' },
            { label: 'low', expression: 'amount >= 0' },
          ],
        }),
        node('bh', 'output-log', { message: 'high' }),
        node('bm', 'output-log', { message: 'mid' }),
        node('bl', 'output-log', { message: 'low' }),
        node('bd', 'output-log', { message: 'default' }),
      ],
      edges: [
        edge('t1', 'sw'),
        edge('sw', 'bh', 'high'),
        edge('sw', 'bm', 'mid'),
        edge('sw', 'bl', 'low'),
        edge('sw', 'bd', 'default'),
      ],
    }
    const { execId } = seedWorkflow(graph)
    await runExecution(execId, { payload: { amount: 250 }, publish: () => {} })

    expect(getExecution(execId).status).toBe('completed')
    expect(JSON.parse(stepFor(execId, 'sw').output_json)).toMatchObject({ result: 'mid', matched: true })
    expect(stepFor(execId, 'bm').status).toBe('succeeded')
    expect(stepFor(execId, 'bh').status).toBe('skipped')
    expect(stepFor(execId, 'bl').status).toBe('skipped')
    expect(stepFor(execId, 'bd').status).toBe('skipped')
  })

  it('routes a switch to the default branch when no case matches', async () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('sw', 'switch', { cases: [{ label: 'positive', expression: 'amount > 0' }] }),
        node('bp', 'output-log', { message: 'positive' }),
        node('bd', 'output-log', { message: 'default' }),
      ],
      edges: [
        edge('t1', 'sw'),
        edge('sw', 'bp', 'positive'),
        edge('sw', 'bd', 'default'),
      ],
    }
    const { execId } = seedWorkflow(graph)
    await runExecution(execId, { payload: { amount: -3 }, publish: () => {} })

    expect(getExecution(execId).status).toBe('completed')
    expect(JSON.parse(stepFor(execId, 'sw').output_json)).toMatchObject({ result: 'default', matched: false })
    expect(stepFor(execId, 'bd').status).toBe('succeeded')
    expect(stepFor(execId, 'bp').status).toBe('skipped')
  })

  it('routes a validate node down the valid / invalid branch', async () => {
    const schema = { type: 'object', required: ['email'], properties: { email: { type: 'string' } } }
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('v', 'validate', { schema: JSON.stringify(schema) }),
        node('okp', 'output-log', { message: 'valid' }),
        node('bad', 'output-log', { message: 'invalid' }),
      ],
      edges: [
        edge('t1', 'v'),
        edge('v', 'okp', 'valid'),
        edge('v', 'bad', 'invalid'),
      ],
    }

    // A payload that matches → the valid branch runs, invalid is skipped.
    const good = seedWorkflow(graph)
    await runExecution(good.execId, { payload: { email: 'a@b.com' }, publish: () => {} })
    expect(getExecution(good.execId).status).toBe('completed')
    expect(JSON.parse(stepFor(good.execId, 'v').output_json)).toMatchObject({ result: 'valid', valid: true })
    expect(stepFor(good.execId, 'okp').status).toBe('succeeded')
    expect(stepFor(good.execId, 'bad').status).toBe('skipped')

    // A payload that doesn't → the invalid branch runs, carrying the errors.
    const badRun = seedWorkflow(graph)
    await runExecution(badRun.execId, { payload: { name: 'no email' }, publish: () => {} })
    expect(JSON.parse(stepFor(badRun.execId, 'v').output_json)).toMatchObject({ result: 'invalid', valid: false })
    expect(stepFor(badRun.execId, 'bad').status).toBe('succeeded')
    expect(stepFor(badRun.execId, 'okp').status).toBe('skipped')
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
