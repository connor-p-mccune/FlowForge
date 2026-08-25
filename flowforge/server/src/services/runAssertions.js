// Things that must never happen, checked against every run that does.
//
// FlowForge already proves properties of the *graph*.
// [Guarantees](./guarantees.js) answer "can this ever charge a card without the
// approval having run?" over every execution the graph admits, statically, by
// dominance. That is the strongest kind of check there is, and it can only see
// what the graph's shape decides.
//
// The properties that actually break production are about **data and
// outcomes**, and no amount of graph analysis reaches them:
//
//     a run must never complete with the charge step returning 4xx
//     a refund must never be issued for more than the order total
//     a run must never take longer than the SLA it was sold under
//
// None of those is a fact about the graph. Every one of them is a fact about
// runs, and there are runs — thousands of them, already recorded.
//
// ---
//
// ## An assertion is a saved query
//
// The predicate describes **the shape of a run that must not exist**, in the
// same FXL the [query engine](./runQuery.js) takes:
//
//     status == "completed" and steps.charge.output.status >= 400
//
// The polarity is deliberate, and it is the opposite of how an invariant is
// usually written. Two reasons:
//
//   1. **FXL has no implication operator.** The invariant form — *completed
//      implies charge succeeded* — becomes `not (status == "completed") or
//      steps.charge.output.status < 400`, which nobody reads correctly at 3am.
//   2. **It makes the development loop real.** Write the query, run it against
//      history with `flowforge query` until it finds exactly the runs you mean,
//      then pin it. An assertion is a query you never want to match again, and
//      it is literally the same string.
//
// ## Checked as runs settle, not on a sweep
//
// Evaluation happens on the engine's terminal hook, against the run that just
// finished. That is not an optimisation — it removes a class of bug. A sweep
// needs a watermark to know which runs it has already judged, and a watermark
// is a thing that can be wrong: skip one and a violation is missed forever,
// replay one and it alerts twice. Checking the run in front of you is exact by
// construction: every run is judged once, and the counters are the whole state.
//
// The cost is work on the completion path, so it is bounded — an indexed lookup
// that returns nothing for the workflows with no assertions, a cap on how many
// one workflow may have, and a `try` around everything. **An assertion must
// never fail a run.** A monitor that can break the thing it monitors is worse
// than no monitor.
//
// ## Broken is not holding
//
// An assertion whose predicate throws on every run reports zero violations, and
// reporting that as green is exactly the failure the
// [policy engine](./policyEngine.js) exists to avoid — a rule reading a
// misspelled field that pronounces everything compliant forever.
//
// So evaluations that *complete* are counted separately from ones that
// **throw**, and an assertion with errors and no successes is `broken`, not
// `holding`. It has never once worked, and the report says so.

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const { compile } = require('./expression')
const { scopeFor } = require('./runQuery')

// Per workflow. Enough for any real invariant set, and a bound on the work the
// completion path can be made to do.
const MAX_PER_WORKFLOW = 20
const MAX_PREDICATE_LENGTH = 2000

// A predicate that does not parse is never stored. The alternative is an
// assertion that is silently green forever, which is the state this whole file
// is arranged to make impossible.
function validate({ name, predicate }) {
  if (typeof name !== 'string' || name.trim() === '') return 'name is required'
  if (name.length > 120) return 'name must be at most 120 characters'
  if (typeof predicate !== 'string' || predicate.trim() === '') {
    return 'predicate is required and must be an FXL expression'
  }
  if (predicate.length > MAX_PREDICATE_LENGTH) {
    return `predicate must be at most ${MAX_PREDICATE_LENGTH} characters`
  }
  try {
    compile(predicate)
  } catch (err) {
    return `predicate does not parse: ${err.message}`
  }
  return null
}

const listAssertions = (workflowId) =>
  db
    .prepare('SELECT * FROM workflow_assertions WHERE workflow_id = ? ORDER BY created_at ASC')
    .all(workflowId)

function createAssertion(workflowId, { name, predicate, createdBy = null }) {
  const invalid = validate({ name, predicate })
  if (invalid) return { ok: false, error: invalid }

  const existing = db
    .prepare('SELECT COUNT(*) AS n FROM workflow_assertions WHERE workflow_id = ?')
    .get(workflowId).n
  if (existing >= MAX_PER_WORKFLOW) {
    return { ok: false, error: `a workflow may have at most ${MAX_PER_WORKFLOW} assertions` }
  }

  const id = uuidv4()
  db.prepare(
    `INSERT INTO workflow_assertions (id, workflow_id, name, predicate, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, workflowId, name.trim(), predicate.trim(), createdBy, new Date().toISOString())
  return { ok: true, assertion: db.prepare('SELECT * FROM workflow_assertions WHERE id = ?').get(id) }
}

// Editing the predicate resets the counters, and it has to: they describe how a
// *different* predicate behaved, and carrying them over would let a rewritten
// assertion inherit a clean record it never earned.
function updateAssertion(id, patch) {
  const current = db.prepare('SELECT * FROM workflow_assertions WHERE id = ?').get(id)
  if (!current) return { ok: false, error: 'not-found' }

  const name = patch.name ?? current.name
  const predicate = patch.predicate ?? current.predicate
  const invalid = validate({ name, predicate })
  if (invalid) return { ok: false, error: invalid }

  const changed = predicate.trim() !== current.predicate
  db.prepare(
    `UPDATE workflow_assertions
     SET name = ?, predicate = ?, enabled = ?,
         ok_count = ?, error_count = ?, violation_count = ?,
         last_error = ?, last_checked_at = ?, last_violation_at = ?,
         last_violation_execution_id = ?, alerted_at = ?
     WHERE id = ?`
  ).run(
    name.trim(),
    predicate.trim(),
    patch.enabled === undefined ? current.enabled : patch.enabled ? 1 : 0,
    changed ? 0 : current.ok_count,
    changed ? 0 : current.error_count,
    changed ? 0 : current.violation_count,
    changed ? null : current.last_error,
    changed ? null : current.last_checked_at,
    changed ? null : current.last_violation_at,
    changed ? null : current.last_violation_execution_id,
    changed ? null : current.alerted_at,
    id
  )
  return { ok: true, assertion: db.prepare('SELECT * FROM workflow_assertions WHERE id = ?').get(id) }
}

function deleteAssertion(id) {
  const { changes } = db.prepare('DELETE FROM workflow_assertions WHERE id = ?').run(id)
  return changes > 0
}

// — evaluation ————————————————————————————————————————————————————————

const record = db.prepare(
  `UPDATE workflow_assertions
   SET ok_count = ok_count + ?, error_count = error_count + ?,
       violation_count = violation_count + ?,
       last_error = COALESCE(?, last_error),
       last_checked_at = ?,
       last_violation_at = COALESCE(?, last_violation_at),
       last_violation_execution_id = COALESCE(?, last_violation_execution_id),
       alerted_at = ?
   WHERE id = ?`
)

// The run as the predicate sees it — the same scope the query engine uses, so a
// predicate developed with `flowforge query` means exactly the same thing once
// it is pinned. Anything else would be a trap.
function scopeForRun(executionId) {
  const row = db
    .prepare(
      `SELECT id, status, trigger_type, priority, created_at, started_at, finished_at, trigger_data
       FROM executions WHERE id = ?`
    )
    .get(executionId)
  if (!row) return null
  const steps = db
    .prepare(
      `SELECT node_id, node_type, status, error, input_json, output_json, started_at, finished_at
       FROM execution_steps WHERE execution_id = ?`
    )
    .all(executionId)
  return { row, scope: scopeFor(row, steps) }
}

// Check one settled run against its workflow's assertions.
//
// Returns the transitions it made, for tests and for the caller — but the
// caller in production is the engine's terminal hook, which ignores the result
// and swallows everything. That asymmetry is the point: this reports richly and
// is called defensively.
function checkRun(executionId, { workflow = null, notify = true } = {}) {
  const execution = db
    .prepare('SELECT id, workflow_id, trigger_type FROM executions WHERE id = ?')
    .get(executionId)
  if (!execution) return []
  // A dry run simulated its side-effecting nodes, so an assertion about what
  // they returned would be judging a rehearsal.
  if (execution.trigger_type === 'dry-run') return []

  const assertions = db
    .prepare('SELECT * FROM workflow_assertions WHERE workflow_id = ? AND enabled = 1')
    .all(execution.workflow_id)
  if (assertions.length === 0) return []

  const loaded = scopeForRun(executionId)
  if (!loaded) return []

  const now = new Date().toISOString()
  const transitions = []

  for (const assertion of assertions) {
    let violated = false
    let error = null
    try {
      violated = compile(assertion.predicate).evaluateBoolean(loaded.scope)
    } catch (err) {
      error = err.message
    }

    if (error) {
      record.run(0, 1, 0, error, now, null, null, assertion.alerted_at, assertion.id)
      continue
    }

    if (!violated) {
      // Holding. The alert clears only here, so every open gets a close and a
      // downstream channel is not left with an incident nobody resolved.
      record.run(1, 0, 0, null, now, null, null, null, assertion.id)
      if (assertion.alerted_at) {
        transitions.push({ assertionId: assertion.id, name: assertion.name, transition: 'recovered' })
        if (notify) alert(assertion, workflow, execution, 'recovered')
      }
      continue
    }

    // Violated. Edge-triggered: a storm of matching runs is one alert, not one
    // per run, and the counter records how many there were.
    record.run(1, 0, 1, null, now, now, executionId, assertion.alerted_at || now, assertion.id)
    if (!assertion.alerted_at) {
      transitions.push({ assertionId: assertion.id, name: assertion.name, transition: 'violated' })
      if (notify) alert(assertion, workflow, execution, 'violated')
    } else {
      transitions.push({ assertionId: assertion.id, name: assertion.name, transition: null })
    }
  }

  return transitions
}

function alert(assertion, workflow, execution, kind) {
  const wf =
    workflow ||
    db.prepare('SELECT id, name, workspace_id, created_by FROM workflows WHERE id = ?').get(execution.workflow_id)
  if (!wf) return

  const violated = kind === 'violated'
  const message = violated
    ? `"${wf.name}" — a run matched the assertion "${assertion.name}", which must never happen.`
    : `"${wf.name}" — the assertion "${assertion.name}" is holding again.`

  try {
    require('./activityService').logEvent(
      wf.workspace_id,
      null,
      violated ? 'workflow.assertion_violated' : 'workflow.assertion_recovered',
      {
        type: 'workflow',
        id: wf.id,
        name: wf.name,
        metadata: {
          assertionId: assertion.id,
          assertion: assertion.name,
          predicate: assertion.predicate,
          executionId: execution.id,
        },
      }
    )
  } catch (err) {
    console.error('runAssertions: activity log failed:', err.message)
  }

  if (wf.created_by) {
    try {
      require('./notificationService').createNotification(wf.created_by, {
        type: violated ? 'assertion-violated' : 'assertion-recovered',
        title: violated ? 'Assertion violated' : 'Assertion holding again',
        message,
        link: `/workflow/${wf.id}`,
      })
    } catch (err) {
      console.error('runAssertions: notification failed:', err.message)
    }
  }
}

// — reporting ——————————————————————————————————————————————————————

// `broken` before `violated` before `holding`, because an assertion that has
// never once been evaluated successfully is not making any claim at all, and
// dressing that up as either verdict would be worse than saying so.
function stateOf(row) {
  if (row.error_count > 0 && row.ok_count === 0) return 'broken'
  if (row.alerted_at) return 'violated'
  if (row.ok_count === 0) return 'unchecked'
  return 'holding'
}

function reportFor(workflowId) {
  const assertions = listAssertions(workflowId).map((row) => ({
    id: row.id,
    name: row.name,
    predicate: row.predicate,
    enabled: Boolean(row.enabled),
    state: stateOf(row),
    checked: row.ok_count,
    violations: row.violation_count,
    errors: row.error_count,
    lastError: row.last_error,
    lastCheckedAt: row.last_checked_at,
    lastViolationAt: row.last_violation_at,
    lastViolationExecutionId: row.last_violation_execution_id,
  }))

  return {
    assertions,
    summary: {
      total: assertions.length,
      violated: assertions.filter((a) => a.state === 'violated').length,
      // Counted separately and never folded into `holding`: an assertion nobody
      // can evaluate is a gap in the monitoring, not a clean bill of health.
      broken: assertions.filter((a) => a.state === 'broken').length,
      holding: assertions.filter((a) => a.state === 'holding').length,
      unchecked: assertions.filter((a) => a.state === 'unchecked').length,
    },
  }
}

module.exports = {
  listAssertions,
  createAssertion,
  updateAssertion,
  deleteAssertion,
  checkRun,
  reportFor,
  stateOf,
  validate,
  MAX_PER_WORKFLOW,
}
