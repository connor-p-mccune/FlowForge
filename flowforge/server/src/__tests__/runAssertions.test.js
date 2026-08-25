// Things that must never happen, checked against every run that does.
//
// Guarantees prove properties of the *graph*; these check properties of runs —
// the ones about data and outcomes that no amount of graph analysis reaches.
// The two states worth the most attention here are the ones a lesser design
// would conflate: an assertion that is holding, and one that has never once
// been evaluated successfully and is therefore claiming nothing at all.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const {
  createAssertion,
  updateAssertion,
  deleteAssertion,
  listAssertions,
  checkRun,
  reportFor,
  MAX_PER_WORKFLOW,
} = require('../services/runAssertions')

const iso = (ms) => new Date(ms).toISOString()
const BASE = Date.parse('2026-08-01T00:00:00.000Z')

let userId
let workflowId

beforeAll(() => {
  userId = uuidv4()
  const wsId = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, `${userId}@test.com`, 'x', 'Test', now)
  db.prepare(
    'INSERT INTO workspaces (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(wsId, 'WS', userId, now, now)
  workflowId = uuidv4()
  db.prepare(
    `INSERT INTO workflows (id, workspace_id, name, graph_json, created_by, created_at, updated_at)
     VALUES (?, ?, 'Orders', '{"nodes":[],"edges":[]}', ?, ?, ?)`
  ).run(workflowId, wsId, userId, now, now)
})

beforeEach(() => {
  db.prepare('DELETE FROM workflow_assertions WHERE workflow_id = ?').run(workflowId)
})

let clock = 0
function seedRun({ status = 'completed', triggerType = null, steps = [], trigger = null } = {}) {
  const id = uuidv4()
  const created = BASE + clock++ * 1000
  db.prepare(
    `INSERT INTO executions (id, workflow_id, status, triggered_by, trigger_type, trigger_data,
                             created_at, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, workflowId, status, userId, triggerType,
    trigger ? JSON.stringify(trigger) : null,
    iso(created), iso(created), iso(created + 1000)
  )
  for (const step of steps) {
    db.prepare(
      `INSERT INTO execution_steps (id, execution_id, node_id, node_type, status, output_json, started_at, finished_at)
       VALUES (?, ?, ?, 'action-http', ?, ?, ?, ?)`
    ).run(
      uuidv4(), id, step.nodeId, step.status || 'succeeded',
      JSON.stringify(step.output || {}), iso(created), iso(created + 100)
    )
  }
  return id
}

const add = (predicate, name = 'never') =>
  createAssertion(workflowId, { name, predicate, createdBy: userId }).assertion

const only = () => reportFor(workflowId).assertions[0]

describe('createAssertion', () => {
  it('stores a valid predicate', () => {
    const result = createAssertion(workflowId, {
      name: 'no failed charge on a completed run',
      predicate: 'status == "completed" and steps.charge.output.status >= 400',
    })
    expect(result.ok).toBe(true)
    expect(result.assertion.enabled).toBe(1)
  })

  it('refuses a predicate that does not parse', () => {
    // The alternative is an assertion that is silently green forever, which is
    // the state this whole design is arranged to make impossible.
    const result = createAssertion(workflowId, { name: 'bad', predicate: 'status ==' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/does not parse/)
  })

  it('requires a name and a predicate', () => {
    expect(createAssertion(workflowId, { predicate: 'true' }).error).toMatch(/name is required/)
    expect(createAssertion(workflowId, { name: 'x' }).error).toMatch(/predicate is required/)
  })

  it('caps how many one workflow may have', () => {
    for (let i = 0; i < MAX_PER_WORKFLOW; i += 1) add('false', `a${i}`)
    const result = createAssertion(workflowId, { name: 'one too many', predicate: 'false' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/at most/)
  })
})

describe('updateAssertion', () => {
  it('resets the counters when the predicate changes', () => {
    // They describe how a *different* predicate behaved. Carrying them over
    // would let a rewritten assertion inherit a clean record it never earned.
    const assertion = add('status == "never-matches"')
    seedRun()
    checkRun(seedRun(), { notify: false })
    expect(only().checked).toBeGreaterThan(0)

    updateAssertion(assertion.id, { predicate: 'status == "something-else"' })
    expect(only().checked).toBe(0)
    expect(only().state).toBe('unchecked')
  })

  it('keeps the counters when only the name changes', () => {
    const assertion = add('status == "never-matches"')
    checkRun(seedRun(), { notify: false })
    const before = only().checked
    updateAssertion(assertion.id, { name: 'renamed' })
    expect(only().checked).toBe(before)
    expect(only().name).toBe('renamed')
  })

  it('refuses an edit that would make the predicate unparseable', () => {
    const assertion = add('false')
    expect(updateAssertion(assertion.id, { predicate: 'status ==' }).ok).toBe(false)
  })

  it('can disable one without deleting it', () => {
    const assertion = add('status == "completed"')
    updateAssertion(assertion.id, { enabled: false })
    checkRun(seedRun(), { notify: false })
    // Disabled means not evaluated at all, so nothing was checked.
    expect(only().checked).toBe(0)
  })
})

describe('deleteAssertion', () => {
  it('removes it', () => {
    const assertion = add('false')
    expect(deleteAssertion(assertion.id)).toBe(true)
    expect(listAssertions(workflowId)).toEqual([])
  })

  it('reports an unknown id rather than pretending', () => {
    expect(deleteAssertion(uuidv4())).toBe(false)
  })
})

describe('checkRun', () => {
  it('holds when the forbidden shape does not occur', () => {
    add('status == "completed" and steps.charge.output.status >= 400')
    checkRun(seedRun({ steps: [{ nodeId: 'charge', output: { status: 200 } }] }), { notify: false })
    expect(only()).toMatchObject({ state: 'holding', checked: 1, violations: 0 })
  })

  it('violates when it does, and names the run', () => {
    add('status == "completed" and steps.charge.output.status >= 400')
    const bad = seedRun({ steps: [{ nodeId: 'charge', output: { status: 502 } }] })
    const transitions = checkRun(bad, { notify: false })

    expect(transitions[0].transition).toBe('violated')
    expect(only()).toMatchObject({
      state: 'violated',
      violations: 1,
      lastViolationExecutionId: bad,
    })
  })

  it('alerts once through a storm, and counts every run', () => {
    // Edge-triggered. A downstream channel gets one incident, not one message
    // per matching run — and the counter records how many there were.
    add('status == "completed"')
    const first = checkRun(seedRun(), { notify: false })
    const second = checkRun(seedRun(), { notify: false })
    const third = checkRun(seedRun(), { notify: false })

    expect(first[0].transition).toBe('violated')
    expect(second[0].transition).toBeNull()
    expect(third[0].transition).toBeNull()
    expect(only().violations).toBe(3)
  })

  it('closes the incident when it holds again', () => {
    // Every open gets a close, so nobody is left with an alert they cannot
    // resolve.
    add('status == "bad"')
    checkRun(seedRun({ status: 'bad' }), { notify: false })
    expect(only().state).toBe('violated')

    const transitions = checkRun(seedRun({ status: 'completed' }), { notify: false })
    expect(transitions[0].transition).toBe('recovered')
    expect(only().state).toBe('holding')
  })

  it('judges every assertion on the workflow', () => {
    add('status == "completed"', 'first')
    add('status == "never"', 'second')
    checkRun(seedRun(), { notify: false })
    const report = reportFor(workflowId)
    expect(report.summary).toMatchObject({ total: 2, violated: 1, holding: 1 })
  })

  it('ignores a dry run, which simulated the steps it would assert about', () => {
    add('status == "completed"')
    checkRun(seedRun({ triggerType: 'dry-run' }), { notify: false })
    expect(only().checked).toBe(0)
  })

  it('does nothing for a workflow with no assertions', () => {
    expect(checkRun(seedRun(), { notify: false })).toEqual([])
  })

  it('does nothing for an unknown run', () => {
    add('true')
    expect(checkRun(uuidv4(), { notify: false })).toEqual([])
  })

  it('sees the same scope the query engine does', () => {
    // A predicate developed with `flowforge query` has to mean exactly the same
    // thing once it is pinned. Anything else would be a trap.
    add('durationMs == 1000 and trigger.order.total > 100')
    checkRun(seedRun({ trigger: { order: { total: 500 } } }), { notify: false })
    expect(only().state).toBe('violated')
  })

  // — broken is not holding ————————————————————————————————————————

  it('calls an assertion that has never evaluated broken, not holding', () => {
    // Zero violations, and reporting that as green is exactly the failure the
    // policy engine exists to avoid.
    add('first(trigger.total) > 0')
    checkRun(seedRun({ trigger: { total: 5 } }), { notify: false })
    checkRun(seedRun({ trigger: { total: 5 } }), { notify: false })

    const report = only()
    expect(report.state).toBe('broken')
    expect(report.errors).toBe(2)
    expect(report.checked).toBe(0)
    expect(report.lastError).toBeTruthy()
    expect(reportFor(workflowId).summary).toMatchObject({ broken: 1, holding: 0 })
  })

  it('counts a partial failure without calling the whole thing broken', () => {
    // Throws on the runs with no items and evaluates on the rest: a real
    // problem, visible in the error count, but the assertion does work.
    add('len(trigger.items) > 2 and first(trigger.items) == "x"')
    checkRun(seedRun({ trigger: { items: ['a'] } }), { notify: false })
    checkRun(seedRun({ trigger: {} }), { notify: false })

    const report = only()
    expect(report.checked).toBeGreaterThan(0)
    expect(report.state).not.toBe('broken')
  })

  it('an error never counts as a violation', () => {
    add('first(trigger.total) > 0')
    checkRun(seedRun({ trigger: { total: 5 } }), { notify: false })
    expect(only().violations).toBe(0)
  })
})

describe('reportFor', () => {
  it('counts broken separately from holding', () => {
    // An assertion nobody can evaluate is a gap in the monitoring, not a clean
    // bill of health, so it never folds into the good number.
    add('status == "never"', 'fine')
    add('first(trigger.total) > 0', 'broken one')
    checkRun(seedRun({ trigger: { total: 5 } }), { notify: false })

    expect(reportFor(workflowId).summary).toMatchObject({
      total: 2, holding: 1, broken: 1, violated: 0, unchecked: 0,
    })
  })

  it('reports an assertion no run has reached yet as unchecked', () => {
    add('status == "never"')
    expect(reportFor(workflowId).summary).toMatchObject({ unchecked: 1, holding: 0 })
  })

  it('is empty for a workflow with none', () => {
    expect(reportFor(uuidv4())).toEqual({
      assertions: [],
      summary: { total: 0, violated: 0, broken: 0, holding: 0, unchecked: 0 },
    })
  })
})

// The engine's terminal hook. This is where assertions actually run in
// production, and the property that matters most is the last one: a broken
// assertion must not be able to fail the run it was watching.
describe('through a real run', () => {
  const { runExecution } = require('../services/executionEngine')

  function seedGraph(graph) {
    const wfId = uuidv4()
    const now = new Date().toISOString()
    const wsId = db.prepare('SELECT workspace_id FROM workflows WHERE id = ?').get(workflowId).workspace_id
    db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, graph_json, created_by, created_at, updated_at)
       VALUES (?, ?, 'Asserted', ?, ?, ?, ?)`
    ).run(wfId, wsId, JSON.stringify(graph), userId, now, now)
    const execId = uuidv4()
    db.prepare(
      'INSERT INTO executions (id, workflow_id, status, triggered_by, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(execId, wfId, 'pending', userId, now)
    return { wfId, execId }
  }

  const GRAPH = {
    nodes: [
      { id: 't1', type: 'trigger-manual', position: { x: 0, y: 0 }, data: { label: 't1', config: {} } },
      {
        id: 'charge', type: 'transform', position: { x: 0, y: 0 },
        data: { label: 'charge', config: { template: '{"status": 502}' } },
      },
    ],
    edges: [{ id: 'e', source: 't1', target: 'charge', sourceHandle: null }],
  }

  it('judges a run as the engine finishes it', async () => {
    const { wfId, execId } = seedGraph(GRAPH)
    createAssertion(wfId, {
      name: 'no 5xx from charge',
      predicate: 'steps.charge.output.status >= 500',
      createdBy: userId,
    })

    await runExecution(execId, { publish: () => {} })

    const report = reportFor(wfId)
    expect(report.summary.violated).toBe(1)
    expect(report.assertions[0].lastViolationExecutionId).toBe(execId)
  })

  it('cannot fail the run it is watching', async () => {
    // The property the whole design is defensive about. A monitor that can
    // break the thing it monitors is worse than no monitor.
    const { wfId, execId } = seedGraph(GRAPH)
    createAssertion(wfId, {
      name: 'throws on every run',
      predicate: 'first(steps.charge.output.status) > 0',
      createdBy: userId,
    })

    await runExecution(execId, { publish: () => {} })

    expect(db.prepare('SELECT status FROM executions WHERE id = ?').get(execId).status)
      .toBe('completed')
    expect(reportFor(wfId).assertions[0].state).toBe('broken')
  })
})
