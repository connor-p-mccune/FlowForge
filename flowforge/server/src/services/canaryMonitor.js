// The sweep that acts on a canary's verdict.
//
// It sits in the same family as the heartbeat and maintenance-window monitors,
// and for the same reason: the thing it waits for — "enough runs have
// accumulated to judge this" — is the passage of time rather than an event, so
// there is nothing to hook. Each pass re-analyses every running canary and, when
// the workflow opted into automation, promotes or rolls it back.
//
// Three properties keep it from doing damage:
//
//   * **A canary that hasn't earned a verdict is left alone.** `analyze`
//     returns `wait` until both arms have a usable sample, and this does
//     nothing with a `wait`.
//   * **Every action is idempotent and terminal.** Promotion clears the canary
//     inside the same transaction that snapshots the version; rollback moves
//     the state to `rolled_back` and traffic to 0%. Neither can fire twice,
//     because the next pass no longer sees a `running` canary.
//   * **It is best-effort per workflow.** One workflow whose analysis throws
//     must not stop the sweep for everyone else — the same contract the other
//     monitors hold.
//
// Auto-rollback is on by default and auto-promotion is deliberate rather than
// automatic-by-default in spirit: rolling back is reversible (the canvas still
// holds the edits) while promoting is what makes something live everywhere. A
// workflow can opt out of both with `auto: false`, in which case this reports
// and a person decides.

const db = require('../config/database')
const canary = require('./canary')
const activityService = require('./activityService')
const notificationService = require('./notificationService')

let timer = null

function runningCanaries() {
  return db.prepare(
    "SELECT * FROM workflows WHERE canary_state = 'running' AND canary_baseline_version_id IS NOT NULL"
  ).all()
}

// Notify the workflow's owner and record the transition in the workspace feed.
// Reuses the two surfaces every other monitor uses rather than inventing a
// third alerting channel.
function announce(workflow, eventType, message) {
  try {
    activityService.logEvent(workflow.workspace_id, null, eventType, {
      type: 'workflow',
      id: workflow.id,
      name: workflow.name,
      metadata: { message },
    })
  } catch (err) {
    console.error(`Canary activity event failed for ${workflow.id}: ${err.message}`)
  }
  try {
    notificationService.createNotification(workflow.created_by, {
      type: eventType,
      title: `${workflow.name}: ${eventType === 'workflow.canary_promoted' ? 'canary promoted' : 'canary rolled back'}`,
      message,
      link: `/workflow/${workflow.id}`,
    })
  } catch (err) {
    console.error(`Canary notification failed for ${workflow.id}: ${err.message}`)
  }
}

// Snapshot the live graph as the next version. Mirrors the deploy route's own
// snapshot so a promotion is indistinguishable from a deploy in history —
// because that is exactly what it is.
function snapshotVersion(workflow) {
  const { v4: uuidv4 } = require('uuid')
  const next =
    (db.prepare('SELECT MAX(version) AS max FROM workflow_versions WHERE workflow_id = ?')
      .get(workflow.id).max || 0) + 1
  const id = uuidv4()
  db.prepare(
    `INSERT INTO workflow_versions (id, workflow_id, version, graph_json, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, workflow.id, next, workflow.graph_json, workflow.created_by, new Date().toISOString())
  return { id, version: next }
}

// One pass. Exported so a test can drive it directly rather than waiting on a
// timer — the same shape the heartbeat and maintenance sweeps use.
function sweepCanaries() {
  for (const workflow of runningCanaries()) {
    try {
      const analysis = canary.analyze(workflow)
      if (!analysis.active || !analysis.auto) continue

      if (analysis.recommendation === 'rollback') {
        canary.rollback(workflow.id, { reason: analysis.reason })
        announce(
          workflow,
          'workflow.canary_rolled_back',
          `Canary rolled back automatically: ${analysis.reason}. Stable traffic continues on the baseline version; your canvas is unchanged.`
        )
      } else if (analysis.recommendation === 'promote') {
        canary.promote(workflow, { snapshot: () => snapshotVersion(workflow) })
        announce(
          workflow,
          'workflow.canary_promoted',
          `Canary promoted automatically: ${analysis.reason}.`
        )
      }
    } catch (err) {
      // Best-effort per workflow: one bad analysis must not stop the sweep.
      console.error(`Canary sweep failed for ${workflow.id}: ${err.message}`)
    }
  }
}

function startCanaryMonitor() {
  if (timer) return timer
  timer = setInterval(sweepCanaries, canary.CHECK_INTERVAL_MS)
  if (timer.unref) timer.unref()
  return timer
}

function stopCanaryMonitor() {
  if (timer) clearInterval(timer)
  timer = null
}

module.exports = { sweepCanaries, startCanaryMonitor, stopCanaryMonitor, snapshotVersion }
