// Workflow pause — the operational kill switch. While a workflow is paused
// (workflows.paused_at set), no new *real* run starts anywhere: manual and
// API triggers are refused with a 409, webhook deliveries are acknowledged
// without firing, schedule ticks are skipped, and error-handler escalations
// don't launch it. What pause deliberately does NOT do:
//
// - **In-flight runs settle normally.** Interrupting half-done work is the
//   cancellation feature's job (and even that is cooperative, inter-node);
//   pause only closes the door on new runs.
// - **Dry runs stay allowed.** A dry run fires no side effects, and the
//   person debugging the incident that prompted the pause needs to test
//   fixes — blocking them would make the switch fight its own use case.
//   Test scenarios (which run dry) keep working for the same reason.
//
// Both operations are idempotent on purpose: a kill switch must be safe to
// slam twice. The first pause wins the audit trail (paused_at/paused_by are
// not rewritten by a repeat), and resuming an active workflow is a no-op.

const db = require('../config/database')
const activityService = require('./activityService')

// The one refusal message every 409 path shares, so a caller hitting the
// switch from any surface reads the same explanation.
const PAUSED_ERROR = 'Workflow is paused — resume it to accept new runs'

function isPaused(workflow) {
  return Boolean(workflow && workflow.paused_at)
}

// Pause the workflow (no-op when already paused) and return the fresh row.
// actorId is who pulled the switch — kept on the row for the audit trail and
// logged to the activity feed, which outbound webhooks relay, so "someone
// paused the sync" reaches the on-call channel without a new alert path.
function pauseWorkflow(workflow, actorId) {
  if (!workflow.paused_at) {
    db.prepare('UPDATE workflows SET paused_at = ?, paused_by = ? WHERE id = ?')
      .run(new Date().toISOString(), actorId ?? null, workflow.id)
    activityService.logEvent(workflow.workspace_id, actorId ?? null, 'workflow.paused', {
      type: 'workflow', id: workflow.id, name: workflow.name,
    })
  }
  return db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflow.id)
}

// Resume the workflow (no-op when not paused) and return the fresh row.
function resumeWorkflow(workflow, actorId) {
  if (workflow.paused_at) {
    db.prepare('UPDATE workflows SET paused_at = NULL, paused_by = NULL WHERE id = ?')
      .run(workflow.id)
    activityService.logEvent(workflow.workspace_id, actorId ?? null, 'workflow.resumed', {
      type: 'workflow', id: workflow.id, name: workflow.name,
    })
  }
  return db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflow.id)
}

module.exports = { PAUSED_ERROR, isPaused, pauseWorkflow, resumeWorkflow }
