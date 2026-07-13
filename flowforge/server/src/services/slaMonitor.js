// SLA & anomaly monitor: evaluates a finished run against its workflow's
// service-level objectives and raises an alert on a breach. Called once per
// top-level run from the execution worker, *after* the engine has recorded the
// terminal status — never from inside the engine's scheduling loop, and never
// for sub-workflow child runs (those execute inside the parent's engine loop and
// don't pass through the worker), so "top-level, settled, real run" falls out of
// where the hook lives rather than needing a flag.
//
// Three checks, composable — a run can trip more than one:
//
//  - duration budget: a completed run whose wall time exceeds
//    workflow.sla_max_duration_ms.
//  - statistical anomaly: a completed run flagged as abnormally slow relative to
//    the workflow's own recent history (runStats' modified z-score). Needs no
//    configuration and only fires with enough baseline, so it's inherently rare.
//  - success-rate floor: the rolling success rate over the last N settled runs
//    dropping below workflow.sla_min_success_rate. Edge-triggered — it alerts on
//    the run that *crosses* the floor, not on every run while degraded — so a
//    sustained outage is one alert, not a storm.
//
// Every path is best-effort and swallows its own errors: a monitoring problem
// must never fail the run it's observing.

const db = require('../config/database')
const { classifyRuns } = require('./runStats')

// How many recent settled runs to pull as the evaluation context. Generous
// enough to cover both windows below with room for a stable robust estimate.
const RECENT_LIMIT = 200

// Rolling window and minimum sample for the success-rate check. Below the
// minimum there isn't enough evidence to call a workflow unhealthy.
const SUCCESS_RATE_WINDOW = Math.max(2, Number(process.env.SLA_SUCCESS_RATE_WINDOW || 20))
const SUCCESS_RATE_MIN_RUNS = Math.max(2, Number(process.env.SLA_SUCCESS_RATE_MIN_RUNS || 5))

// Minimum completed-run baseline before the anomaly check will fire. The MAD is
// only a trustworthy scale estimate with enough points; too few and normal
// variance looks like an outlier.
const ANOMALY_MIN_BASELINE = Math.max(5, Number(process.env.SLA_ANOMALY_MIN_RUNS || 20))

const DURATION_MS = "(julianday(finished_at) - julianday(started_at)) * 86400000"

// Fetch the workflow's recent settled real runs (completed | failed), newest
// first, with each run's wall time. Dry-runs are excluded — a test run is not
// production behaviour and must not move an SLA.
function recentSettledRuns(workflowId) {
  return db.prepare(`
    SELECT id, status, created_at,
      CASE WHEN started_at IS NOT NULL AND finished_at IS NOT NULL
        THEN ${DURATION_MS} END AS duration_ms
    FROM executions
    WHERE workflow_id = ?
      AND status IN ('completed', 'failed')
      AND (trigger_type IS NULL OR trigger_type != 'dry-run')
    ORDER BY created_at DESC, rowid DESC
    LIMIT ?
  `).all(workflowId, RECENT_LIMIT)
}

// Success rate (completed / settled) over a window of settled runs. The window
// is already all-settled, so the denominator is its length.
function successRate(window) {
  if (window.length === 0) return null
  const completed = window.filter((r) => r.status === 'completed').length
  return completed / window.length
}

// Check the just-finished run's duration against the workflow's budget.
function checkDuration(workflow, run) {
  if (workflow.sla_max_duration_ms == null) return null
  if (run.status !== 'completed' || typeof run.duration_ms !== 'number') return null
  if (run.duration_ms <= workflow.sla_max_duration_ms) return null
  return {
    type: 'duration',
    durationMs: Math.round(run.duration_ms),
    budgetMs: workflow.sla_max_duration_ms,
    overBy: Math.round(run.duration_ms - workflow.sla_max_duration_ms),
  }
}

// Score the completed run against the workflow's completed-run history and flag
// it if it's a slow outlier. Includes the run itself in the sample (that's how a
// modified z-score is defined per point) and requires a real baseline first.
function checkAnomaly(run, settled) {
  if (run.status !== 'completed' || typeof run.duration_ms !== 'number') return null
  const completed = settled.filter((r) => r.status === 'completed' && typeof r.duration_ms === 'number')
  if (completed.length < ANOMALY_MIN_BASELINE) return null
  const scored = classifyRuns(completed.map((r) => ({ id: r.id, durationMs: r.duration_ms })))
  const self = scored.find((r) => r.id === run.id)
  if (!self || !self.isAnomaly) return null
  return {
    type: 'anomaly',
    durationMs: Math.round(run.duration_ms),
    score: Number(self.anomalyScore.toFixed(2)),
    severity: self.severity,
  }
}

// Edge-triggered rolling success-rate check: alert only when this run's arrival
// pushes the rate below the floor, i.e. the window ending here is in breach but
// the window ending just before it was not (or lacked the evidence to be).
function checkSuccessRate(workflow, run, settled) {
  if (workflow.sla_min_success_rate == null) return null
  const idx = settled.findIndex((r) => r.id === run.id)
  if (idx === -1) return null // this run isn't settled (shouldn't happen here)

  const nowWindow = settled.slice(idx, idx + SUCCESS_RATE_WINDOW)
  const prevWindow = settled.slice(idx + 1, idx + 1 + SUCCESS_RATE_WINDOW)
  const floor = workflow.sla_min_success_rate

  const nowRate = successRate(nowWindow)
  const nowBreached = nowWindow.length >= SUCCESS_RATE_MIN_RUNS && nowRate < floor
  if (!nowBreached) return null

  const prevRate = successRate(prevWindow)
  const prevBreached = prevWindow.length >= SUCCESS_RATE_MIN_RUNS && prevRate < floor
  if (prevBreached) return null // already alerted on the crossing

  return {
    type: 'success_rate',
    rate: Number(nowRate.toFixed(4)),
    floor,
    window: nowWindow.length,
  }
}

// A one-line human summary of the breaches for the notification body.
function summarize(workflowName, breaches) {
  const parts = breaches.map((b) => {
    if (b.type === 'duration') return `ran ${(b.durationMs / 1000).toFixed(1)}s (budget ${(b.budgetMs / 1000).toFixed(1)}s)`
    if (b.type === 'anomaly') return `was abnormally slow (${(b.durationMs / 1000).toFixed(1)}s)`
    if (b.type === 'success_rate') return `success rate fell to ${Math.round(b.rate * 100)}% (floor ${Math.round(b.floor * 100)}%)`
    return b.type
  })
  return `"${workflowName}" ${parts.join('; ')}.`
}

// Fan a breach out to the two surfaces that already exist: the workspace
// activity feed (which itself relays to outbound webhook subscriptions) and an
// in-app notification to the workflow owner. Both are best-effort.
function raiseAlert(workflow, execution, breaches) {
  const message = summarize(workflow.name, breaches)
  try {
    require('./activityService').logEvent(
      workflow.workspace_id,
      execution.triggered_by,
      'execution.sla_breached',
      {
        type: 'execution',
        id: execution.id,
        name: workflow.name,
        metadata: {
          workflowId: workflow.id,
          triggerType: execution.trigger_type,
          breaches,
        },
      }
    )
  } catch (err) {
    console.error('slaMonitor: activity log failed:', err.message)
  }

  if (workflow.created_by) {
    try {
      require('./notificationService').createNotification(workflow.created_by, {
        type: 'sla-breach',
        title: 'SLA breach',
        message,
        link: `/workflow/${workflow.id}?execution=${execution.id}`,
      })
    } catch (err) {
      console.error('slaMonitor: notification failed:', err.message)
    }
  }
}

// Public entry point. Given a just-finished execution id, evaluate it and raise
// an alert if it breached anything. Returns the list of breaches (empty when
// clean) so callers/tests can inspect the verdict; never throws.
function evaluateRun(executionId) {
  try {
    const execution = db.prepare(
      `SELECT id, workflow_id, status, trigger_type, triggered_by, created_at,
        CASE WHEN started_at IS NOT NULL AND finished_at IS NOT NULL
          THEN ${DURATION_MS} END AS duration_ms
      FROM executions WHERE id = ?`
    ).get(executionId)
    if (!execution) return []
    if (execution.trigger_type === 'dry-run') return []
    if (execution.status !== 'completed' && execution.status !== 'failed') return []

    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(execution.workflow_id)
    if (!workflow) return []

    // Nothing configurable and (for a failed run) no anomaly check applies —
    // skip the queries entirely.
    const hasConfig = workflow.sla_max_duration_ms != null || workflow.sla_min_success_rate != null
    if (!hasConfig && execution.status !== 'completed') return []

    const settled = recentSettledRuns(workflow.id)

    const breaches = [
      checkDuration(workflow, execution),
      checkAnomaly(execution, settled),
      checkSuccessRate(workflow, execution, settled),
    ].filter(Boolean)

    if (breaches.length > 0) raiseAlert(workflow, execution, breaches)
    return breaches
  } catch (err) {
    console.error('slaMonitor.evaluateRun failed:', err.message)
    return []
  }
}

module.exports = {
  evaluateRun,
  // Exported for focused unit tests.
  checkDuration,
  checkAnomaly,
  checkSuccessRate,
  successRate,
}
