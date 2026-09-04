// Why didn't it send the email?
//
// The run says completed. The email step says skipped. Everything is green and
// the customer did not get their receipt. Turning that into a sentence needs
// three things this codebase already had and had never joined up: what the run
// did, what gates what, and which way each gate actually went.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const { explainRun, identifiers, display } = require('../services/runExplain')
const { parse } = require('../services/expression')

const n = (id, type, config = {}, label = id) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label, config },
})
const e = (source, target, sourceHandle) => ({
  id: `e-${source}-${target}${sourceHandle || ''}`,
  source,
  target,
  ...(sourceHandle ? { sourceHandle } : {}),
})

let userId
let wsId

beforeAll(() => {
  userId = uuidv4()
  wsId = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, `${userId}@test.com`, 'x', 'T', now)
  db.prepare(
    'INSERT INTO workspaces (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(wsId, 'WS', userId, now, now)
})

// A run recorded exactly as the engine records one: a row per node, with the
// branch it went past settled as `skipped`.
function seedRun(graph, steps, { status = 'completed' } = {}) {
  const workflowId = uuidv4()
  const executionId = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by)
     VALUES (?, ?, 'Orders', ?, 'deployed', ?)`
  ).run(workflowId, wsId, JSON.stringify(graph), userId)
  db.prepare(
    'INSERT INTO executions (id, workflow_id, status, created_at) VALUES (?, ?, ?, ?)'
  ).run(executionId, workflowId, status, now)

  const insert = db.prepare(
    `INSERT INTO execution_steps (id, execution_id, node_id, node_type, status, error, input_json, output_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const s of steps) {
    insert.run(
      uuidv4(),
      executionId,
      s.nodeId,
      graph.nodes.find((x) => x.id === s.nodeId)?.type || null,
      s.status,
      s.error || null,
      s.input === undefined ? null : JSON.stringify(s.input),
      s.output === undefined ? null : JSON.stringify(s.output)
    )
  }
  return { workflowId, executionId }
}

// Risky? true → log; false → charge → email.
const RISK_GRAPH = {
  nodes: [
    n('t', 'trigger-webhook', {}, 'Start'),
    n('risky', 'condition', { operator: 'expression', expression: 'total > 100' }, 'High risk?'),
    n('charge', 'action-http', { method: 'POST', url: 'https://x/y' }, 'Charge card'),
    n('mail', 'action-email', {}, 'Send receipt'),
    n('log', 'output-log', {}, 'Log it'),
  ],
  edges: [e('t', 'risky'), e('risky', 'charge', 'false'), e('charge', 'mail'), e('risky', 'log', 'true')],
}

const riskyRun = (total, result) =>
  seedRun(RISK_GRAPH, [
    { nodeId: 't', status: 'succeeded', output: { total } },
    { nodeId: 'risky', status: 'succeeded', input: { total }, output: { result } },
    { nodeId: 'charge', status: result ? 'skipped' : 'succeeded' },
    { nodeId: 'mail', status: result ? 'skipped' : 'succeeded' },
    { nodeId: 'log', status: result ? 'succeeded' : 'skipped' },
  ])

const stepFor = (report, id) => report.steps.find((s) => s.nodeId === id)

describe('runExplain — why a node did not run', () => {
  it('names the decision that skipped it', () => {
    const { executionId } = riskyRun(850, true)
    const mail = stepFor(explainRun(executionId), 'mail')
    expect(mail.status).toBe('skipped')
    expect(mail.because).toMatchObject({ nodeId: 'risky', label: 'High risk?', outcome: 'true' })
  })

  it('reads the condition out loud, with the value it actually saw', () => {
    // The expression is pure and its scope is the recorded input, so this is
    // read out of the row rather than re-derived.
    const { executionId } = riskyRun(850, true)
    const mail = stepFor(explainRun(executionId), 'mail')
    expect(mail.because.expression).toBe('total > 100')
    expect(mail.because.reads).toEqual([{ path: 'total', value: '850' }])
  })

  it('explains a node two hops behind the gate, not just the one next to it', () => {
    // `Send receipt` is downstream of `Charge card`; both were closed off by
    // the same decision and both deserve the sentence.
    const { executionId } = riskyRun(850, true)
    expect(stepFor(explainRun(executionId), 'charge').because.nodeId).toBe('risky')
    expect(stepFor(explainRun(executionId), 'mail').because.nodeId).toBe('risky')
  })

  it('says nothing about a node that ran', () => {
    const { executionId } = riskyRun(850, true)
    expect(stepFor(explainRun(executionId), 'log')).toMatchObject({ status: 'succeeded' })
    expect(stepFor(explainRun(executionId), 'log').because).toBeUndefined()
  })

  it('follows the other branch when the run took it', () => {
    const { executionId } = riskyRun(10, false)
    const report = explainRun(executionId)
    expect(stepFor(report, 'mail').status).toBe('succeeded')
    expect(stepFor(report, 'log').because).toMatchObject({ outcome: 'false' })
  })

  it('counts what it could not attribute rather than hiding it', () => {
    // A report claiming to explain everything, that quietly does not, is worse
    // than one that says which rows it could not.
    const { executionId } = riskyRun(850, true)
    expect(explainRun(executionId).summary).toMatchObject({ skipped: 2, unexplained: 0 })
  })
})

describe('runExplain — naming the decision, not a decision', () => {
  it('names the deepest gate that closed the path', () => {
    // Two gates in sequence, both of which dominate the node. The one somebody
    // would point at is the last one the run passed.
    const graph = {
      nodes: [
        n('t', 'trigger-webhook', {}, 'Start'),
        n('a', 'condition', { operator: 'expression', expression: 'ok' }, 'First gate'),
        n('b', 'condition', { operator: 'expression', expression: 'also' }, 'Second gate'),
        n('mail', 'action-email', {}, 'Send receipt'),
        n('x', 'output-log', {}, 'A'),
        n('y', 'output-log', {}, 'B'),
      ],
      edges: [
        e('t', 'a'),
        e('a', 'b', 'true'),
        e('a', 'x', 'false'),
        e('b', 'mail', 'true'),
        e('b', 'y', 'false'),
      ],
    }
    const { executionId } = seedRun(graph, [
      { nodeId: 't', status: 'succeeded' },
      { nodeId: 'a', status: 'succeeded', input: { ok: true }, output: { result: true } },
      { nodeId: 'b', status: 'succeeded', input: { also: false }, output: { result: false } },
      { nodeId: 'mail', status: 'skipped' },
      { nodeId: 'x', status: 'skipped' },
      { nodeId: 'y', status: 'succeeded' },
    ])
    const mail = stepFor(explainRun(executionId), 'mail')
    expect(mail.because.label).toBe('Second gate')
    expect(mail.because.outcome).toBe('false')
  })

  it('does not blame a gate the run never settled', () => {
    const { executionId } = seedRun(RISK_GRAPH, [
      { nodeId: 't', status: 'failed', error: 'boom' },
      { nodeId: 'risky', status: 'skipped' },
      { nodeId: 'charge', status: 'skipped' },
      { nodeId: 'mail', status: 'skipped' },
      { nodeId: 'log', status: 'skipped' },
    ])
    const report = explainRun(executionId)
    expect(stepFor(report, 'mail').because.kind).not.toBe('decision')
  })
})

// Three reasons a step does not run. A decision chose against it; something
// above it failed and the run never got there; or somebody stopped the run.
describe('runExplain — the other two reasons', () => {
  it('blames the failure above it when no decision did', () => {
    const { executionId } = seedRun(
      RISK_GRAPH,
      [
        { nodeId: 't', status: 'failed', error: 'the webhook payload was not JSON' },
        { nodeId: 'risky', status: 'skipped' },
        { nodeId: 'charge', status: 'skipped' },
        { nodeId: 'mail', status: 'skipped' },
        { nodeId: 'log', status: 'skipped' },
      ],
      { status: 'failed' }
    )
    const report = explainRun(executionId)
    expect(stepFor(report, 'mail').because).toMatchObject({
      kind: 'upstream-failure',
      nodeId: 't',
      label: 'Start',
      error: 'the webhook payload was not JSON',
    })
    // And nothing is left unattributed.
    expect(report.summary.unexplained).toBe(0)
  })

  it('names the deepest failure, not the first one', () => {
    const { executionId } = seedRun(
      RISK_GRAPH,
      [
        { nodeId: 't', status: 'failed', error: 'first' },
        { nodeId: 'risky', status: 'failed', error: 'second' },
        { nodeId: 'charge', status: 'skipped' },
        { nodeId: 'mail', status: 'skipped' },
        { nodeId: 'log', status: 'skipped' },
      ],
      { status: 'failed' }
    )
    expect(stepFor(explainRun(executionId), 'mail').because.error).toBe('second')
  })

  it('prefers a decision over a failure that did not stop the path', () => {
    // A decision that settled is a *choice*; a failure elsewhere is not what
    // closed this path, and blaming it would send somebody to the wrong node.
    const { executionId } = seedRun(
      RISK_GRAPH,
      [
        { nodeId: 't', status: 'succeeded' },
        { nodeId: 'risky', status: 'succeeded', input: { total: 850 }, output: { result: true } },
        { nodeId: 'log', status: 'failed', error: 'disk full' },
        { nodeId: 'charge', status: 'skipped' },
        { nodeId: 'mail', status: 'skipped' },
      ],
      { status: 'failed' }
    )
    expect(stepFor(explainRun(executionId), 'mail').because).toMatchObject({
      kind: 'decision',
      label: 'High risk?',
    })
  })

  it('does not blame a failure something downstream of it recovered from', () => {
    // Dominance rather than reachability: a node whose failure was caught did
    // not stop anything, and blaming it would point at a step handled on
    // purpose. `log` does not dominate `mail`, so it is never the cause.
    const { executionId } = seedRun(
      RISK_GRAPH,
      [
        { nodeId: 't', status: 'succeeded' },
        { nodeId: 'risky', status: 'succeeded', input: { total: 10 }, output: { result: false } },
        { nodeId: 'charge', status: 'succeeded' },
        { nodeId: 'mail', status: 'succeeded' },
        { nodeId: 'log', status: 'failed', error: 'disk full' },
      ],
      { status: 'failed' }
    )
    const report = explainRun(executionId)
    expect(stepFor(report, 'mail').status).toBe('succeeded')
    expect(stepFor(report, 'mail').because).toBeUndefined()
  })

  it('says a cancelled run was cancelled, which is not a graph fact', () => {
    const { executionId } = seedRun(
      RISK_GRAPH,
      [
        { nodeId: 't', status: 'succeeded' },
        { nodeId: 'risky', status: 'skipped' },
        { nodeId: 'charge', status: 'skipped' },
        { nodeId: 'mail', status: 'skipped' },
        { nodeId: 'log', status: 'skipped' },
      ],
      { status: 'cancelled' }
    )
    const report = explainRun(executionId)
    expect(stepFor(report, 'mail').because).toEqual({ kind: 'cancelled', reads: [] })
    expect(report.summary.unexplained).toBe(0)
  })

  it('still reports what it cannot attribute at all', () => {
    // A run that simply stopped, with nothing failed and nothing cancelled.
    const { executionId } = seedRun(RISK_GRAPH, [
      { nodeId: 't', status: 'succeeded' },
      { nodeId: 'risky', status: 'skipped' },
      { nodeId: 'charge', status: 'skipped' },
      { nodeId: 'mail', status: 'skipped' },
      { nodeId: 'log', status: 'skipped' },
    ])
    expect(explainRun(executionId).summary.unexplained).toBe(4)
  })
})

describe('runExplain — the decisions themselves', () => {
  it('reports which outcome each decision took and which it closed', () => {
    const { executionId } = riskyRun(850, true)
    const decision = explainRun(executionId).decisions[0]
    expect(decision).toMatchObject({ nodeId: 'risky', outcome: 'true', closed: ['false'] })
  })

  it('reports no outcome for a decision that failed', () => {
    const { executionId } = seedRun(RISK_GRAPH, [
      { nodeId: 't', status: 'succeeded' },
      { nodeId: 'risky', status: 'failed', error: 'bad expression' },
      { nodeId: 'charge', status: 'skipped' },
      { nodeId: 'mail', status: 'skipped' },
      { nodeId: 'log', status: 'skipped' },
    ])
    const report = explainRun(executionId)
    expect(report.decisions[0]).toMatchObject({ status: 'failed', outcome: null, closed: [] })
    expect(stepFor(report, 'risky').error).toBe('bad expression')
  })

  it('leaves the operands alone for a left/right comparison', () => {
    // Those are {{…}} templates resolved against a scope spanning every prior
    // node's output, and that scope is not recorded per step. Reconstructing it
    // would be inventing a value and printing it as a fact.
    const graph = {
      nodes: [
        n('t', 'trigger-webhook', {}, 'Start'),
        n('c', 'condition', { operator: 'equals', left: '{{t.status}}', right: 'ok' }, 'Is ok?'),
        n('x', 'output-log', {}, 'A'),
        n('y', 'output-log', {}, 'B'),
      ],
      edges: [e('t', 'c'), e('c', 'x', 'true'), e('c', 'y', 'false')],
    }
    const { executionId } = seedRun(graph, [
      { nodeId: 't', status: 'succeeded' },
      { nodeId: 'c', status: 'succeeded', input: {}, output: { result: true } },
      { nodeId: 'x', status: 'succeeded' },
      { nodeId: 'y', status: 'skipped' },
    ])
    const decision = explainRun(executionId).decisions[0]
    expect(decision.outcome).toBe('true')
    expect(decision.expression).toBeNull()
    expect(decision.reads).toEqual([])
  })
})

describe('runExplain — reading an expression', () => {
  const paths = (source) => identifiers(parse(source))

  it('collects each identifier once, in source order', () => {
    expect(paths('a > 1 && b < 2 && a != 3')).toEqual(['a', 'b'])
  })

  it('collects a dotted path whole', () => {
    expect(paths('order.total > 100')).toEqual(['order.total'])
  })

  it('stops at a computed property rather than naming one it cannot know', () => {
    // `items[i].price` would require evaluating the run again to say which i.
    expect(paths('items[i].price > 10')).toContain('i')
    expect(paths('items[i].price > 10').some((p) => p.includes('price'))).toBe(false)
  })

  it('trims a value rather than dumping it into a panel', () => {
    expect(display('x'.repeat(80))).toMatch(/…"$/)
    expect(display(undefined)).toBe('not set')
    expect(display(null)).toBe('null')
    expect(display(42)).toBe('42')
    expect(display({ a: 1 })).toBe('{"a":1}')
  })

  it('reports a field the input did not have as not set, rather than as false', () => {
    // The difference between "the value was falsy" and "the field was absent"
    // is most of what a 3am investigation is about.
    const { executionId } = seedRun(RISK_GRAPH, [
      { nodeId: 't', status: 'succeeded' },
      { nodeId: 'risky', status: 'succeeded', input: {}, output: { result: false } },
      { nodeId: 'charge', status: 'succeeded' },
      { nodeId: 'mail', status: 'succeeded' },
      { nodeId: 'log', status: 'skipped' },
    ])
    expect(stepFor(explainRun(executionId), 'log').because.reads).toEqual([
      { path: 'total', value: 'not set' },
    ])
  })
})

describe('runExplain — what it refuses', () => {
  it('reports a run it cannot find', () => {
    expect(explainRun(uuidv4())).toEqual({ available: false, reason: 'not-found' })
  })

  it('reports a workflow that has been deleted out from under a run', () => {
    const { workflowId, executionId } = riskyRun(850, true)
    db.prepare('DELETE FROM execution_steps WHERE execution_id = ?').run(executionId)
    db.prepare('PRAGMA foreign_keys = OFF').run()
    db.prepare('DELETE FROM workflows WHERE id = ?').run(workflowId)
    db.prepare('PRAGMA foreign_keys = ON').run()
    expect(explainRun(executionId)).toMatchObject({ available: false, reason: 'workflow-gone' })
  })

  it('reports an empty graph rather than an empty explanation', () => {
    const { executionId } = seedRun({ nodes: [], edges: [] }, [])
    expect(explainRun(executionId)).toMatchObject({ available: false, reason: 'empty' })
  })
})
