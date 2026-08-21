// How long each node of a workflow takes, from what it has actually done.
//
// Three separate features want the same number and used to derive it three
// times: the run forecast (expected duration of the next run), the scheduler's
// launch order (`nodePriority.js` weights its ranks by it), and the concurrency
// analysis (`scheduleSim.js` needs a duration per node to simulate anything).
// One query, one set of rules about what counts, one place to change them.
//
// What counts, and why:
//
//   * **Succeeded steps only.** A failed step's wall time includes retry
//     backoff and stops at whatever broke, so it answers "how long until it
//     broke" rather than "how long this takes" — the same rule the insights
//     route applies to run durations.
//   * **Real runs only.** Dry runs simulate their side-effecting nodes, so an
//     HTTP node that takes 900ms in production takes 0ms in test mode. Letting
//     those into the sample would make every workflow look fast in exactly the
//     proportion somebody had been testing it.
//   * **The most recent N runs**, so a node that was rewritten last week is
//     described by last week's timings rather than by an average over its whole
//     history.
//   * **p50, not the mean.** Step durations are right-skewed — a cold cache or
//     one slow upstream call sits far above the body — and a mean is dragged
//     around by exactly that tail. This is the same argument `runStats.js`
//     makes for the percentile-and-MAD approach and the same one `statistics.js`
//     makes for rank-based tests.

const db = require('../config/database')
const { percentile } = require('./runStats')

// How many recent completed runs feed the timing sample.
const RUN_WINDOW = 200

const DURATION_MS =
  '(julianday(es.finished_at) - julianday(es.started_at)) * 86400000'

// Raw per-node duration samples for a workflow's recent completed real runs.
function durationSamples(workflowId, runWindow = RUN_WINDOW) {
  const rows = db.prepare(`
    SELECT es.node_id AS node_id, es.node_type AS node_type, ${DURATION_MS} AS ms
    FROM execution_steps es
    JOIN executions e ON e.id = es.execution_id
    WHERE es.status = 'succeeded'
      AND es.started_at IS NOT NULL AND es.finished_at IS NOT NULL
      AND es.node_type IS NOT NULL
      AND e.id IN (
        SELECT id FROM executions
        WHERE workflow_id = ? AND status = 'completed'
          AND (trigger_type IS NULL OR trigger_type != 'dry-run')
        ORDER BY created_at DESC LIMIT ?
      )
  `).all(workflowId, runWindow)

  const byNode = new Map()
  for (const r of rows) {
    if (typeof r.ms !== 'number' || !Number.isFinite(r.ms)) continue
    if (!byNode.has(r.node_id)) byNode.set(r.node_id, { durations: [], nodeType: r.node_type })
    byNode.get(r.node_id).durations.push(Math.max(0, r.ms))
  }
  return byNode
}

// `{ [nodeId]: { p50, p95, samples, nodeType } }` — the shape the forecast and
// the concurrency analysis both consume.
function stepStats(workflowId, runWindow = RUN_WINDOW) {
  const stats = {}
  for (const [nodeId, { durations, nodeType }] of durationSamples(workflowId, runWindow)) {
    stats[nodeId] = {
      p50: percentile(durations, 50),
      p95: percentile(durations, 95),
      samples: durations.length,
      nodeType,
    }
  }
  return stats
}

// The scheduler's weights: `{ [nodeId]: medianMs }`, for nodes with any history
// at all. Nodes absent from the result are given a neutral prior by
// `nodePriority.js` rather than a zero — see the note there about why an
// unmeasured node must not sort last.
//
// One indexed aggregate per run is a real cost on the run's critical path, so
// this is memoised per workflow for a short window. Staleness is harmless by
// construction: the weights only order a ready set, and Graham's bound holds
// for *any* order, so a launch plan built from timings a minute old is at worst
// slightly less good — never wrong. `resetCache()` exists so a test that writes
// history and then executes can see it immediately.
const CACHE_TTL_MS = Math.max(0, Number(process.env.STEP_TIMING_CACHE_MS ?? 30000))
const cache = new Map() // workflowId → { at, weights }

function expectedDurations(workflowId) {
  const hit = cache.get(workflowId)
  const now = Date.now()
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.weights

  const weights = {}
  for (const [nodeId, { durations }] of durationSamples(workflowId)) {
    const p50 = percentile(durations, 50)
    if (typeof p50 === 'number' && Number.isFinite(p50)) weights[nodeId] = p50
  }
  cache.set(workflowId, { at: now, weights })
  return weights
}

function resetCache() {
  cache.clear()
}

module.exports = {
  RUN_WINDOW,
  durationSamples,
  stepStats,
  expectedDurations,
  resetCache,
}
