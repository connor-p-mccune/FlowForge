// Bull processor for workflow executions. Started from index.js (not in tests).
const { getExecutionQueue } = require('../config/queue')
const { runExecution } = require('../services/executionEngine')
const db = require('../config/database')

function startWorker() {
  // Connect the exec-update publisher up front — with lazyConnect, publishes
  // issued while the first connection is still opening can be flushed late
  // and reach clients out of order.
  const redis = require('../config/redis')
  redis.connect().catch((err) => {
    console.error('Redis connect failed (exec-update events disabled):', err.message)
  })

  const queue = getExecutionQueue()

  queue.process(async (job) => {
    const { executionId } = job.data
    try {
      await runExecution(executionId)
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

  console.log('Execution worker started')
  return queue
}

module.exports = { startWorker }
