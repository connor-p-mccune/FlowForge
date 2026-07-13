// Per-workflow run insights: duration percentiles, success rate, throughput,
// the slowest steps, and which recent runs were anomalously slow. Read-only and
// derived entirely from the executions/execution_steps already recorded — this
// endpoint runs no workflow and writes nothing. The statistics live in
// services/runStats.js (shared with the SLA monitor); this route is just the SQL
// that feeds it plus a workspace-membership check.

const express = require('express')
const db = require('../config/database')
const auth = require('../middleware/auth')
const { summarizeDurations, classifyRuns } = require('../services/runStats')

const router = express.Router()

// Milliseconds between a row's started_at/finished_at as a SQL expression
// (matches the analytics route). julianday() parses the trailing 'Z'; the
// difference is in days, so scale to ms. `alias` prefixes the columns when the
// query joins more than one table (e.g. 'es.' for execution_steps).
const durationMs = (alias = '') =>
  `(julianday(${alias}finished_at) - julianday(${alias}started_at)) * 86400000`
const DURATION_MS = durationMs()

// A workflow the requesting user may see, or null. Membership is checked through
// the workflow's workspace; a non-member gets the same null a missing id does,
// so the route can 404 both without revealing which one it was.
function getVisibleWorkflow(workflowId, userId) {
  const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId)
  if (!workflow) return null
  const member = db.prepare(
    'SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
  ).get(workflow.workspace_id, userId)
  return member ? workflow : null
}

// `limit` query param → an integer in [1, 500], defaulting to 50. The insight
// window is the last N real runs, not a fixed time range: a workflow that runs
// hourly and one that runs monthly both get a meaningful baseline.
function parseLimit(value) {
  const n = parseInt(value, 10)
  if (!Number.isFinite(n) || n <= 0) return 50
  return Math.min(n, 500)
}

const round = (v) => (v == null ? null : Math.round(v))

// Compute the insight bundle for a workflow from its recent runs. Pulled out of
// the handler so it can be reused by the public API (/api/v1) without going
// through the session-auth layer twice.
function computeInsights(workflowId, limit) {
  // Newest real runs first. Dry-runs (test mode) are excluded throughout — like
  // the status badge, insights reflect production behaviour, so a test run never
  // skews a percentile or trips an anomaly flag.
  const rows = db.prepare(`
    SELECT id, status, trigger_type, started_at, finished_at, created_at,
      CASE WHEN started_at IS NOT NULL AND finished_at IS NOT NULL
        THEN ${DURATION_MS} END AS duration_ms
    FROM executions
    WHERE workflow_id = ?
      AND (trigger_type IS NULL OR trigger_type != 'dry-run')
    ORDER BY created_at DESC, rowid DESC
    LIMIT ?
  `).all(workflowId, limit)

  const counts = { total: rows.length, completed: 0, failed: 0, cancelled: 0, running: 0 }
  for (const r of rows) {
    if (r.status === 'completed') counts.completed++
    else if (r.status === 'failed') counts.failed++
    else if (r.status === 'cancelled') counts.cancelled++
    else counts.running++
  }

  // Success rate over settled runs only. Cancelled runs are a human action, not
  // a failure, so they're excluded from the denominator rather than counted
  // against the workflow. Null when nothing has settled yet.
  const settled = counts.completed + counts.failed
  const successRate = settled > 0 ? counts.completed / settled : null

  // Duration percentiles are computed over completed runs only: a failed run's
  // wall time includes retry backoff and stops early at the failing node, so it
  // answers "how long until it broke", not "how long a run takes".
  const completedDurations = rows
    .filter((r) => r.status === 'completed' && typeof r.duration_ms === 'number')
    .map((r) => r.duration_ms)
  const durationSummary = summarizeDurations(completedDurations)

  // Anomaly flags are scored on the same completed-run durations, then attached
  // back to those runs; every other run is 'unknown' (it has no comparable
  // duration to judge). classifyRuns keeps input (newest-first) order.
  const classifiable = rows.map((r) => ({
    id: r.id,
    status: r.status,
    triggerType: r.trigger_type,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    createdAt: r.created_at,
    // Only completed runs contribute to and are judged against the baseline.
    durationMs: r.status === 'completed' ? round(r.duration_ms) : null,
  }))
  const recentRuns = classifyRuns(classifiable).map((r) => ({
    ...r,
    anomalyScore: r.anomalyScore == null ? null : Number(r.anomalyScore.toFixed(2)),
  }))
  const anomalyCount = recentRuns.filter((r) => r.isAnomaly).length

  // Throughput over the actual span the window covers — honest for both a
  // workflow that fires every minute and one that fires monthly. Null until
  // there are two runs to span.
  let throughput = { perDay: null, spanDays: null, runs: rows.length }
  if (rows.length >= 2) {
    const newest = new Date(rows[0].created_at).getTime()
    const oldest = new Date(rows[rows.length - 1].created_at).getTime()
    const spanDays = (newest - oldest) / 86400000
    throughput = {
      runs: rows.length,
      spanDays: Number(spanDays.toFixed(3)),
      perDay: spanDays > 0 ? Number((rows.length / spanDays).toFixed(2)) : null,
    }
  }

  // The slowest steps across this workflow's history, so "what should I
  // optimise" has an answer beyond a single run's critical path. Grouped by
  // node id (a specific step), averaged over successful executions only —
  // skipped steps are ~0ms and failed ones carry retry backoff. The client maps
  // node_id back to its label via the canvas graph it already holds.
  const slowestSteps = db.prepare(`
    SELECT es.node_id AS node_id, es.node_type AS node_type,
      COUNT(*) AS runs,
      AVG(${durationMs('es.')}) AS avg_ms,
      MAX(${durationMs('es.')}) AS max_ms
    FROM execution_steps es
    JOIN executions e ON e.id = es.execution_id
    WHERE e.workflow_id = ?
      AND es.status = 'succeeded'
      AND es.started_at IS NOT NULL AND es.finished_at IS NOT NULL
      AND es.node_type IS NOT NULL
    GROUP BY es.node_id
    ORDER BY avg_ms DESC
    LIMIT 5
  `).all(workflowId).map((r) => ({
    nodeId: r.node_id,
    nodeType: r.node_type,
    runs: r.runs,
    avgDurationMs: round(r.avg_ms),
    maxDurationMs: round(r.max_ms),
  }))

  return {
    window: {
      limit,
      runs: rows.length,
      since: rows.length ? rows[rows.length - 1].created_at : null,
      until: rows.length ? rows[0].created_at : null,
    },
    counts,
    successRate,
    throughput,
    duration: {
      count: durationSummary.count,
      min: round(durationSummary.min),
      max: round(durationSummary.max),
      mean: round(durationSummary.mean),
      stdev: round(durationSummary.stdev),
      p50: round(durationSummary.p50),
      p90: round(durationSummary.p90),
      p95: round(durationSummary.p95),
      p99: round(durationSummary.p99),
    },
    anomalyCount,
    slowestSteps,
    recentRuns,
  }
}

// GET /api/workflows/:id/insights?limit=N
router.get('/workflows/:id/insights', auth, (req, res) => {
  try {
    const workflow = getVisibleWorkflow(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    const limit = parseLimit(req.query.limit)
    res.json({ workflowId: workflow.id, ...computeInsights(workflow.id, limit) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
module.exports.computeInsights = computeInsights
module.exports.parseLimit = parseLimit
