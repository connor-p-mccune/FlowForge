// Bull processor for workflow executions. Started from index.js (not in tests).
const { getExecutionQueue } = require('../config/queue')
const { runExecution } = require('../services/executionEngine')
const db = require('../config/database')

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
    const { executionId, payload } = job.data
    try {
      await runExecution(executionId, { payload })
    } catch (err) {
      // Engine handles per-node failures itself; this catches setup errors
      // (execution/workflow missing, DB issues) so the run never hangs.
      console.error(`Execution ${executionId} crashed:`, err.message)
      db.prepare(
        "UPDATE executions SET status = 'failed', finished_at = ? WHERE id = ?"
      ).run(new Date().toISOString(), executionId)
      throw err
    }
  })

  console.log(`Execution worker started (concurrency=${CONCURRENCY})`)
  return queue
}

module.exports = { startWorker }
