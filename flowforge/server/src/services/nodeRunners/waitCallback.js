// Wait-for-callback node: pauses the run until an external system POSTs to the
// node's one-time callback URL, then continues with the delivered payload —
// the machine-in-the-loop counterpart to the approval node's human gate. The
// engine arms the row (and mints the token) at run start, so an upstream node
// can send {{callbacks.<node-id>}} out and an early reply can never be lost:
// this runner adopts an already-received payload instantly, otherwise flips
// the row armed→waiting and polls it — the same row-is-the-only-
// synchronization-point pattern approvals use — until the callback lands, the
// run is cancelled, or the wait passes its deadline.
//
// Branches like approval: settles result 'received' or 'timed-out' and the
// engine activates the outgoing edge whose sourceHandle matches. onTimeout
// 'fail' opts a silent callback into failing the run instead of taking the
// timed-out branch. The engine gives this type a single attempt — a retry
// would wait the full timeout twice on a dead integration.

const db = require('../../config/database')

const DEFAULT_TIMEOUT_MINUTES = 60
const MAX_TIMEOUT_MINUTES = 7 * 24 * 60 // one week

// Read per call so a test can shrink the wait without re-requiring the module.
function pollIntervalMs() {
  const n = parseInt(process.env.CALLBACK_POLL_MS || '1500', 10)
  return Number.isFinite(n) && n >= 10 ? n : 1500
}

function timeoutMinutes(config) {
  const n = Number(config?.timeoutMinutes)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MINUTES
  return Math.min(n, MAX_TIMEOUT_MINUTES)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function parsePayload(row) {
  if (!row.payload_json) return {}
  try {
    return JSON.parse(row.payload_json)
  } catch {
    return {}
  }
}

module.exports = async function waitCallback(config, input, isDryRun, ctx = {}) {
  // Test mode never blocks: report that the run would wait here and take the
  // received branch so the rest of the graph stays testable.
  if (isDryRun) return { result: 'received', payload: {}, simulated: true }

  const executionId = ctx.parentExecutionId
  const nodeId = ctx.parentNodeId
  if (!executionId || !nodeId) {
    throw new Error('Wait-for-callback node requires an execution context')
  }

  const row = db
    .prepare('SELECT * FROM execution_callbacks WHERE execution_id = ? AND node_id = ?')
    .get(executionId, nodeId)
  if (!row) throw new Error('Wait-for-callback node has no armed callback for this run')

  const expiresAt = new Date(Date.now() + timeoutMinutes(config) * 60_000)
  // armed → waiting stamps the deadline. Guarded on 'armed' so a callback
  // landing this very instant isn't overwritten — zero changes means the row
  // already settled, and the poll below reads the verdict on its first pass.
  db.prepare(
    "UPDATE execution_callbacks SET status = 'waiting', expires_at = ? WHERE id = ? AND status = 'armed'"
  ).run(expiresAt.toISOString(), row.id)

  // Ride the exec-update channel so an open canvas can show the callback URL
  // (copy-paste for a manual test, reassurance for a live one) while the run
  // waits. The step settling right after the callback lands clears it.
  if (ctx.publish) {
    ctx.publish({
      kind: 'callback',
      workflowId: row.workflow_id,
      executionId,
      nodeId,
      status: 'waiting',
      url: `/api/callbacks/${row.token}`,
      expiresAt: expiresAt.toISOString(),
    })
  }

  const readRow = db.prepare('SELECT * FROM execution_callbacks WHERE id = ?')
  const readCancel = db.prepare('SELECT cancel_requested FROM executions WHERE id = ?')
  const settle = db.prepare(
    "UPDATE execution_callbacks SET status = ? WHERE id = ? AND status IN ('armed', 'waiting')"
  )

  for (;;) {
    const current = readRow.get(row.id)
    if (current.status === 'received') {
      return {
        result: 'received',
        payload: parsePayload(current),
        receivedAt: current.received_at,
      }
    }

    // Run cancelled mid-wait: retire the token so a late delivery can't land,
    // then settle normally — the engine's own cancel check winds the run down
    // before anything downstream can launch.
    if (readCancel.get(executionId)?.cancel_requested) {
      settle.run('cancelled', row.id)
      return { result: 'cancelled', payload: null }
    }

    if (Date.now() >= expiresAt.getTime()) {
      const { changes } = settle.run('timed-out', row.id)
      // Lost the race to a callback arriving this instant — re-read it.
      if (changes === 0) continue
      if ((config?.onTimeout || 'continue') === 'fail') {
        throw new Error(`Callback wait timed out after ${timeoutMinutes(config)} minutes`)
      }
      return { result: 'timed-out', payload: null }
    }

    await sleep(pollIntervalMs())
  }
}
