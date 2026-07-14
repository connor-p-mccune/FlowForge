// Workflow test scenarios: regression tests for a workflow itself. A scenario is
// a named trigger payload plus a list of FXL assertions over the resulting run's
// outputs. Running it executes the workflow through the *real* engine in dry-run
// mode — side-effecting nodes (email/Slack/HTTP) return what they would send
// instead of firing, and approval gates auto-approve — then evaluates each
// assertion against the run. It's the same testing philosophy the codebase
// applies to itself, turned on the workflows users build: change a graph, run
// its scenarios, and know before deploy whether the contract still holds.
//
// The design reuses rather than reinvents:
//   • The engine. runExecution drives the same scheduler, templating, secret
//     redaction, and dry-run semantics a normal run uses, so a scenario that
//     passes is the behaviour the workflow will actually produce.
//   • Dry-run identity. Test executions are recorded with trigger_type
//     'dry-run', so every place that already excludes test-mode runs (insights,
//     the status badge, the SLA monitor) excludes these too — a CI suite that
//     runs on every push can't skew a percentile or flip a badge.
//   • FXL. Assertions are the same expression language the condition, filter,
//     and switch nodes evaluate — no second rules engine, and the linter/
//     playground already understand the syntax.
//
// Assertions run against a scope of:
//   output   the run's final output object (the return/last node) — e.g.
//            `output.total > 0`
//   steps    { nodeId: output } for every step that ran (persisted, so
//            secret-redacted) — e.g. `steps["classify-1"].label == "urgent"`
//            or `get(steps, "http-1.body.status") == 200`
//   status   the run's terminal status ('completed' | 'failed' | 'cancelled'),
//            so a scenario can assert a failure path: `status == "failed"`

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const { runExecution } = require('./executionEngine')
const { evaluateBoolean } = require('./expression')

// A scenario run is bounded so a workflow with a real delay node (which sleeps
// even in dry-run) can't hang a CI gate. On timeout the scenario is reported as
// timed-out rather than passing or hanging.
function timeoutMs() {
  const n = parseInt(process.env.WORKFLOW_TEST_TIMEOUT_MS || '15000', 10)
  return Number.isFinite(n) && n > 0 ? n : 15000
}

function parseJson(text, fallback) {
  if (text == null || text === '') return fallback
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

// Race a promise against a timer that rejects, so a long-running (or hung) run
// yields a bounded, honest result. The engine promise keeps running in the
// background — harmless, it's a dry-run with a no-op publisher — so we detach it.
function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// Evaluate every assertion against the run scope. An assertion passes when its
// expression is truthy; a syntax/runtime error is a failed assertion with the
// message attached, not a thrown request.
function evaluateAssertions(assertions, scope) {
  return assertions.map((a) => {
    const expression = a?.expression
    const description = a?.description ?? null
    if (expression == null || String(expression).trim() === '') {
      return { expression: expression ?? '', description, passed: false, error: 'empty assertion' }
    }
    try {
      return { expression, description, passed: evaluateBoolean(String(expression), scope), error: null }
    } catch (err) {
      return { expression, description, passed: false, error: err.message }
    }
  })
}

// Run one scenario against a workflow and return its result. Never throws for a
// test failure — a failing assertion or a run error is data, so the caller (a
// route, a CLI gate) renders it rather than 500ing.
async function runScenario(workflow, scenario) {
  const input = parseJson(scenario.trigger_data, {})
  const assertions = Array.isArray(scenario.assertions)
    ? scenario.assertions
    : parseJson(scenario.assertions, [])

  // A recorded dry-run execution, so the run is inspectable in history and is
  // excluded everywhere test-mode runs are. triggered_by is the person/token
  // running the suite (may be null for the public gate).
  const executionId = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO executions (id, workflow_id, status, triggered_by, trigger_type, trigger_data, created_at)
     VALUES (?, ?, 'pending', ?, 'dry-run', ?, ?)`
  ).run(executionId, workflow.id, scenario.triggered_by ?? null, scenario.trigger_data ?? null, now)

  let output = null
  let timedOut = false
  let runError = null
  try {
    output = (await withTimeout(
      runExecution(executionId, { dryRun: true, payload: input, publish: () => {} }),
      timeoutMs()
    )) ?? null
  } catch (err) {
    if (/timed out/.test(err.message)) timedOut = true
    else runError = err.message
  }

  const execRow = db.prepare('SELECT status FROM executions WHERE id = ?').get(executionId)
  const status = timedOut ? 'timed-out' : execRow?.status ?? 'unknown'

  // Build the assertion scope from the persisted (redacted) step outputs.
  const steps = {}
  for (const step of db.prepare(
    'SELECT node_id, output_json FROM execution_steps WHERE execution_id = ?'
  ).all(executionId)) {
    steps[step.node_id] = parseJson(step.output_json, null)
  }
  const scope = { output, steps, status }

  // A timed-out or engine-errored run can't be assessed, so all assertions fail
  // with that reason; otherwise evaluate each against the scope.
  const results = timedOut || runError
    ? assertions.map((a) => ({
        expression: a?.expression ?? '',
        description: a?.description ?? null,
        passed: false,
        error: timedOut ? 'run timed out' : `run error: ${runError}`,
      }))
    : evaluateAssertions(assertions, scope)

  const passed = !timedOut && !runError && results.length > 0 && results.every((r) => r.passed)

  return {
    id: scenario.id,
    name: scenario.name,
    executionId,
    runStatus: status,
    passed,
    timedOut,
    error: runError,
    assertions: results,
  }
}

// Run every scenario for a workflow (its test suite) and roll the results up to
// a pass/fail summary — the shape a CI gate keys on.
async function runSuite(workflow, { triggeredBy = null } = {}) {
  const scenarios = db.prepare(
    'SELECT * FROM workflow_tests WHERE workflow_id = ? ORDER BY created_at, rowid'
  ).all(workflow.id)

  const results = []
  for (const scenario of scenarios) {
    results.push(await runScenario(workflow, { ...scenario, triggered_by: triggeredBy }))
  }

  const passed = results.filter((r) => r.passed).length
  return {
    workflowId: workflow.id,
    total: results.length,
    passed,
    failed: results.length - passed,
    ok: results.length > 0 && passed === results.length,
    scenarios: results,
  }
}

module.exports = { runScenario, runSuite, evaluateAssertions }
