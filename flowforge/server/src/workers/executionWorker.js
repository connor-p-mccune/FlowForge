// Bull processor for workflow executions. Started from index.js (not in tests).
const { getExecutionQueue } = require('../config/queue')
const { runExecution } = require('../services/executionEngine')
const { createNotification } = require('../services/notificationService')
const { acquireSlot, releaseSlot } = require('../services/concurrencyGate')
const { recordRunDeferred } = require('../services/metrics')
const fairShare = require('../services/fairShare')
const { levelOf } = require('../services/runPriority')
const { evaluateRun } = require('../services/slaMonitor')
const { triggerErrorHandler } = require('../services/errorHandler')
const db = require('../config/database')

// After a top-level run settles, check it against its workflow's SLA targets and
// the statistical anomaly baseline, raising an alert on a breach. Best-effort:
// evaluateRun swallows its own errors, and this wrapper guards the require path
// too so a monitoring fault can never surface as a run failure. The worker only
// ever handles top-level runs (sub-workflow child runs execute inside the parent
// engine loop), so this is exactly the "top-level, settled, real run" hook the
// monitor wants.
function evaluateRunSla(executionId) {
  try {
    evaluateRun(executionId)
  } catch (err) {
    console.error('SLA evaluation failed:', err.message)
  }
}

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

// How long a run at its workflow's concurrency cap waits before re-checking.
const DEFER_DELAY_MS = Math.max(100, Number(process.env.CONCURRENCY_RETRY_MS || '1000'))

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
    const { executionId, workflowId, payload, dryRun } = job.data

    // Per-workflow concurrency cap. A run at the cap is re-parked with a short
    // delay instead of held — this Bull slot frees for other workflows and the
    // clone re-checks once DEFER_DELAY_MS passes. Dry runs are interactive and
    // exempt: they neither consume slots nor wait on them. The re-park carries
    // the job's Bull priority forward — deferral must not silently demote a
    // high-lane run to the back of the normal queue.
    const gated = !dryRun && Boolean(workflowId)

    // Fair queueing between workflows (services/fairShare.js), checked first
    // because it is the cheaper refusal and because a run held for fairness has
    // not consumed a concurrency slot it would then have to give back.
    //
    // Priority lanes order runs *between* lanes; within a lane the queue is
    // FIFO, so a workflow that submits five thousand runs is ahead of
    // everybody else's next one for as long as that takes. Fairness is judged
    // within the lane for exactly that reason — a high-priority run must never
    // wait on a normal-priority one.
    const lane = levelOf(job.opts?.priority)
    if (gated) {
      const share = fairShare.admit(workflowId, { lane, deferrals: job.data.fairDeferrals || 0 })
      if (!share.allowed) {
        fairShare.recordDeferred(workflowId, lane)
        await queue.add(
          { ...job.data, fairDeferrals: (job.data.fairDeferrals || 0) + 1 },
          {
            delay: DEFER_DELAY_MS,
            ...(job.opts?.priority != null ? { priority: job.opts.priority } : {}),
          }
        )
        return
      }
    }

    if (gated && !acquireSlot(workflowId)) {
      recordRunDeferred()
      await queue.add(job.data, {
        delay: DEFER_DELAY_MS,
        ...(job.opts?.priority != null ? { priority: job.opts.priority } : {}),
      })
      return
    }
    // Counted only once the run is genuinely starting, so a run turned away by
    // the concurrency cap does not spend its workflow's share of a queue it
    // never entered.
    if (gated) fairShare.recordStart(workflowId, lane)

    try {
      await runExecution(executionId, { payload, dryRun })
    } catch (err) {
      // Engine handles per-node failures itself; this catches setup errors
      // (execution/workflow missing, DB issues) so the run never hangs.
      console.error(`Execution ${executionId} crashed:`, err.message)
      // Guarded on the run not having settled already. A setup error is the
      // case this catches, but the same path is reached when the engine's own
      // lease was taken mid-run — and overwriting the adopting worker's
      // terminal status with this one's would undo the recovery.
      db.prepare(
        `UPDATE executions SET status = 'failed', finished_at = ?
          WHERE id = ? AND status IN ('pending', 'running')`
      ).run(new Date().toISOString(), executionId)
      notifyExecutionFailed(executionId)
      evaluateRunSla(executionId)
      // Fire-and-forget: the handler run is its own execution through the
      // queue — awaiting it here would hold this Bull slot through an
      // unrelated workflow, and triggerErrorHandler never rejects.
      triggerErrorHandler(executionId)
      throw err
    } finally {
      if (gated) releaseSlot(workflowId)
    }
    notifyExecutionFailed(executionId)
    evaluateRunSla(executionId)
    triggerErrorHandler(executionId)
  })

  console.log(`Execution worker started (concurrency=${CONCURRENCY})`)
  return queue
}

module.exports = { startWorker, notifyExecutionFailed }
