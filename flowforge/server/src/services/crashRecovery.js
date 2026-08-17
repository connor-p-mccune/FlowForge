// Crash recovery — what happens to a run whose worker stopped existing.
//
// `executionLease.js` makes the loss *observable*: a run whose lease lapsed had
// a worker that is no longer renewing it. This module decides what to do about
// it, and the whole design is one question asked honestly.
//
// ## The question
//
// A step that was `running` when the process died is **indeterminate**. Not
// failed — the HTTP request may well have been received, the email may well
// have been sent, the charge may well have gone through. Not succeeded either;
// nobody recorded a result. It is the one status the engine never writes during
// a normal run, and inventing either of the two it does write would be a lie
// with consequences: calling it failed invites a retry that double-charges,
// calling it succeeded invites a resume that skips work that never happened.
//
// So the recovery records `indeterminate`, and everything else follows from
// refusing to resolve it by guessing.
//
// ## The decision
//
// Resume-from-failure already exists and already has the right semantics: it
// adopts a source run's *succeeded* steps and re-executes everything else, with
// the freshness rule that reuse stops the moment any node re-runs. An
// indeterminate step is not succeeded, so a resume re-executes it — which is
// correct when the step is a Transform and unacceptable when it is a charge.
//
// `workflows.recovery_policy` is where that judgement lives, because it is a
// property of the workflow rather than of the platform:
//
//   safe    (default) resume automatically, unless an indeterminate step could
//           have had an effect outside FlowForge. Then stop and say so.
//   resume  always resume. For a graph whose steps are idempotent, which the
//           author is the only party who can know.
//   manual  never. Record the loss; a person decides.
//
// `safe` has one escape hatch, and it is the honest one: a node that declared
// `idempotent` sends an `Idempotency-Key` that is stable across the recovery
// (services/stepIdempotency.js), so the far side recognises the repeat and the
// step *can* be re-run. That turns the policy from a blunt "anything
// externally-effectful blocks the recovery" into "anything whose repeat is not
// safe blocks it" — which is the distinction that actually matters, and the one
// a per-node declaration is the only way to know.
//
// ## What it deliberately does not do
//
// - **It does not recover a run with no lease.** A `running` row with no
//   lease is either a nested child — which has no independent existence, and
//   whose parent's recovery covers it — or a run from before leases existed.
//   Concluding that a wait-callback parked for six hours is a corpse would be a
//   far worse bug than the one being fixed.
// - **It does not restart.** The crashed run is finalised as `failed` and a
//   *new* run continues it, so history keeps both: what was lost and what was
//   done about it. A crash that quietly re-ran the graph from the top would be
//   the duplicate-effects bug wearing a recovery feature's clothes.
// - **It does not recover forever.** `recovery_depth` rides onto the run each
//   recovery creates, and a run that reliably kills its worker stops after a
//   bounded number of attempts — the same one-line loop guard error-handler
//   workflows use.

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const { expiredLeases } = require('./executionLease')
const { recordExecutionRecovered } = require('./metrics')
const stepIdempotency = require('./stepIdempotency')

// Node types whose work reaches outside FlowForge. An indeterminate step of one
// of these is the case `safe` refuses to resolve on its own: nobody can tell
// from here whether the request landed.
//
// Sub-workflow and for-each are here because a nested run is an arbitrary graph
// — it may have charged a card two levels down. Approval and wait-callback are
// here for a different reason: their effect is a row somebody else may already
// have responded to, and re-asking is its own kind of duplicate.
const EFFECTFUL_TYPES = new Set([
  'action-http',
  'action-email',
  'action-slack',
  'sub-workflow',
  'for-each',
  'approval',
  'wait-callback',
])

const POLICIES = ['safe', 'resume', 'manual']

function recoveryPolicy(workflow) {
  const raw = workflow?.recovery_policy
  return POLICIES.includes(raw) ? raw : 'safe'
}

// How many recoveries deep a run may go. Two by default: a transient node
// eviction gets a second and a third chance, while a graph that reliably kills
// its worker stops being retried before it fills the queue with corpses.
function maxRecoveries() {
  const n = parseInt(process.env.EXEC_MAX_RECOVERIES || '2', 10)
  return Number.isFinite(n) && n >= 0 ? n : 2
}

// Finalise the steps of a run nobody is executing any more.
//
// `running` becomes `indeterminate`, and the message says exactly what is
// unknown rather than paraphrasing it as a failure. `pending` becomes
// `skipped`, which is what it factually was — those nodes never launched — and
// matches how the engine settles the unlaunched remainder of a failed run, so
// the timeline of a recovered run reads like any other.
function settleSteps(executionId, now) {
  const indeterminate = db.prepare(
    `SELECT id, node_id, node_type FROM execution_steps
      WHERE execution_id = ? AND status = 'running'`
  ).all(executionId)

  db.prepare(
    `UPDATE execution_steps
        SET status = 'indeterminate', finished_at = ?, error = ?
      WHERE execution_id = ? AND status = 'running'`
  ).run(
    now,
    'The worker running this step stopped responding — whether it completed is unknown',
    executionId
  )

  db.prepare(
    `UPDATE execution_steps SET status = 'skipped', started_at = COALESCE(started_at, ?), finished_at = ?
      WHERE execution_id = ? AND status = 'pending'`
  ).run(now, now, executionId)

  return indeterminate
}

// Which of a workflow's nodes declared that their endpoint deduplicates
// (services/stepIdempotency.js). A step of one of those may be re-run even
// though nobody recorded its outcome: the request carries a key that is stable
// across the recovery, so the far side recognises the repeat rather than
// performing the work twice.
//
// This is the answer to the limitation the `safe` policy otherwise has to live
// with. It is the workflow author's claim about their endpoint rather than
// something FlowForge can verify — which is exactly why it is a per-node
// declaration and not an inference.
function idempotentNodeIds(workflow) {
  try {
    const graph = JSON.parse(workflow.graph_json)
    return new Set(
      (graph.nodes || []).filter((n) => stepIdempotency.isEnabled(n)).map((n) => n.id)
    )
  } catch {
    // An unparseable graph means nothing can be claimed idempotent, which is the
    // conservative reading.
    return new Set()
  }
}

// May this run be continued without a person looking at it first?
function decide(workflow, execution, indeterminate) {
  const policy = recoveryPolicy(workflow)
  if (policy === 'manual') {
    return { resume: false, reason: 'the workflow’s recovery policy is manual' }
  }
  const depth = Number(execution.recovery_depth) || 0
  if (depth >= maxRecoveries()) {
    return {
      resume: false,
      reason: `already recovered ${depth} time${depth === 1 ? '' : 's'}`,
    }
  }
  if (policy === 'resume') return { resume: true, reason: null }

  const idempotent = idempotentNodeIds(workflow)
  const risky = indeterminate.filter(
    (s) => EFFECTFUL_TYPES.has(s.node_type) && !idempotent.has(s.node_id)
  )
  if (risky.length > 0) {
    return {
      resume: false,
      reason:
        `${risky.map((s) => s.node_id).join(', ')} may already have taken effect — ` +
        'resuming would repeat it',
    }
  }
  return { resume: true, reason: null }
}

// Continue a lost run: a fresh execution pointing back at it, exactly the shape
// POST /executions/:id/resume produces. Reusing that shape rather than adding a
// second one is what keeps a recovered run's semantics identical to a
// hand-resumed one — including the freshness rule that stops reuse at the first
// node which actually re-executes.
function createResume(workflow, execution, { enqueue }) {
  const executionId = uuidv4()
  const now = new Date().toISOString()
  const depth = (Number(execution.recovery_depth) || 0) + 1
  db.prepare(
    `INSERT INTO executions
       (id, workflow_id, status, triggered_by, trigger_type, trigger_data,
        resumed_from_execution_id, priority, recovery_depth, created_at)
     VALUES (?, ?, 'pending', ?, 'recovery', ?, ?, ?, ?, ?)`
  ).run(
    executionId,
    workflow.id,
    execution.triggered_by ?? null,
    execution.trigger_data ?? null,
    execution.id,
    // The lane the lost run was in. A recovery is the same work, so demoting it
    // would punish the run for the platform's failure.
    execution.priority ?? 'normal',
    depth,
    now
  )

  let payload = {}
  if (execution.trigger_data) {
    try {
      const parsed = JSON.parse(execution.trigger_data)
      if (parsed && typeof parsed === 'object') payload = parsed
    } catch {
      /* malformed trigger_data — resume with an empty payload, as the route does */
    }
  }

  // Enqueue outside the transaction that wrote the row, like the backfill does:
  // a job pointing at a row that rolled back would fail on pickup.
  enqueue({ executionId, workflowId: workflow.id, payload }, execution.priority ?? 'normal')
  return executionId
}

// Recover one lost run. Returns what happened, so the sweep can log a single
// line and the tests can assert on the decision rather than on its side
// effects.
function recoverExecution(execution, { enqueue, publish }) {
  const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(execution.workflow_id)
  const now = new Date().toISOString()

  const indeterminate = settleSteps(execution.id, now)

  // The lost run is finalised before anything is decided about continuing it.
  // A watcher sees `failed`, then the recovery — the same ordering the engine
  // uses for a rollback, and for the same reason: the loss is a fact, and it is
  // not contingent on how well the cleanup goes.
  //
  // Guarded on the row still being `running`, so a worker that came back to
  // life a moment ago and finished the run properly wins the race.
  const finalised = db.prepare(
    `UPDATE executions
        SET status = 'failed', finished_at = ?, lease_expires_at = NULL,
            recovery_reason = 'worker-lost'
      WHERE id = ? AND status = 'running'`
  ).run(now, execution.id)
  if (finalised.changes === 0) return { executionId: execution.id, outcome: 'settled-elsewhere' }

  publish?.({
    kind: 'execution',
    workflowId: execution.workflow_id,
    executionId: execution.id,
    status: 'failed',
    error: 'The worker running this execution stopped responding',
    dryRun: false,
  })

  logRecovery(workflow, execution, indeterminate)

  if (!workflow || workflow.status === 'archived') {
    recordExecutionRecovered('abandoned')
    return { executionId: execution.id, outcome: 'abandoned', indeterminate: indeterminate.length }
  }

  const verdict = decide(workflow, execution, indeterminate)
  if (!verdict.resume) {
    recordExecutionRecovered('failed')
    return {
      executionId: execution.id,
      outcome: 'failed',
      reason: verdict.reason,
      indeterminate: indeterminate.length,
    }
  }

  const resumedAs = createResume(workflow, execution, { enqueue })
  recordExecutionRecovered('resumed')
  return {
    executionId: execution.id,
    outcome: 'resumed',
    resumedAs,
    indeterminate: indeterminate.length,
  }
}

// The feed entry, so a lost run is something a team sees rather than something
// they find. Best-effort at the boundary, like every other activity write:
// losing the log line must not stop the recovery.
function logRecovery(workflow, execution, indeterminate) {
  if (!workflow) return
  try {
    require('./activityService').logEvent(
      workflow.workspace_id,
      null,
      'execution.recovered',
      {
        type: 'execution',
        id: execution.id,
        name: workflow.name,
        metadata: {
          workflowId: workflow.id,
          worker: execution.lease_owner,
          indeterminateSteps: indeterminate.map((s) => s.node_id),
        },
      }
    )
  } catch (err) {
    console.error(`Failed to log recovery for ${execution.id}: ${err.message}`)
  }
}

// One sweep. Returns the per-run outcomes; every failure is contained to its
// own run, because one unrecoverable execution must not stop the others being
// recovered.
function recoverOrphans({ enqueue, publish, now = new Date() } = {}) {
  const lost = expiredLeases(now)
  const results = []
  for (const execution of lost) {
    try {
      results.push(recoverExecution(execution, { enqueue, publish }))
    } catch (err) {
      console.error(`Recovery failed for execution ${execution.id}: ${err.message}`)
      results.push({ executionId: execution.id, outcome: 'error', error: err.message })
    }
  }
  return results
}

// — the sweep ————————————————————————————————————————————————————————————
//
// A background timer, for the same reason the heartbeat monitor is one: a
// worker's death is not an event anything can hook. Nothing publishes "I have
// stopped existing".

let timer = null

function sweepIntervalMs() {
  const n = parseInt(process.env.EXEC_RECOVERY_INTERVAL_MS || '30000', 10)
  return Number.isFinite(n) && n >= 1000 ? n : 30000
}

function defaultEnqueue(job, priority) {
  const { getExecutionQueue } = require('../config/queue')
  const { enqueueOpts } = require('./runPriority')
  Promise.resolve(getExecutionQueue().add(job, enqueueOpts(priority))).catch((err) => {
    console.error(`Failed to enqueue recovery run ${job.executionId}: ${err.message}`)
  })
}

function defaultPublish(payload) {
  const redis = require('../config/redis')
  redis
    .publish('exec-update', JSON.stringify(payload))
    .catch((err) => console.error('Failed to publish recovery event:', err.message))
}

function startRecoverySweep({ enqueue = defaultEnqueue, publish = defaultPublish } = {}) {
  if (timer) return timer
  const run = () => {
    try {
      const results = recoverOrphans({ enqueue, publish })
      for (const result of results) {
        console.warn(
          `[recovery] execution ${result.executionId}: ${result.outcome}` +
            (result.reason ? ` (${result.reason})` : '') +
            (result.resumedAs ? ` → ${result.resumedAs}` : '')
        )
      }
    } catch (err) {
      console.error('Crash recovery sweep failed:', err.message)
    }
  }
  // Once at boot, because the runs this exists for are precisely the ones a
  // restart left behind — waiting a full interval to notice them would mean the
  // deploy that fixed the crash also delayed the cleanup.
  run()
  timer = setInterval(run, sweepIntervalMs())
  timer.unref?.()
  return timer
}

function stopRecoverySweep() {
  if (timer) clearInterval(timer)
  timer = null
}

module.exports = {
  EFFECTFUL_TYPES,
  POLICIES,
  recoveryPolicy,
  idempotentNodeIds,
  maxRecoveries,
  settleSteps,
  decide,
  recoverExecution,
  recoverOrphans,
  startRecoverySweep,
  stopRecoverySweep,
}
