// Scheduled maintenance windows — the pause kill switch on a timer.
//
// A workflow can declare a recurring window (maintenance_cron marks the start,
// maintenance_duration_minutes how long it stays open) during which it should
// admit no new runs: a nightly database migration, a downstream API's own
// maintenance hour, a weekly deploy freeze. This monitor reconciles the two
// facts on a sweep — "is now inside a window?" and "is the workflow paused?" —
// and drives one from the other, reusing the pause infrastructure rather than
// inventing a second admission control:
//
//   - inside a window and running  → auto-pause (reason 'maintenance')
//   - outside a window and paused *for maintenance* → auto-resume
//
// Two boundaries keep it from fighting a human. It only ever auto-resumes a
// pause it caused (paused_reason = 'maintenance'), so a manual pause survives a
// window ending; and it only auto-pauses a workflow that isn't already paused,
// so a manual pause taken inside a window is left exactly as the operator set
// it. The window itself is computed with the same dependency-free cron engine
// the schedule preview uses (services/cronExpression.js), in UTC, so "inside a
// window" is deterministic regardless of the server's timezone.

const db = require('../config/database')
const { nextRun, isValid } = require('./cronExpression')
const { pauseWorkflow, resumeWorkflow } = require('./workflowPause')

const CHECK_INTERVAL_MS = Math.max(
  5000,
  Number(process.env.MAINTENANCE_CHECK_INTERVAL_MS) || 60 * 1000
)

// Is `now` inside a maintenance window? A window opens at each cron fire time
// and lasts durationMinutes. `now` is inside one iff the earliest start after
// (now − duration) is at or before now: that start S satisfies
// now − duration < S ≤ now, i.e. now ∈ [S, S + duration). nextRun returns the
// first fire strictly after its `from`, which is exactly the half-open bound
// we want — a window is [start, start+duration), so a fire exactly at
// (now − duration) has already closed and must not count.
function isWithinWindow(cron, durationMinutes, now = new Date()) {
  if (!cron || !isValid(cron)) return false
  const duration = Number(durationMinutes)
  if (!Number.isFinite(duration) || duration < 1) return false
  const durationMs = duration * 60000
  const start = nextRun(cron, new Date(now.getTime() - durationMs))
  return start !== null && start.getTime() <= now.getTime()
}

// One reconciliation pass over every workflow with a maintenance window.
// Returns the transitions it made — [{ workflowId, event }] with event
// 'paused' | 'resumed' — for tests and the curious; never throws.
function checkOnce(now = new Date()) {
  const transitions = []
  let workflows
  try {
    workflows = db.prepare(`
      SELECT id, workspace_id, name, paused_at, paused_reason,
             maintenance_cron, maintenance_duration_minutes
        FROM workflows
       WHERE maintenance_cron IS NOT NULL
         AND maintenance_duration_minutes IS NOT NULL
    `).all()
  } catch (err) {
    console.error('maintenanceWindow: sweep query failed:', err.message)
    return transitions
  }

  for (const workflow of workflows) {
    try {
      const within = isWithinWindow(workflow.maintenance_cron, workflow.maintenance_duration_minutes, now)
      if (within && !workflow.paused_at) {
        pauseWorkflow(workflow, null, { reason: 'maintenance', eventType: 'workflow.maintenance_started' })
        transitions.push({ workflowId: workflow.id, event: 'paused' })
      } else if (!within && workflow.paused_at && workflow.paused_reason === 'maintenance') {
        resumeWorkflow(workflow, null, { eventType: 'workflow.maintenance_ended' })
        transitions.push({ workflowId: workflow.id, event: 'resumed' })
      }
    } catch (err) {
      console.error(`maintenanceWindow: check failed for ${workflow.id}:`, err.message)
    }
  }
  return transitions
}

let timer = null

function startMaintenanceWindows() {
  if (timer) return timer
  // Reconcile once at boot so a window active across a restart re-pauses
  // immediately rather than waiting a full interval.
  try {
    checkOnce()
  } catch (err) {
    console.error('maintenanceWindow: initial sweep failed:', err.message)
  }
  timer = setInterval(() => {
    checkOnce()
  }, CHECK_INTERVAL_MS)
  timer.unref()
  return timer
}

// Stop sweeping (graceful shutdown). State lives in columns, so the next boot
// reconciles from wherever this one left off.
function stopMaintenanceWindows() {
  if (!timer) return
  clearInterval(timer)
  timer = null
}

module.exports = { isWithinWindow, checkOnce, startMaintenanceWindows, stopMaintenanceWindows }
