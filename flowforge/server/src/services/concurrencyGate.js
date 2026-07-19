// Per-workflow run admission control.
//
// Two independent knobs decide whether a submitted run may start, both checked
// at the single admitRun chokepoint every entry point already calls:
//
// 1. **Concurrency** — how many runs may be *active at once*
//    (workflows.max_concurrent_runs; NULL/0 = unlimited), with an at-cap
//    policy (workflows.concurrency_policy):
//      'queue'  (default) — the run is accepted and parked; the worker
//               re-checks shortly and starts it once a slot frees.
//      'reject' — the submission is refused with a 409 at the entry point.
//
// 2. **Rate limit** — how many runs may *start within a rolling window*
//    (rate_limit_max over rate_limit_window_seconds; both NULL = off). This is
//    frequency, not concurrency: it protects a downstream API from a runaway
//    schedule or a webhook sender that fires in bursts, even when each run
//    finishes instantly. Over the limit is always a refusal (there is no
//    "queue until the window rolls" mode — that's what the concurrency queue
//    is for); the window slides continuously, counting runs by created_at.
//
// Concurrency enforcement is additionally two-layered, each layer where its
// data is accurate:
//
//   - admitRun (enqueue time) implements the 'reject' policy and the rate
//     limit by counting rows — synchronous in better-sqlite3, so two
//     submissions racing through one process can't both slip under a cap.
//   - acquireSlot/releaseSlot (worker pickup) implements the concurrency cap
//     itself with an in-process counter, exact and race-free, and immune to a
//     stale 'running' row left by a crash.
//
// A run that was accepted is never dropped: if a 'reject' workflow's run slips
// past admitRun in a race, the worker simply defers it like 'queue'. Dry runs
// (test mode) are interactive and exempt from all of this — they neither
// consume slots nor count toward either limit.

const db = require('../config/database')
const { recordRateLimited } = require('./metrics')

const POLICIES = ['queue', 'reject']

// The effective concurrency limit for a workflow row: a positive integer, or
// null for unlimited (NULL, 0, and garbage all mean "no cap").
function limitFor(workflow) {
  const n = Number(workflow?.max_concurrent_runs)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null
}

// The effective rate limit for a workflow row: { max, windowSeconds } with
// both positive integers, or null when either is unset (they travel together).
function rateLimitFor(workflow) {
  const max = Number(workflow?.rate_limit_max)
  const windowSeconds = Number(workflow?.rate_limit_window_seconds)
  if (!Number.isFinite(max) || max < 1) return null
  if (!Number.isFinite(windowSeconds) || windowSeconds < 1) return null
  return { max: Math.floor(max), windowSeconds: Math.floor(windowSeconds) }
}

// The 'reject' concurrency check: are pending + running rows already at the
// cap? Only meaningful under the 'reject' policy ('queue' parks instead).
function checkConcurrency(workflow) {
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
      reason: 'concurrency',
      error: `Concurrency limit reached: "${workflow.name}" already has ${n} active run${n === 1 ? '' : 's'} (limit ${limit})`,
    }
  }
  return { ok: true }
}

// The rate-limit check: how many non-dry runs has this workflow started within
// the trailing window? A rejected submission never inserts an execution row,
// so this counts exactly the runs we let through — a true sliding window.
function checkRateLimit(workflow) {
  const rl = rateLimitFor(workflow)
  if (!rl) return { ok: true }
  const cutoff = new Date(Date.now() - rl.windowSeconds * 1000).toISOString()
  const { n } = db.prepare(
    `SELECT COUNT(*) AS n FROM executions
      WHERE workflow_id = ? AND created_at >= ?
        AND (trigger_type IS NULL OR trigger_type != 'dry-run')`
  ).get(workflow.id, cutoff)
  if (n >= rl.max) {
    return {
      ok: false,
      reason: 'rate_limit',
      error: `Rate limit reached: "${workflow.name}" has started ${n} run${n === 1 ? '' : 's'} in the last ${rl.windowSeconds}s (limit ${rl.max})`,
    }
  }
  return { ok: true }
}

// Enqueue-time admission gate. Returns { ok: true } or { ok: false, error,
// reason } for the route to turn into a 409. Concurrency is checked first
// (a full workflow is a full workflow regardless of rate), then the rate
// limit; both are independent of each other and of the pause switch.
function admitRun(workflow) {
  const concurrency = checkConcurrency(workflow)
  if (!concurrency.ok) return concurrency
  const rate = checkRateLimit(workflow)
  if (!rate.ok) {
    recordRateLimited()
    return rate
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

module.exports = {
  POLICIES,
  limitFor,
  rateLimitFor,
  admitRun,
  acquireSlot,
  releaseSlot,
  _activeRuns: activeRuns,
}
