// Schedule-trigger scheduler.
//
// Owns the set of active node-cron jobs (one per deployed workflow that has a
// `trigger-schedule` node). On each cron tick it enqueues a workflow execution
// onto the same Bull queue the webhook/manual triggers use, so scheduled runs
// flow through the existing worker + execution engine unchanged.
//
// Multi-instance safety: before enqueuing, a tick takes a short-lived Redis lock
// (`SET key NX EX`) and releases it immediately after enqueuing. If two server
// instances fire the same tick, only the lock winner enqueues — the other
// no-ops. The release is unconditional ("literal immediate release"): enqueue is
// far quicker than the TTL, and the TTL is only a crash safety-net so a process
// that dies mid-tick can't wedge the schedule. (A perfectly-safe release would
// delete only its own token; with a single deployed instance the simple form is
// sufficient and the TTL bounds any worst case.)
const cron = require('node-cron')
const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const redis = require('../config/redis')
const { getExecutionQueue } = require('../config/queue')
const { admitRun } = require('../services/concurrencyGate')

// workflowId -> { task, cron } for every currently-registered schedule.
const activeTasks = new Map()

// Crash safety-net only — released immediately after enqueue, well within this.
const LOCK_TTL = Number(process.env.SCHEDULE_LOCK_TTL_SECONDS || 30)

// node-cron accepts 5- and 6-field expressions; reject empties/non-strings up
// front so callers get a clean false rather than a thrown error.
function validateCron(expr) {
  return typeof expr === 'string' && expr.trim().length > 0 && cron.validate(expr.trim())
}

// One cron tick: enqueue an execution for the workflow if we win the lock and the
// workflow is still deployed with a runnable graph. Always resolves (never throws)
// so a failing tick can't crash the cron runner.
async function runScheduledExecution(workflowId) {
  const lockKey = `lock:schedule:${workflowId}`
  let acquired = false
  try {
    acquired = (await redis.set(lockKey, '1', 'EX', LOCK_TTL, 'NX')) === 'OK'
  } catch (err) {
    console.error(`Schedule lock failed for ${workflowId}:`, err.message)
    return
  }
  if (!acquired) return // another instance is handling this tick

  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId)
    if (!workflow || workflow.status !== 'deployed') return

    let nodes = []
    try {
      nodes = JSON.parse(workflow.graph_json).nodes || []
    } catch {
      nodes = []
    }
    if (nodes.length === 0) return

    // 'reject' concurrency policy: skip this tick at the cap — for a cron
    // workflow, dropping a tick against a still-busy previous run is exactly
    // the "don't overlap" behavior the limit asks for. The next tick retries.
    const admission = admitRun(workflow)
    if (!admission.ok) {
      console.log(`Schedule tick skipped for ${workflowId}: ${admission.error}`)
      return
    }

    const executionId = uuidv4()
    const now = new Date().toISOString()
    // Scheduled ticks carry no payload; trigger_type marks the source for history.
    db.prepare(
      'INSERT INTO executions (id, workflow_id, status, triggered_by, trigger_type, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(executionId, workflow.id, 'pending', null, 'schedule', now)

    await getExecutionQueue().add({ executionId, workflowId: workflow.id, payload: {} })
  } catch (err) {
    console.error(`Scheduled run failed for ${workflowId}:`, err.message)
  } finally {
    if (acquired) {
      try {
        await redis.del(lockKey)
      } catch {
        /* the TTL will reap it */
      }
    }
  }
}

// Register (or replace) the cron job for a workflow. Throws on an invalid cron so
// callers (the deploy route) can surface a clear error before activating.
function registerSchedule(workflowId, cronExpression) {
  const expr = typeof cronExpression === 'string' ? cronExpression.trim() : ''
  if (!validateCron(expr)) {
    throw new Error(`Invalid cron expression: ${JSON.stringify(cronExpression)}`)
  }
  unregisterSchedule(workflowId) // replace any existing job for this workflow
  const task = cron.schedule(expr, () => {
    runScheduledExecution(workflowId).catch((err) =>
      console.error(`Schedule tick error for ${workflowId}:`, err.message)
    )
  })
  activeTasks.set(workflowId, { task, cron: expr })
  return expr
}

// Stop and forget a workflow's cron job. Returns whether one was active.
function unregisterSchedule(workflowId) {
  const entry = activeTasks.get(workflowId)
  if (!entry) return false
  entry.task.stop()
  activeTasks.delete(workflowId)
  return true
}

// Re-register cron jobs for every deployed workflow that has a schedule trigger.
// Called once on server startup so schedules survive a restart. Returns the count
// restored. Bad rows are skipped (logged) rather than aborting the whole restore.
function restoreSchedules() {
  const deployed = db.prepare("SELECT * FROM workflows WHERE status = 'deployed'").all()
  let count = 0
  for (const wf of deployed) {
    try {
      const { nodes } = JSON.parse(wf.graph_json)
      const scheduleNode = (nodes || []).find((n) => n.type === 'trigger-schedule')
      const cronExpr = scheduleNode?.data?.config?.cron
      if (scheduleNode && validateCron(cronExpr)) {
        registerSchedule(wf.id, cronExpr)
        count++
      }
    } catch (err) {
      console.error(`Failed to restore schedule for ${wf.id}:`, err.message)
    }
  }
  if (count > 0) console.log(`Restored ${count} workflow schedule(s).`)
  return count
}

// Stop every active cron job (graceful shutdown). Schedules are re-derived
// from deployed workflows on the next boot via restoreSchedules.
function stopAllSchedules() {
  for (const workflowId of [...activeTasks.keys()]) unregisterSchedule(workflowId)
}

module.exports = {
  validateCron,
  registerSchedule,
  unregisterSchedule,
  restoreSchedules,
  runScheduledExecution,
  stopAllSchedules,
  // exposed for tests
  _activeTasks: activeTasks,
}
