// Querying run history with FXL.
//
// The guarantee the whole design rests on is that **the SQL is only ever an
// optimisation**: every conjunct is evaluated by FXL regardless of whether it
// was pushed, so a pushdown bug can cost speed and can never change the answer.
// Most of these tests are about that — in particular the cases where FXL's
// coercion rules and SQL's three-valued logic disagree, and a naive planner
// would quietly drop rows.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const { compile } = require('../services/expression')
const { queryRuns, planQuery, scopeFor } = require('../services/runQuery')

const iso = (ms) => new Date(ms).toISOString()
const BASE = Date.parse('2026-08-01T00:00:00.000Z')

let userId
let workflowId

beforeAll(() => {
  userId = uuidv4()
  const wsId = uuidv4()
  workflowId = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, `${userId}@test.com`, 'x', 'Test', now)
  db.prepare(
    'INSERT INTO workspaces (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(wsId, 'WS', userId, now, now)
  db.prepare(
    `INSERT INTO workflows (id, workspace_id, name, graph_json, created_by, created_at, updated_at)
     VALUES (?, ?, 'Orders', '{"nodes":[],"edges":[]}', ?, ?, ?)`
  ).run(workflowId, wsId, userId, now, now)
})

function seedRun({
  status = 'completed',
  offsetMs = 0,
  waitMs = 0,
  durationMs = 1000,
  trigger = null,
  priority = null,
  triggerType = null,
  steps = [],
  finished = true,
} = {}) {
  const id = uuidv4()
  const created = BASE + offsetMs
  const started = created + waitMs
  db.prepare(
    `INSERT INTO executions (id, workflow_id, status, triggered_by, trigger_type, priority,
                             trigger_data, created_at, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, workflowId, status, userId, triggerType, priority,
    trigger ? JSON.stringify(trigger) : null,
    iso(created), iso(started), finished ? iso(started + durationMs) : null
  )
  for (const step of steps) {
    db.prepare(
      `INSERT INTO execution_steps (id, execution_id, node_id, node_type, status, input_json, output_json, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      uuidv4(), id, step.nodeId, step.type || 'action-http', step.status || 'succeeded',
      JSON.stringify(step.input || {}), JSON.stringify(step.output || {}),
      iso(started), iso(started + (step.durationMs ?? 100))
    )
  }
  return id
}

const ids = (result) => result.runs.map((r) => r.id)

describe('planQuery', () => {
  const plan = (source) => planQuery(compile(source).ast)

  it('pushes a column comparison against a matching literal type', () => {
    const p = plan('status == "failed"')
    expect(p.pushed).toEqual(['status == "failed"'])
    expect(p.clauses[0]).toBe('(e.status = ? OR e.status IS NULL)')
  })

  it('widens every clause with IS NULL, which is what makes it sound', () => {
    // FXL's `null != "failed"` is true; SQL's `NULL <> 'failed'` is NULL and
    // drops the row. The widening is the single rule that covers every operator
    // rather than a per-operator argument waiting to be got wrong.
    expect(plan('status != "failed"').clauses[0]).toBe('(e.status <> ? OR e.status IS NULL)')
  })

  it('reads a literal on the left and flips the comparison', () => {
    const p = plan('"2026-08-01" < createdAt')
    expect(p.clauses[0]).toBe('(e.created_at > ? OR e.created_at IS NULL)')
  })

  it('refuses to push a number against a text column', () => {
    // SQLite's type affinity makes `text > 20260801` unconditionally true, and
    // FXL does not agree. Not pushing costs a scan; pushing would be wrong.
    expect(plan('createdAt > 20260801').pushed).toEqual([])
  })

  it('slackens a numeric bound, so float error in julianday cannot drop a row', () => {
    const p = plan('durationMs > 5000')
    expect(p.params).toEqual([4999])
    expect(p.clauses[0]).toMatch(/julianday/)
  })

  it('pushes an `in` over a homogeneous literal list', () => {
    const p = plan('status in ["failed", "cancelled"]')
    expect(p.clauses[0]).toBe('(e.status IN (?, ?) OR e.status IS NULL)')
    expect(p.params).toEqual(['failed', 'cancelled'])
  })

  it('refuses a mixed `in` list', () => {
    expect(plan('status in ["failed", 3]').pushed).toEqual([])
  })

  it('pushes every conjunct on the top-level and-spine', () => {
    const p = plan('status == "failed" and priority == "high" and durationMs > 100')
    expect(p.pushed).toHaveLength(3)
  })

  it('accepts the `and` keyword and `&&` as the same thing', () => {
    expect(plan('status == "failed" && priority == "high"').pushed).toHaveLength(2)
  })

  // — positive position only ————————————————————————————————————————

  it('pushes nothing from under an `or`', () => {
    // Narrowing the candidate set is not the same as narrowing the result there.
    expect(plan('status == "failed" or priority == "high"').pushed).toEqual([])
  })

  it('pushes nothing from under a `not`', () => {
    expect(plan('not (status == "failed")').pushed).toEqual([])
  })

  it('pushes nothing from under a conditional', () => {
    expect(plan('priority == "high" ? status == "failed" : false').pushed).toEqual([])
  })

  it('still pushes the sibling conjuncts around an unpushable one', () => {
    const p = plan('status == "failed" and (priority == "high" or durationMs > 1)')
    expect(p.pushed).toEqual(['status == "failed"'])
  })

  it('pushes nothing from a step or trigger reference', () => {
    expect(plan('steps.charge.output.status >= 500').pushed).toEqual([])
    expect(plan('trigger.total > 1000').pushed).toEqual([])
  })

  // — what has to be loaded ——————————————————————————————————————————

  it('knows when steps are needed and when they are not', () => {
    expect(plan('steps.charge.status == "failed"').needsSteps).toBe(true)
    expect(plan('status == "failed"').needsSteps).toBe(false)
    expect(plan('trigger.total > 1').needsTrigger).toBe(true)
  })
})

describe('queryRuns', () => {
  it('reports a syntax error with the position rather than throwing', () => {
    const result = queryRuns(workflowId, 'status ==')
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('finds runs by status', () => {
    const failed = seedRun({ status: 'failed', offsetMs: 1000 })
    seedRun({ status: 'completed', offsetMs: 2000 })
    const result = queryRuns(workflowId, 'status == "failed"')
    expect(ids(result)).toContain(failed)
    expect(result.plan.pushedDown).toEqual(['status == "failed"'])
  })

  it('finds runs by a value inside a step output', () => {
    const server = seedRun({
      status: 'step-a', offsetMs: 3000,
      steps: [{ nodeId: 'charge', output: { status: 502, body: 'bad gateway' } }],
    })
    seedRun({ status: 'step-a', offsetMs: 4000, steps: [{ nodeId: 'charge', output: { status: 200 } }] })
    const result = queryRuns(workflowId, 'status == "step-a" and steps.charge.output.status >= 500')
    expect(ids(result)).toEqual([server])
    expect(result.plan.loadedSteps).toBe(true)
  })

  it('matches a run that has no such step at all, which is FXL and not a bug', () => {
    // `undefined >= 500` falls back to a string comparison — "undefined" sorts
    // after "500" — so it is true. This is the same rule a condition node
    // follows, and giving queries their own comparison semantics would be worse
    // than the sharp edge: two dialects of one language. The idiom is to pair
    // the test with an existence check, which `in` provides.
    seedRun({ status: 'no-step', offsetMs: 4500 })
    const loose = queryRuns(workflowId, 'status == "no-step" and steps.charge.output.status >= 500')
    expect(loose.runs).toHaveLength(1)

    const guarded = queryRuns(
      workflowId,
      'status == "no-step" and "charge" in steps and steps.charge.output.status >= 500'
    )
    expect(guarded.runs).toEqual([])
  })

  it('finds runs by a value inside the trigger payload', () => {
    const big = seedRun({ status: 'trig-a', offsetMs: 5000, trigger: { order: { total: 5000 } } })
    seedRun({ status: 'trig-a', offsetMs: 6000, trigger: { order: { total: 10 } } })
    const result = queryRuns(workflowId, 'status == "trig-a" and trigger.order.total > 1000')
    expect(ids(result)).toEqual([big])
  })

  it('uses the whole stdlib, because it is the same evaluator', () => {
    const email = seedRun({
      status: 'stdlib-a', offsetMs: 7000,
      steps: [{ nodeId: 'notify', output: { channel: 'EMAIL' } }],
    })
    seedRun({
      status: 'stdlib-a', offsetMs: 7100,
      steps: [{ nodeId: 'notify', output: { channel: 'pigeon' } }],
    })
    const result = queryRuns(
      workflowId,
      'status == "stdlib-a" and lower(steps.notify.output.channel) in ["email", "sms"]'
    )
    expect(ids(result)).toEqual([email])
  })

  it('combines a pushed conjunct with one it had to evaluate', () => {
    const match = seedRun({
      status: 'combo-fail',
      offsetMs: 8000,
      steps: [{ nodeId: 'charge', output: { status: 503 } }],
    })
    seedRun({ status: 'combo-fail', offsetMs: 8100, steps: [{ nodeId: 'charge', output: { status: 200 } }] })
    seedRun({ status: 'combo-ok', offsetMs: 8200, steps: [{ nodeId: 'charge', output: { status: 503 } }] })
    const result = queryRuns(
      workflowId,
      'status == "combo-fail" and steps.charge.output.status >= 500'
    )
    expect(ids(result)).toEqual([match])
    expect(result.plan.pushedDown).toEqual(['status == "combo-fail"'])
  })

  it('filters on duration, which is computed rather than stored', () => {
    const slow = seedRun({ status: 'dur-a', offsetMs: 9000, durationMs: 90000 })
    seedRun({ status: 'dur-a', offsetMs: 9100, durationMs: 500 })
    expect(ids(queryRuns(workflowId, 'status == "dur-a" and durationMs > 60000'))).toEqual([slow])
  })

  it('filters on how long a run waited before starting', () => {
    const queued = seedRun({ status: 'wait-a', offsetMs: 10000, waitMs: 30000 })
    seedRun({ status: 'wait-a', offsetMs: 10100, waitMs: 0 })
    expect(ids(queryRuns(workflowId, 'status == "wait-a" and waitMs > 10000'))).toEqual([queued])
  })

  // — the soundness cases ————————————————————————————————————————————

  it('keeps a run whose column is null when FXL would keep it', () => {
    // A run still in flight has no finished_at. FXL's `durationMs > 5000` on a
    // null falls back to a string comparison and is *true*; a naive
    // `WHERE (…) > 5000` would drop it. The widening is why it survives to be
    // judged by FXL at all.
    const running = seedRun({ status: 'running', offsetMs: 11000, finished: false })
    expect(ids(queryRuns(workflowId, 'durationMs > 5000 and status == "running"')))
      .toContain(running)
  })

  it('keeps a run whose column is null under a not-equals', () => {
    // FXL: `null != "high"` is true. SQL: `NULL <> 'high'` is NULL, which drops
    // the row. Same rule, second operator.
    const noPriority = seedRun({ status: 'queued-x', offsetMs: 12000 })
    expect(ids(queryRuns(workflowId, 'priority != "high" and status == "queued-x"')))
      .toContain(noPriority)
  })

  it('gives the same answer pushed and unpushed', () => {
    // The guarantee stated as a test: forcing the planner to give up (by
    // wrapping in a `not`) must not change which runs come back.
    seedRun({ status: 'audit-a', offsetMs: 13000 })
    seedRun({ status: 'audit-b', offsetMs: 13100 })
    const pushed = queryRuns(workflowId, 'status == "audit-a"')
    const scanned = queryRuns(workflowId, 'not (status != "audit-a")')
    expect(pushed.plan.pushedDown).toHaveLength(1)
    expect(scanned.plan.pushedDown).toEqual([])
    expect(ids(pushed)).toEqual(ids(scanned))
  })

  // — limits and honesty ————————————————————————————————————————————

  it('respects a limit and reports what it scanned', () => {
    for (let i = 0; i < 5; i += 1) seedRun({ status: 'limited', offsetMs: 14000 + i })
    const result = queryRuns(workflowId, 'status == "limited"', { limit: 2 })
    expect(result.runs).toHaveLength(2)
    expect(result.plan.matched).toBe(2)
  })

  it('says when it stopped scanning rather than answering from a prefix', () => {
    for (let i = 0; i < 6; i += 1) seedRun({ status: 'scan-cap', offsetMs: 15000 + i })
    const result = queryRuns(workflowId, 'status == "scan-cap"', { maxScan: 3, limit: 100 })
    expect(result.plan.truncated).toBe(true)
    expect(result.plan.scanned).toBeLessThanOrEqual(3)
  })

  it('counts a predicate that threw rather than failing the whole query', () => {
    // Asking an array function for the first element of a number is a type
    // error for that row and a mismatch, not a broken query — but the count lets
    // a caller tell "nothing matched" from "nothing could be evaluated". (`len`
    // would not do: it is deliberately total, answering 0 for anything it
    // cannot measure.)
    seedRun({ status: 'thrower', offsetMs: 16000, trigger: { total: 5 } })
    const result = queryRuns(workflowId, 'status == "thrower" and first(trigger.total) > 0')
    expect(result.ok).toBe(true)
    expect(result.runs).toEqual([])
    expect(result.plan.evaluationErrors).toBeGreaterThan(0)
  })

  it('stays inside the workflow it was asked about', () => {
    const other = uuidv4()
    expect(queryRuns(other, 'status == "failed"').runs).toEqual([])
  })

  it('does not load steps for a query that never mentions them', () => {
    const result = queryRuns(workflowId, 'status == "completed"', { limit: 1 })
    expect(result.plan.loadedSteps).toBe(false)
  })
})

describe('scopeFor', () => {
  it('exposes a run flat where flat reads better and nested where the data is', () => {
    const scope = scopeFor(
      {
        id: 'ex-1',
        status: 'failed',
        trigger_type: 'webhook',
        priority: 'high',
        created_at: iso(BASE),
        started_at: iso(BASE + 500),
        finished_at: iso(BASE + 2500),
        trigger_data: JSON.stringify({ order: { total: 42 } }),
      },
      [
        {
          node_id: 'charge',
          node_type: 'action-http',
          status: 'failed',
          error: 'boom',
          input_json: '{"amount":42}',
          output_json: '{"status":502}',
          started_at: iso(BASE + 500),
          finished_at: iso(BASE + 900),
        },
      ]
    )
    expect(scope.durationMs).toBe(2000)
    expect(scope.waitMs).toBe(500)
    expect(scope.trigger.order.total).toBe(42)
    expect(scope.steps.charge.output.status).toBe(502)
    expect(scope.steps.charge.durationMs).toBe(400)
    expect(scope.steps.charge.error).toBe('boom')
  })

  it('gives an unfinished run a null duration rather than a wrong one', () => {
    const scope = scopeFor(
      { id: 'x', created_at: iso(BASE), started_at: iso(BASE), finished_at: null },
      []
    )
    expect(scope.durationMs).toBeNull()
  })

  it('treats unreadable JSON as absent rather than failing the row', () => {
    const scope = scopeFor({ id: 'x', trigger_data: 'not json' }, [])
    expect(scope.trigger).toEqual({})
  })
})
