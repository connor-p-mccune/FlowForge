// Heartbeat monitor — a dead-man's switch for workflows that are supposed to
// keep running. The SLA monitor judges runs that *happened*; it is blind to
// the failure mode where runs stop happening at all (a schedule silently
// unregistered, a webhook sender decommissioned, an upstream cron box died).
// A workflow that declares heartbeat_interval_minutes is promising "a real
// run of me completes successfully at least this often", and this monitor
// alerts when the promise is broken — the healthchecks.io model, pointed at
// workflows.
//
// Three decisions carry the design:
//
//  - **Absence can't hook a run, so the monitor is a sweep.** Every other
//    alert in the system hangs off a run settling; a missed heartbeat is
//    precisely a run *not* settling, so a background timer walks the deployed
//    workflows with an expectation set (cheap: one indexed query per
//    workflow) and compares last-success age against the interval.
//
//  - **Edge-triggered via one column.** heartbeat_alerted_at records the
//    outstanding alert; while it is set, sweeps stay silent — a weekend-long
//    outage is one alert, not one per minute. A success newer than the alert
//    clears it and emits a `workflow.heartbeat_recovered` event, so the
//    downstream consumer (a Slack channel via outbound webhooks, typically)
//    sees a close for every open.
//
//  - **A never-run workflow measures silence from its latest deploy.** The
//    deploy is when the schedule went live — the moment the promise started —
//    and workflow_versions records it. Falling back to updated_at covers
//    legacy rows; a draft has made no promise and is skipped entirely.
//
// Alerts reuse the existing fan-out (activity feed → outbound webhooks, plus
// an owner notification), and everything is best-effort: monitoring must
// never break anything else.

const db = require('../config/database')
const { recordHeartbeatMissed } = require('./metrics')

const CHECK_INTERVAL_MS = Math.max(
  5000,
  Number(process.env.HEARTBEAT_CHECK_INTERVAL_MS) || 60 * 1000
)

// The newest successful, real (non-dry-run) run's finish time, or null.
function lastSuccessAt(workflowId) {
  const row = db.prepare(`
    SELECT finished_at FROM executions
     WHERE workflow_id = ?
       AND status = 'completed'
       AND (trigger_type IS NULL OR trigger_type != 'dry-run')
       AND finished_at IS NOT NULL
     ORDER BY finished_at DESC
     LIMIT 1
  `).get(workflowId)
  return row ? row.finished_at : null
}

// When the workflow's current promise began: its latest deploy, else the row's
// own updated_at (legacy databases predating workflow_versions).
function baselineAt(workflow) {
  const row = db.prepare(
    'SELECT MAX(created_at) AS deployedAt FROM workflow_versions WHERE workflow_id = ?'
  ).get(workflow.id)
  return row?.deployedAt || workflow.updated_at
}

function minutesBetween(fromIso, toMs) {
  return (toMs - new Date(fromIso).getTime()) / 60000
}

function raiseMissed(workflow, { lastSuccess, overdueMinutes }) {
  const message = lastSuccess
    ? `"${workflow.name}" expects a successful run every ${workflow.heartbeat_interval_minutes} min — none for ${Math.round(overdueMinutes)} min.`
    : `"${workflow.name}" expects a successful run every ${workflow.heartbeat_interval_minutes} min — none since it was deployed.`
  try {
    require('./activityService').logEvent(workflow.workspace_id, null, 'workflow.heartbeat_missed', {
      type: 'workflow',
      id: workflow.id,
      name: workflow.name,
      metadata: {
        workflowId: workflow.id,
        intervalMinutes: workflow.heartbeat_interval_minutes,
        lastSuccessAt: lastSuccess,
        overdueMinutes: Math.round(overdueMinutes),
      },
    })
  } catch (err) {
    console.error('heartbeatMonitor: activity log failed:', err.message)
  }
  if (workflow.created_by) {
    try {
      require('./notificationService').createNotification(workflow.created_by, {
        type: 'heartbeat-missed',
        title: 'Missed heartbeat',
        message,
        link: `/workflow/${workflow.id}`,
      })
    } catch (err) {
      console.error('heartbeatMonitor: notification failed:', err.message)
    }
  }
  try {
    recordHeartbeatMissed()
  } catch {
    /* metrics must never break monitoring */
  }
}

function raiseRecovered(workflow, lastSuccess) {
  try {
    require('./activityService').logEvent(workflow.workspace_id, null, 'workflow.heartbeat_recovered', {
      type: 'workflow',
      id: workflow.id,
      name: workflow.name,
      metadata: { workflowId: workflow.id, lastSuccessAt: lastSuccess },
    })
  } catch (err) {
    console.error('heartbeatMonitor: activity log failed:', err.message)
  }
}

// One sweep over every deployed workflow with a heartbeat expectation.
// Returns the state transitions it made — [{ workflowId, event }] with event
// 'missed' | 'recovered' — for tests and the curious; never throws.
function checkOnce(nowMs = Date.now()) {
  const transitions = []
  let workflows
  try {
    workflows = db.prepare(`
      SELECT id, workspace_id, name, created_by, updated_at,
             heartbeat_interval_minutes, heartbeat_alerted_at
        FROM workflows
       WHERE status = 'deployed'
         AND heartbeat_interval_minutes IS NOT NULL
         AND heartbeat_interval_minutes > 0
    `).all()
  } catch (err) {
    console.error('heartbeatMonitor: sweep query failed:', err.message)
    return transitions
  }

  for (const workflow of workflows) {
    try {
      const lastSuccess = lastSuccessAt(workflow.id)

      if (workflow.heartbeat_alerted_at) {
        // Alert outstanding: only a success newer than the alert closes it.
        if (lastSuccess && lastSuccess > workflow.heartbeat_alerted_at) {
          db.prepare('UPDATE workflows SET heartbeat_alerted_at = NULL WHERE id = ?').run(workflow.id)
          raiseRecovered(workflow, lastSuccess)
          transitions.push({ workflowId: workflow.id, event: 'recovered' })
        }
        continue
      }

      const since = lastSuccess || baselineAt(workflow)
      if (!since) continue
      const silenceMinutes = minutesBetween(since, nowMs)
      if (silenceMinutes <= workflow.heartbeat_interval_minutes) continue

      db.prepare('UPDATE workflows SET heartbeat_alerted_at = ? WHERE id = ?')
        .run(new Date(nowMs).toISOString(), workflow.id)
      raiseMissed(workflow, {
        lastSuccess,
        overdueMinutes: silenceMinutes - workflow.heartbeat_interval_minutes,
      })
      transitions.push({ workflowId: workflow.id, event: 'missed' })
    } catch (err) {
      console.error(`heartbeatMonitor: check failed for ${workflow.id}:`, err.message)
    }
  }
  return transitions
}

let timer = null

function startHeartbeatMonitor() {
  if (timer) return timer
  timer = setInterval(() => {
    checkOnce()
  }, CHECK_INTERVAL_MS)
  timer.unref()
  return timer
}

// Stop sweeping (graceful shutdown). Alert state is a column, so the next
// boot resumes exactly where this one left off.
function stopHeartbeatMonitor() {
  if (!timer) return
  clearInterval(timer)
  timer = null
}

module.exports = { checkOnce, startHeartbeatMonitor, stopHeartbeatMonitor }
