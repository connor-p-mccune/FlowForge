// Cooperative run cancellation, shared by the session API and the public
// /api/v1 surface (each route does its own auth/membership check first).
//
// Cancelling is a two-phase handshake with the engine: the route sets
// cancel_requested on the execution row, and the engine — which polls the flag
// every time a node settles — stops launching new nodes, lets in-flight nodes
// finish, skips the rest, and finalizes the run as 'cancelled'. A run that is
// still queued (status 'pending') has no engine loop watching it yet, so it is
// finalized here directly; the worker then drops the job when it sees the
// terminal status.

const db = require('../config/database')

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

function publishCancelled(execution) {
  // Lazy require + swallowed failure, mirroring the engine's defaultPublish —
  // a Redis hiccup must not turn a successful cancel into a 500.
  const redis = require('../config/redis')
  redis
    .publish(
      'exec-update',
      JSON.stringify({
        kind: 'execution',
        workflowId: execution.workflow_id,
        executionId: execution.id,
        status: 'cancelled',
        error: null,
        dryRun: execution.trigger_type === 'dry-run',
      })
    )
    .catch((err) => console.error('Failed to publish exec-update:', err.message))
}

// Request cancellation of an execution row. Returns:
//   { outcome: 'finished' }   — already terminal, nothing to do
//   { outcome: 'cancelled' }  — was still queued; finalized immediately
//   { outcome: 'cancelling' } — running; the engine will wind it down
function requestCancel(execution) {
  if (TERMINAL.has(execution.status)) return { outcome: 'finished' }

  if (execution.status === 'pending') {
    const now = new Date().toISOString()
    db.prepare(
      "UPDATE executions SET status = 'cancelled', cancel_requested = 1, finished_at = ? WHERE id = ?"
    ).run(now, execution.id)
    publishCancelled(execution)
    return { outcome: 'cancelled' }
  }

  db.prepare('UPDATE executions SET cancel_requested = 1 WHERE id = ?').run(execution.id)
  return { outcome: 'cancelling' }
}

module.exports = { requestCancel }
