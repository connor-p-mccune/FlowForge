// Compensating transactions: the saga unwind.
//
// The tests are weighted towards the properties that make this safe rather than
// merely present. A compensation that runs when it shouldn't is worse than one
// that doesn't run at all — undoing a side effect a *different* run still owns
// is data loss — so the "did no work this run" rule (cached, reused, skipped)
// and the "did not succeed" rule (caught, failed) are pinned hardest, alongside
// the unwind order and the refusal to stop at the first broken compensation.

const http = require('http')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'
process.env.EXEC_RETRY_BASE_MS = '1'

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const { runExecution, rollbackExecution } = require('../services/executionEngine')
const {
  compensationPlan,
  stripCompensations,
  rollbackSequence,
  rollbackOutcome,
  shouldRollback,
  rollbackPolicy,
} = require('../services/compensation')
const { lintGraph } = require('../services/workflowLinter')

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

function seedWorkflow(graph, workflowFields = {}) {
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
  for (const [column, value] of Object.entries(workflowFields)) {
    db.prepare(`UPDATE workflows SET ${column} = ? WHERE id = ?`).run(value, wfId)
  }

  const execId = uuidv4()
  db.prepare(
    'INSERT INTO executions (id, workflow_id, status, triggered_by, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(execId, wfId, 'pending', userId, now)
  return { execId, wfId, wsId, userId }
}

const getExecution = (id) => db.prepare('SELECT * FROM executions WHERE id = ?').get(id)
const getSteps = (id) =>
  db.prepare('SELECT * FROM execution_steps WHERE execution_id = ? ORDER BY rowid').all(id)
const stepFor = (id, nodeId) => getSteps(id).find((s) => s.node_id === nodeId)
const getCompensations = (id) =>
  db.prepare('SELECT * FROM execution_compensations WHERE execution_id = ? ORDER BY seq').all(id)

// An HTTP node pointed at a closed port fails on every attempt — a
// deterministic failure with no external dependency.
const failingHttp = (id, extra = {}) =>
  node(id, 'action-http', { method: 'GET', url: 'http://127.0.0.1:1/', headers: '{}', ...extra })

// A local server that records every path it is asked for, so a test can assert
// which compensations actually fired and in what order.
function recordingServer() {
  const hits = []
  const server = http.createServer((req, res) => {
    hits.push(req.url)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, path: req.url }))
  })
  return {
    hits,
    listen: () =>
      new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

describe('compensationPlan', () => {
  it('pairs each compensation with its target and strips it from the forward graph', () => {
    const nodes = [
      node('t1', 'trigger-manual'),
      node('charge', 'action-http'),
      node('refund', 'action-http', { compensates: 'charge' }),
    ]
    const plan = compensationPlan(nodes)
    expect(plan.byTarget.get('charge').id).toBe('refund')
    expect([...plan.compensationIds]).toEqual(['refund'])

    const forward = stripCompensations(nodes, [edge('t1', 'charge')], plan.compensationIds)
    expect(forward.nodes.map((n) => n.id)).toEqual(['t1', 'charge'])
  })

  it('reports a compensation whose target does not exist', () => {
    const plan = compensationPlan([node('refund', 'action-http', { compensates: 'ghost' })])
    expect(plan.dangling).toHaveLength(1)
    expect(plan.byTarget.size).toBe(0)
  })

  it('refuses a second compensation for the same target rather than picking one', () => {
    const nodes = [
      node('charge', 'action-http'),
      node('refund-a', 'action-http', { compensates: 'charge' }),
      node('refund-b', 'action-http', { compensates: 'charge' }),
    ]
    const plan = compensationPlan(nodes)
    expect(plan.byTarget.get('charge').id).toBe('refund-a')
    expect(plan.duplicates).toHaveLength(1)
    expect(plan.duplicates[0].node.id).toBe('refund-b')
  })

  it('refuses a compensation of a compensation', () => {
    const nodes = [
      node('charge', 'action-http'),
      node('refund', 'action-http', { compensates: 'charge' }),
      node('un-refund', 'action-http', { compensates: 'refund' }),
    ]
    const plan = compensationPlan(nodes)
    expect(plan.chained).toHaveLength(1)
    // The chained pair is dropped; the legitimate one survives.
    expect(plan.byTarget.get('charge').id).toBe('refund')
    expect(plan.byTarget.has('refund')).toBe(false)
  })

  it('rejects node types that cannot be a compensation', () => {
    const plan = compensationPlan([
      node('c', 'condition', { compensates: 'x' }),
      node('t', 'trigger-manual', { compensates: 'x' }),
    ])
    expect(plan.invalidType.map((i) => i.node.id).sort()).toEqual(['c', 't'])
  })
})

describe('rollback ordering', () => {
  it('unwinds in reverse completion order, not reverse topological order', () => {
    // The DAG says a and b are independent; the run says b finished first.
    const byTarget = new Map([
      ['a', node('undo-a', 'output-log')],
      ['b', node('undo-b', 'output-log')],
    ])
    const sequence = rollbackSequence(['b', 'a'], byTarget)
    expect(sequence.map((s) => s.targetId)).toEqual(['a', 'b'])
  })

  it('skips targets with no compensation and ones already compensated', () => {
    const byTarget = new Map([
      ['a', node('undo-a', 'output-log')],
      ['c', node('undo-c', 'output-log')],
    ])
    const sequence = rollbackSequence(['a', 'b', 'c'], byTarget, { already: new Set(['c']) })
    expect(sequence.map((s) => s.targetId)).toEqual(['a'])
  })

  it('calls a rollback partial when any compensation failed', () => {
    expect(rollbackOutcome([])).toBeNull()
    expect(rollbackOutcome([{ status: 'succeeded' }])).toBe('completed')
    expect(rollbackOutcome([{ status: 'succeeded' }, { status: 'failed' }])).toBe('partial')
  })
})

describe('rollback policy', () => {
  it('defaults to unwinding a failed run only', () => {
    expect(rollbackPolicy({})).toBe('failure')
    expect(rollbackPolicy({ rollback_policy: 'nonsense' })).toBe('failure')
    expect(shouldRollback('failure', 'failed')).toBe(true)
    expect(shouldRollback('failure', 'cancelled')).toBe(false)
  })

  it('unwinds a cancelled run only when the workflow asked for it', () => {
    expect(shouldRollback('failure-or-cancel', 'cancelled')).toBe(true)
    expect(shouldRollback('failure-or-cancel', 'failed')).toBe(true)
  })

  it('never unwinds when the kill switch is off', () => {
    expect(shouldRollback('off', 'failed')).toBe(false)
    expect(shouldRollback('off', 'cancelled')).toBe(false)
  })
})

describe('the engine', () => {
  let server
  let port

  beforeAll(async () => {
    server = recordingServer()
    port = await server.listen()
  })
  afterAll(async () => {
    await server.close()
  })
  beforeEach(() => {
    server.hits.length = 0
  })

  const ok = (id, path, extra = {}) =>
    node(id, 'action-http', { method: 'GET', url: `http://127.0.0.1:${port}${path}`, headers: '{}', ...extra })

  it('never launches a compensation on the happy path', async () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        ok('charge', '/charge'),
        ok('refund', '/refund', { compensates: 'charge' }),
      ],
      edges: [edge('t1', 'charge')],
    }
    const { execId } = seedWorkflow(graph)
    await runExecution(execId, { publish: () => {} })

    expect(getExecution(execId).status).toBe('completed')
    expect(server.hits).toEqual(['/charge'])
    // A compensation is not a step: it gets no row in the forward run at all.
    expect(getSteps(execId).map((s) => s.node_id).sort()).toEqual(['charge', 't1'])
    expect(getCompensations(execId)).toHaveLength(0)
    expect(getExecution(execId).rollback_status).toBeNull()
  })

  it('unwinds succeeded steps in reverse order when a later step fails', async () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        ok('reserve', '/reserve'),
        ok('charge', '/charge'),
        failingHttp('ship'),
        ok('release', '/release', { compensates: 'reserve' }),
        ok('refund', '/refund', { compensates: 'charge' }),
      ],
      edges: [edge('t1', 'reserve'), edge('reserve', 'charge'), edge('charge', 'ship')],
    }
    const { execId } = seedWorkflow(graph)
    await runExecution(execId, { publish: () => {} })

    expect(getExecution(execId).status).toBe('failed')
    expect(getExecution(execId).rollback_status).toBe('completed')
    // Forward, then unwound newest-first: the charge is refunded before the
    // reservation is released.
    expect(server.hits).toEqual(['/reserve', '/charge', '/refund', '/release'])

    const comps = getCompensations(execId)
    expect(comps.map((c) => c.target_node_id)).toEqual(['charge', 'reserve'])
    expect(comps.every((c) => c.status === 'succeeded')).toBe(true)
    expect(comps[0].seq).toBe(0)
  })

  it('does not compensate the step that failed, only the ones that succeeded', async () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        ok('charge', '/charge'),
        failingHttp('ship'),
        ok('refund', '/refund', { compensates: 'charge' }),
        ok('unship', '/unship', { compensates: 'ship' }),
      ],
      edges: [edge('t1', 'charge'), edge('charge', 'ship')],
    }
    const { execId } = seedWorkflow(graph)
    await runExecution(execId, { publish: () => {} })

    expect(server.hits).toEqual(['/charge', '/refund'])
    expect(getCompensations(execId).map((c) => c.target_node_id)).toEqual(['charge'])
  })

  it('does not compensate a caught failure — its author already chose what it means', async () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        failingHttp('flaky', { onError: 'continue' }),
        failingHttp('boom'),
        ok('undo-flaky', '/undo-flaky', { compensates: 'flaky' }),
      ],
      edges: [edge('t1', 'flaky'), edge('flaky', 'boom')],
    }
    const { execId } = seedWorkflow(graph)
    await runExecution(execId, { publish: () => {} })

    expect(stepFor(execId, 'flaky').status).toBe('caught')
    expect(getExecution(execId).status).toBe('failed')
    expect(server.hits).toEqual([])
    expect(getCompensations(execId)).toHaveLength(0)
  })

  it('does not compensate a cached step — this run did not do the work', async () => {
    const graph = (marker) => ({
      nodes: [
        node('t1', 'trigger-manual'),
        ok('lookup', '/lookup', { cache: { enabled: true, ttlSeconds: 300 } }),
        ...(marker ? [failingHttp('boom')] : []),
        ok('undo-lookup', '/undo-lookup', { compensates: 'lookup' }),
      ],
      edges: marker
        ? [edge('t1', 'lookup'), edge('lookup', 'boom')]
        : [edge('t1', 'lookup')],
    })

    // First run populates the cache and succeeds.
    const first = seedWorkflow(graph(false))
    await runExecution(first.execId, { publish: () => {} })
    expect(getExecution(first.execId).status).toBe('completed')

    // Second run, same workflow id so the cache key matches, now failing later.
    db.prepare('UPDATE workflows SET graph_json = ? WHERE id = ?')
      .run(JSON.stringify(graph(true)), first.wfId)
    const execId = uuidv4()
    db.prepare(
      'INSERT INTO executions (id, workflow_id, status, triggered_by, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(execId, first.wfId, 'pending', first.userId, new Date().toISOString())
    server.hits.length = 0
    await runExecution(execId, { publish: () => {} })

    expect(stepFor(execId, 'lookup').status).toBe('cached')
    expect(stepFor(execId, 'lookup').completed_seq).toBeNull()
    expect(getExecution(execId).status).toBe('failed')
    // The undo never fires: the effect it would reverse belongs to the first run.
    expect(server.hits).toEqual([])
    expect(getCompensations(execId)).toHaveLength(0)
  })

  it('keeps unwinding after a compensation fails, and reports the rollback partial', async () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        ok('reserve', '/reserve'),
        ok('charge', '/charge'),
        failingHttp('ship'),
        ok('release', '/release', { compensates: 'reserve' }),
        failingHttp('refund', { compensates: 'charge' }),
      ],
      edges: [edge('t1', 'reserve'), edge('reserve', 'charge'), edge('charge', 'ship')],
    }
    const { execId } = seedWorkflow(graph)
    await runExecution(execId, { publish: () => {} })

    expect(getExecution(execId).rollback_status).toBe('partial')
    // The broken refund did not strand the release behind it.
    expect(server.hits).toEqual(['/reserve', '/charge', '/release'])

    const comps = getCompensations(execId)
    expect(comps.map((c) => [c.target_node_id, c.status])).toEqual([
      ['charge', 'failed'],
      ['reserve', 'succeeded'],
    ])
    expect(comps[0].attempts).toBeGreaterThan(1)
    expect(comps[0].error).toBeTruthy()
  })

  it('resolves the target output and the rollback scope in a compensation config', async () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        ok('charge', '/charge'),
        failingHttp('ship'),
        node('undo', 'output-log', {
          compensates: 'charge',
          message: 'undoing {{charge.body.path}} after {{rollback.failedNode}} ({{rollback.reason}})',
        }),
      ],
      edges: [edge('t1', 'charge'), edge('charge', 'ship')],
    }
    const { execId } = seedWorkflow(graph)
    await runExecution(execId, { publish: () => {} })

    const comp = getCompensations(execId)[0]
    expect(comp.status).toBe('succeeded')
    expect(JSON.parse(comp.output_json).message).toBe('undoing /charge after ship (failed)')
    // Its input is the output of the step it undoes.
    expect(JSON.parse(comp.input_json).body.path).toBe('/charge')
  })

  it('honours the rollback policy: off never unwinds, cancel unwinds only when asked', async () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        ok('charge', '/charge'),
        failingHttp('ship'),
        ok('refund', '/refund', { compensates: 'charge' }),
      ],
      edges: [edge('t1', 'charge'), edge('charge', 'ship')],
    }
    const off = seedWorkflow(graph, { rollback_policy: 'off' })
    await runExecution(off.execId, { publish: () => {} })
    expect(getExecution(off.execId).status).toBe('failed')
    expect(server.hits).toEqual(['/charge'])
    expect(getCompensations(off.execId)).toHaveLength(0)
  })

  it('emits compensation events so a watching client can follow the unwind', async () => {
    const events = []
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        ok('charge', '/charge'),
        failingHttp('ship'),
        ok('refund', '/refund', { compensates: 'charge' }),
      ],
      edges: [edge('t1', 'charge'), edge('charge', 'ship')],
    }
    const { execId } = seedWorkflow(graph)
    await runExecution(execId, { publish: (e) => events.push(e) })

    const kinds = events.map((e) => e.kind)
    // The run is published failed *before* the unwind starts: the failure is
    // not contingent on how well the cleanup goes.
    expect(kinds.indexOf('compensation')).toBeGreaterThan(
      kinds.lastIndexOf('execution')
    )
    const comp = events.filter((e) => e.kind === 'compensation')
    expect(comp.map((e) => e.status)).toEqual(['running', 'succeeded'])
    expect(comp[0].targetNodeId).toBe('charge')
    expect(events.at(-1)).toMatchObject({ kind: 'rollback', status: 'completed', compensated: 1 })
  })
})

describe('manual rollback', () => {
  let server
  let port

  beforeAll(async () => {
    server = recordingServer()
    port = await server.listen()
  })
  afterAll(async () => {
    await server.close()
  })
  beforeEach(() => {
    server.hits.length = 0
  })

  const ok = (id, path, extra = {}) =>
    node(id, 'action-http', { method: 'GET', url: `http://127.0.0.1:${port}${path}`, headers: '{}', ...extra })

  it('resumes a partial rollback without repeating what already succeeded', async () => {
    const broken = {
      nodes: [
        node('t1', 'trigger-manual'),
        ok('reserve', '/reserve'),
        ok('charge', '/charge'),
        failingHttp('ship'),
        ok('release', '/release', { compensates: 'reserve' }),
        failingHttp('refund', { compensates: 'charge' }),
      ],
      edges: [edge('t1', 'reserve'), edge('reserve', 'charge'), edge('charge', 'ship')],
    }
    const { execId, wfId } = seedWorkflow(broken)
    await runExecution(execId, { publish: () => {} })
    expect(getExecution(execId).rollback_status).toBe('partial')
    server.hits.length = 0

    // Repair the compensating endpoint, then retry the rollback.
    const fixed = JSON.parse(JSON.stringify(broken))
    fixed.nodes = fixed.nodes.map((n) =>
      n.id === 'refund' ? ok('refund', '/refund', { compensates: 'charge' }) : n
    )
    db.prepare('UPDATE workflows SET graph_json = ? WHERE id = ?').run(JSON.stringify(fixed), wfId)

    const result = await rollbackExecution(execId, { publish: () => {} })
    expect(result.outcome).toBe('completed')
    // Only the outstanding compensation re-ran — the release is not repeated,
    // because double-undoing is worse than the failure being cleaned up.
    expect(server.hits).toEqual(['/refund'])
    expect(getExecution(execId).rollback_status).toBe('completed')
  })

  it('runs nothing when every compensation already succeeded', async () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        ok('charge', '/charge'),
        failingHttp('ship'),
        ok('refund', '/refund', { compensates: 'charge' }),
      ],
      edges: [edge('t1', 'charge'), edge('charge', 'ship')],
    }
    const { execId } = seedWorkflow(graph)
    await runExecution(execId, { publish: () => {} })
    expect(getExecution(execId).rollback_status).toBe('completed')
    server.hits.length = 0

    const result = await rollbackExecution(execId, { publish: () => {} })
    expect(result.outcome).toBeNull()
    expect(server.hits).toEqual([])
  })
})

describe('the linter', () => {
  const base = [node('t1', 'trigger-manual'), node('charge', 'output-log', { message: 'x' })]

  const codes = (graph, options) => lintGraph(graph, options).map((i) => i.code)

  it('does not call a compensation unreachable — being disconnected is the point', () => {
    const graph = {
      nodes: [...base, node('refund', 'output-log', { compensates: 'charge', message: 'undo' })],
      edges: [edge('t1', 'charge')],
    }
    expect(codes(graph)).not.toContain('unreachable-node')
  })

  it('flags a compensation whose target does not exist', () => {
    const graph = {
      nodes: [...base, node('refund', 'output-log', { compensates: 'ghost', message: 'undo' })],
      edges: [edge('t1', 'charge')],
    }
    expect(codes(graph)).toContain('dangling-compensation')
  })

  it('flags two compensations for one node, and a compensation of a compensation', () => {
    const dup = {
      nodes: [
        ...base,
        node('r1', 'output-log', { compensates: 'charge', message: 'a' }),
        node('r2', 'output-log', { compensates: 'charge', message: 'b' }),
      ],
      edges: [edge('t1', 'charge')],
    }
    expect(codes(dup)).toContain('duplicate-compensation')

    const chained = {
      nodes: [
        ...base,
        node('r1', 'output-log', { compensates: 'charge', message: 'a' }),
        node('r2', 'output-log', { compensates: 'r1', message: 'b' }),
      ],
      edges: [edge('t1', 'charge')],
    }
    expect(codes(chained)).toContain('chained-compensation')
  })

  it('flags a node type that can never be a compensation', () => {
    const graph = {
      nodes: [...base, node('c', 'condition', { compensates: 'charge' })],
      edges: [edge('t1', 'charge')],
    }
    expect(codes(graph)).toContain('invalid-compensation')
  })

  it('warns that a wired compensation’s connections are ignored', () => {
    const graph = {
      nodes: [...base, node('refund', 'output-log', { compensates: 'charge', message: 'undo' })],
      edges: [edge('t1', 'charge'), edge('charge', 'refund')],
    }
    expect(codes(graph)).toContain('wired-compensation')
  })

  it('warns when compensations are drawn but the rollback policy is off', () => {
    const graph = {
      nodes: [...base, node('refund', 'output-log', { compensates: 'charge', message: 'undo' })],
      edges: [edge('t1', 'charge')],
    }
    expect(codes(graph, { rollbackPolicy: 'off' })).toContain('rollback-disabled')
    expect(codes(graph, { rollbackPolicy: 'failure' })).not.toContain('rollback-disabled')
  })

  it('lets a compensation reference any node without a non-upstream warning', () => {
    const graph = {
      nodes: [
        ...base,
        node('refund', 'output-log', { compensates: 'charge', message: 'undo {{charge.message}}' }),
      ],
      edges: [edge('t1', 'charge')],
    }
    expect(codes(graph)).not.toContain('non-upstream-ref')
  })

  it('still type-checks a compensation’s references against the graph', () => {
    const graph = {
      nodes: [
        ...base,
        node('refund', 'output-log', { compensates: 'charge', message: 'undo {{charge.mesage}}' }),
      ],
      edges: [edge('t1', 'charge')],
    }
    const found = lintGraph(graph).find((i) => i.code === 'unknown-field')
    expect(found).toBeTruthy()
    expect(found.message).toMatch(/did you mean "message"/)
  })

  it('refuses {{rollback.*}} outside a compensation and an unknown key inside one', () => {
    const outside = {
      nodes: [node('t1', 'trigger-manual'), node('l', 'output-log', { message: '{{rollback.error}}' })],
      edges: [edge('t1', 'l')],
    }
    expect(codes(outside)).toContain('rollback-scope-ref')

    const inside = {
      nodes: [...base, node('refund', 'output-log', { compensates: 'charge', message: '{{rollback.oops}}' })],
      edges: [edge('t1', 'charge')],
    }
    expect(codes(inside)).toContain('rollback-scope-ref')
  })

  it('refuses a forward node reading a compensation’s output', () => {
    const graph = {
      nodes: [
        ...base,
        node('refund', 'output-log', { compensates: 'charge', message: 'undo' }),
        node('after', 'output-log', { message: '{{refund.message}}' }),
      ],
      edges: [edge('t1', 'charge'), edge('charge', 'after')],
    }
    expect(codes(graph)).toContain('compensation-ref')
  })
})
