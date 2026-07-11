// Per-workflow run concurrency control.
//
// A workflow can cap how many of its runs are active at once
// (workflows.max_concurrent_runs; NULL/0 = unlimited) and choose what happens
// to a run submitted at the cap (workflows.concurrency_policy):
//
//   'queue'  (default) — the run is accepted and parked; the worker re-checks
//            shortly and starts it once a slot frees. Order across waiting
//            runs is not guaranteed.
//   'reject' — the submission is refused with a 409 at the API/webhook/
//            schedule entry point, so the caller finds out immediately.
//
// Enforcement is two-layered, and each layer plays to where its data is
// accurate:
//
//   - admitRun (enqueue time) implements 'reject' by counting the workflow's
//     pending + running rows — synchronous in better-sqlite3, so two
//     submissions racing through one process can't both slip under the cap.
//   - acquireSlot/releaseSlot (worker pickup) implements the cap itself with
//     an in-process counter. The worker runs in-process with the API, so the
//     counter is exact and race-free — and unlike counting 'running' rows, it
//     can never be wedged by a stale row left behind by a crash.
//
// A run that was accepted is never dropped: if a 'reject' workflow's run
// slips past admitRun in a race, the worker simply defers it like 'queue'.
// Dry runs (test mode) are interactive and exempt from all of this — they
// neither consume slots nor get counted.

const db = require('../config/database')

const POLICIES = ['queue', 'reject']

// The effective limit for a workflow row: a positive integer, or null for
// unlimited (NULL, 0, and garbage all mean "no cap").
function limitFor(workflow) {
  const n = Number(workflow?.max_concurrent_runs)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null
}

// Enqueue-time gate for the 'reject' policy. Returns { ok: true } or
// { ok: false, error } for the route to turn into a 409.
function admitRun(workflow) {
  const limit = limitFor(workflow)
  if (!limit || (workflow.concurrency_policy || 'queue') !== 'reject') return { ok: true }
  const { n } = db.prepare(
    `SELECT COUNT(*) AS n FROM executions
      WHERE workflow_id = ? AND status IN ('pending', 'running')
        AND (trigger_type IS NULL OR trigger_type != 'dry-run')`
  ).get(workflow.id)
  if (n >= limit) {
    return {
      ok: false,
      error: `Concurrency limit reached: "${workflow.name}" already has ${n} active run${n === 1 ? '' : 's'} (limit ${limit})`,
    }
  }
  return { ok: true }
}

// Worker-side slots. Exact within the single in-process worker; reset by a
// restart, which is the behavior we want — slots can't leak across crashes.
const activeRuns = new Map() // workflowId -> count

function acquireSlot(workflowId) {
  const workflow = db
    .prepare('SELECT max_concurrent_runs FROM workflows WHERE id = ?')
    .get(workflowId)
  const limit = limitFor(workflow)
  const current = activeRuns.get(workflowId) || 0
  if (limit && current >= limit) return false
  activeRuns.set(workflowId, current + 1)
  return true
}

function releaseSlot(workflowId) {
  const current = activeRuns.get(workflowId) || 0
  if (current <= 1) activeRuns.delete(workflowId)
  else activeRuns.set(workflowId, current - 1)
}

module.exports = { POLICIES, limitFor, admitRun, acquireSlot, releaseSlot, _activeRuns: activeRuns }
