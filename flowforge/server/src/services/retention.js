// Data retention: keep the database from growing without bound on a busy
// instance. Two independent policies, both age-based and swept together:
//
// - **Executions** (opt-in): with EXECUTION_RETENTION_DAYS set > 0, terminal
//   runs (completed/failed/cancelled) older than the window are deleted.
//   Steps and approval rows cascade with their execution; a child run whose
//   parent is deleted first just detaches (ON DELETE SET NULL) until its own
//   age catches up. Unset or 0 keeps everything forever — history is a
//   feature, so pruning it is a deliberate choice.
// - **Webhook deliveries** (on by default): settled rows (delivered/failed)
//   older than WEBHOOK_DELIVERY_RETENTION_DAYS (default 30) are pruned. The
//   delivery log is a debugging surface, not an archive; pending rows are
//   never touched — they're the queue.
//
// The sweep runs at startup and every 6 hours. Deletes are bounded per pass
// so a first sweep over a years-old database can't hold the synchronous
// SQLite connection for seconds; the next pass picks up where it left off.

const db = require('../config/database')

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000
const MAX_DELETES_PER_PASS = 5000

function executionRetentionDays() {
  const n = parseInt(process.env.EXECUTION_RETENTION_DAYS || '0', 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function deliveryRetentionDays() {
  const n = parseInt(process.env.WEBHOOK_DELIVERY_RETENTION_DAYS || '30', 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

const cutoffIso = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

// One sweep pass. Returns { executions, deliveries } deleted counts (handy
// for tests and the startup log line).
function sweepOnce() {
  const result = { executions: 0, deliveries: 0 }

  const execDays = executionRetentionDays()
  if (execDays > 0) {
    result.executions = db.prepare(
      `DELETE FROM executions
        WHERE id IN (
          SELECT id FROM executions
           WHERE status IN ('completed', 'failed', 'cancelled')
             AND created_at < ?
           LIMIT ?
        )`
    ).run(cutoffIso(execDays), MAX_DELETES_PER_PASS).changes
  }

  const deliveryDays = deliveryRetentionDays()
  if (deliveryDays > 0) {
    result.deliveries = db.prepare(
      `DELETE FROM event_deliveries
        WHERE id IN (
          SELECT id FROM event_deliveries
           WHERE status IN ('delivered', 'failed')
             AND created_at < ?
           LIMIT ?
        )`
    ).run(cutoffIso(deliveryDays), MAX_DELETES_PER_PASS).changes
  }

  return result
}

let timer = null

function startRetention() {
  if (timer) return timer
  try {
    const first = sweepOnce()
    if (first.executions || first.deliveries) {
      console.log(
        `Retention sweep: removed ${first.executions} old execution(s), ${first.deliveries} settled webhook deliveries`
      )
    }
  } catch (err) {
    console.error('Retention sweep failed:', err.message)
  }
  timer = setInterval(() => {
    try {
      sweepOnce()
    } catch (err) {
      console.error('Retention sweep failed:', err.message)
    }
  }, SWEEP_INTERVAL_MS)
  timer.unref()
  return timer
}

// Stop sweeping (graceful shutdown). Age-based cleanup safely resumes on the
// next boot.
function stopRetention() {
  if (!timer) return
  clearInterval(timer)
  timer = null
}

module.exports = { sweepOnce, startRetention, stopRetention }
