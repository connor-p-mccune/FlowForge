// Execution leases — who is allowed to be running a given run, and how anybody
// else finds out that nobody is.
//
// Every reliability control in this codebase bounds what a *running* system
// does: retries bound a flaky call, the circuit breaker bounds a dead host,
// compensations undo what already happened, graceful shutdown drains in-flight
// runs. All of them assume the process survives. When it does not — OOM, a
// `kill -9`, a node evicted mid-deploy — the run's row says `running` forever.
// The timeline never finishes, the badge never flips, insights count it as
// neither success nor failure, and the only cure is somebody noticing.
//
// There is a second, quieter failure in the same place. Bull re-delivers a job
// whose worker stopped reporting progress, and `runExecution` on a redelivered
// job would insert a fresh step row per node and execute the whole graph again
// — re-sending the email, re-charging the card. The queue is doing exactly what
// an at-least-once queue is supposed to do; what was missing was anything on
// this side making the second delivery a no-op.
//
// A lease answers both. It is one row's worth of state:
//
//   lease_owner       which worker believes it is running this
//   lease_token       a fresh random value per acquisition — the fencing token
//   lease_expires_at  when that belief stops being credible
//
// ## Why a heartbeat rather than a progress check
//
// The lease is renewed by a timer, not by the scheduler's round loop, and that
// distinction is load-bearing. A run parked on an approval gate makes no
// progress for hours by design; if renewal rode on a node settling, the most
// legitimate wait in the product would look exactly like a crash. A timer
// separates "this process is alive" from "this run is advancing", which are
// genuinely different facts — and a dead process runs no timers, which is the
// whole mechanism.
//
// ## Why a token rather than a flag
//
// The owner column alone cannot survive the case it exists for. A worker
// stalled long enough to lose its lease can come back — a paused VM, a long GC,
// a blocked event loop — and it still holds every in-memory variable it had.
// The token is compared on every write that decides the run's outcome, so a
// worker whose lease was taken cannot finalise a run somebody else has already
// adopted. This is Kleppmann's fencing argument, and the reason "check then
// act" is not enough: the check is only true until it isn't.
//
// The engine also *reads* its own token each scheduling round and stops
// launching when it no longer holds it — the same cooperative pattern as
// cancellation, and for the same reason: the run is not torn down mid-node,
// because a half-sent HTTP call is worse than a duplicated one.

const os = require('os')
const crypto = require('crypto')
const db = require('../config/database')

// This process, for a human reading the row. Deliberately not a stable
// identity: two boots of the same container are different owners, because the
// first one's lease is exactly what the second must be able to take.
const WORKER_ID = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`

// How long a lease stays credible without a renewal. Long enough that a
// stop-the-world pause or a slow disk does not look like a death, short enough
// that a genuinely dead worker's runs are recovered while somebody still cares.
function leaseTtlMs() {
  const n = parseInt(process.env.EXEC_LEASE_TTL_MS || '45000', 10)
  return Number.isFinite(n) && n >= 1000 ? n : 45000
}

// Renewal cadence. A third of the TTL, so two consecutive renewals can be lost
// to a hiccup before anything concludes the worker is gone.
const renewIntervalMs = () => Math.max(500, Math.floor(leaseTtlMs() / 3))

const iso = (date) => date.toISOString()
const plus = (ms, from = Date.now()) => new Date(from + ms)

// Take the lease on a run, or return null when somebody else legitimately has
// it — or when the run has already started, which is the important half.
//
// The `status = 'pending'` condition is what makes a duplicate delivery inert.
// A run that reached `running` has already had its step rows written and its
// nodes launched; restarting it from the top would duplicate every effect so
// far, so a second delivery is refused whether the first worker is alive
// (its lease is live) or dead (the recovery sweep owns that case, and it
// resumes rather than restarts). "Re-run it and hope" is never the answer.
function acquire(executionId) {
  const token = crypto.randomBytes(16).toString('hex')
  const now = new Date()
  const result = db
    .prepare(
      `UPDATE executions
          SET lease_owner = ?, lease_token = ?, lease_expires_at = ?,
              lease_attempts = COALESCE(lease_attempts, 0) + 1
        WHERE id = ?
          AND status = 'pending'
          AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)`
    )
    .run(WORKER_ID, token, iso(plus(leaseTtlMs(), now.getTime())), executionId, iso(now))
  return result.changes === 1 ? token : null
}

// Push the deadline out. Returns false once the lease has been taken by
// somebody else, which is the signal the engine stops on.
function renew(executionId, token) {
  if (!token) return false
  const result = db
    .prepare('UPDATE executions SET lease_expires_at = ? WHERE id = ? AND lease_token = ?')
    .run(iso(plus(leaseTtlMs())), executionId, token)
  return result.changes === 1
}

// Do we still hold it? A read, called once per scheduling round — cheap, and
// synchronous like every other better-sqlite3 statement, so it cannot observe a
// half-written row.
function held(executionId, token) {
  if (!token) return false
  const row = db.prepare('SELECT lease_token FROM executions WHERE id = ?').get(executionId)
  return row?.lease_token === token
}

// Give it up at a terminal state. Clearing the deadline rather than the token
// keeps the audit trail — which worker ran this, and how many times it was
// picked up — while making the row uninteresting to the recovery sweep.
function release(executionId, token) {
  if (!token) return
  db.prepare(
    'UPDATE executions SET lease_expires_at = NULL WHERE id = ? AND lease_token = ?'
  ).run(executionId, token)
}

// Start renewing in the background until `stop()` is called. Unref'd, so a
// pending renewal never holds the process open — the drain and the test runner
// both depend on that.
function startRenewal(executionId, token) {
  const timer = setInterval(() => {
    try {
      renew(executionId, token)
    } catch (err) {
      // A failed renewal is not fatal on its own: the next one may succeed, and
      // if none does the recovery sweep is exactly the mechanism for it.
      console.error(`Lease renewal failed for ${executionId}: ${err.message}`)
    }
  }, renewIntervalMs())
  timer.unref?.()
  return () => clearInterval(timer)
}

// Runs whose lease has lapsed: still `running`, still leased, and the deadline
// is past.
//
// Two exclusions are deliberate. **Only leased rows**, because a `running` row
// with no lease at all is either a nested child (which has no independent
// existence — recovering its parent covers it) or a run started before leases
// existed, and guessing that a long wait-callback is a corpse would be a far
// worse bug than the one being fixed. And **only top-level rows**, for the same
// reason: a sub-workflow child executes inside its parent's engine loop, so its
// parent's lease is the only one that means anything.
function expiredLeases(now = new Date(), limit = 100) {
  return db
    .prepare(
      `SELECT * FROM executions
        WHERE status = 'running'
          AND parent_execution_id IS NULL
          AND lease_token IS NOT NULL
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= ?
        ORDER BY lease_expires_at
        LIMIT ?`
    )
    .all(iso(now), limit)
}

module.exports = {
  WORKER_ID,
  leaseTtlMs,
  renewIntervalMs,
  acquire,
  renew,
  held,
  release,
  startRenewal,
  expiredLeases,
}
