// Bull processor for workflow executions. Started from index.js (not in tests).
const { getExecutionQueue } = require('../config/queue')
const { runExecution } = require('../services/executionEngine')
const { createNotification } = require('../services/notificationService')
const db = require('../config/database')

// If the run ended in failure, notify the workflow's owner. Reads the final
// status back from the DB (the engine handles node failures itself and returns
// normally), so this covers both engine failures and worker crashes. Never
// throws — a notification problem must not break the worker.
function notifyExecutionFailed(executionId) {
  try {
    const execution = db.prepare('SELECT * FROM executions WHERE id = ?').get(executionId)
    if (!execution || execution.status !== 'failed') return
    // Test (dry-run) runs are interactive — the user is watching the canvas — so a
    // failure there shouldn't raise a bell notification.
    if (execution.trigger_type === 'dry-run') return
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(execution.workflow_id)
    if (!workflow || !workflow.created_by) return
    createNotification(workflow.created_by, {
      type: 'execution-failed',
      title: 'Workflow Failed',
      message: `Your workflow "${workflow.name}" failed during execution`,
      link: `/workflow/${workflow.id}?execution=${executionId}`,
    })
  } catch (err) {
    console.error('Failed to create execution-failed notification:', err.message)
  }
}

// Phase 9 (load testing): Bull defaults to one job at a time, which serialises
// every execution and caps end-to-end throughput no matter how fast webhooks
// enqueue. Process up to EXEC_CONCURRENCY jobs concurrently — runExecution keeps
// all per-run state in locals and better-sqlite3 serialises writes on its single
// synchronous connection, so concurrent runs interleave safely at await points.
const CONCURRENCY = Math.max(1, Number(process.env.EXEC_CONCURRENCY || '10'))

function startWorker() {
  // Connect the exec-update publisher up front — with lazyConnect, publishes
  // issued while the first connection is still opening can be flushed late
  // and reach clients out of order.
  const redis = require('../config/redis')
  redis.connect().catch((err) => {
    console.error('Redis connect failed (exec-update events disabled):', err.message)
  })

  const queue = getExecutionQueue()

  queue.process(CONCURRENCY, async (job) => {
    const { executionId, payload, dryRun } = job.data
    try {
      await runExecution(executionId, { payload, dryRun })
    } catch (err) {
      // Engine handles per-node failures itself; this catches setup errors
      // (execution/workflow missing, DB issues) so the run never hangs.
      console.error(`Execution ${executionId} crashed:`, err.message)
      db.prepare(
        "UPDATE executions SET status = 'failed', finished_at = ? WHERE id = ?"
      ).run(new Date().toISOString(), executionId)
      notifyExecutionFailed(executionId)
      throw err
    }
    notifyExecutionFailed(executionId)
  })

  console.log(`Execution worker started (concurrency=${CONCURRENCY})`)
  return queue
}

module.exports = { startWorker, notifyExecutionFailed }
