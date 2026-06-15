const express = require('express')
const db = require('../config/database')
const auth = require('../middleware/auth')

const router = express.Router()

// All analytics endpoints are workspace-scoped. Mirror the membership check used
// elsewhere: non-members get a 404 (don't reveal the workspace exists).
function isMember(workspaceId, userId) {
  return db.prepare(
    'SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
  ).get(workspaceId, userId)
}

// `days` query param → an integer in [1, 365], defaulting to 30.
function parseDays(value) {
  const n = parseInt(value, 10)
  if (!Number.isFinite(n) || n <= 0) return 30
  return Math.min(n, 365)
}

// Start of the analytics window: midnight UTC of the day `days - 1` days ago, so
// "last N days" means N whole calendar days including today. Returning to a day
// boundary (not now - N*24h) keeps the SQL range filter and the day-by-day
// timeline buckets perfectly aligned — no partial boundary day to drop.
function windowStart(days) {
  const now = new Date()
  const start = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)
  ))
  return start.toISOString()
}

// Milliseconds between two ISO timestamps, as a SQL expression. julianday()
// parses the trailing 'Z'; the difference is in days, so scale to ms.
const DURATION_MS = "(julianday(e.finished_at) - julianday(e.started_at)) * 86400000"

const round = (v) => (v == null ? null : Math.round(v))

// GET /api/workspaces/:wsId/analytics/summary?days=N
// Totals, success rate, and average duration over the window.
router.get('/workspaces/:wsId/analytics/summary', auth, (req, res) => {
  try {
    if (!isMember(req.params.wsId, req.user.id)) {
      return res.status(404).json({ error: 'Workspace not found' })
    }
    const days = parseDays(req.query.days)
    const since = windowStart(days)

    const row = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN e.status = 'completed' THEN 1 ELSE 0 END) AS successful,
        SUM(CASE WHEN e.status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN e.status NOT IN ('completed', 'failed') THEN 1 ELSE 0 END) AS running,
        AVG(CASE WHEN e.started_at IS NOT NULL AND e.finished_at IS NOT NULL
              THEN ${DURATION_MS} END) AS avg_ms
      FROM executions e
      JOIN workflows w ON w.id = e.workflow_id
      WHERE w.workspace_id = ? AND e.started_at >= ?
    `).get(req.params.wsId, since)

    const total = row.total || 0
    res.json({
      range: { days, since },
      summary: {
        totalExecutions: total,
        successful: row.successful || 0,
        failed: row.failed || 0,
        running: row.running || 0,
        successRate: total ? (row.successful || 0) / total : 0,
        avgDurationMs: round(row.avg_ms),
      },
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/workspaces/:wsId/analytics/timeline?days=N
// Daily completed/failed/other counts, gap-filled to a contiguous day series.
router.get('/workspaces/:wsId/analytics/timeline', auth, (req, res) => {
  try {
    if (!isMember(req.params.wsId, req.user.id)) {
      return res.status(404).json({ error: 'Workspace not found' })
    }
    const days = parseDays(req.query.days)
    const since = windowStart(days)

    const rows = db.prepare(`
      SELECT date(e.started_at) AS day,
        SUM(CASE WHEN e.status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN e.status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN e.status NOT IN ('completed', 'failed') THEN 1 ELSE 0 END) AS other,
        COUNT(*) AS total
      FROM executions e
      JOIN workflows w ON w.id = e.workflow_id
      WHERE w.workspace_id = ? AND e.started_at >= ?
      GROUP BY day
      ORDER BY day
    `).all(req.params.wsId, since)

    res.json({ range: { days, since }, timeline: fillDays(rows, days) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Zero-fill missing days so the chart x-axis is continuous. Bounded by `days`
// (≤ 365), and the buckets are already aggregated — this only pads gaps.
function fillDays(rows, days) {
  const byDay = new Map(rows.map((r) => [r.day, r]))
  const now = new Date()
  const out = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i
    ))
    const key = d.toISOString().slice(0, 10) // YYYY-MM-DD (UTC)
    const r = byDay.get(key)
    out.push({
      date: key,
      completed: r ? r.completed : 0,
      failed: r ? r.failed : 0,
      other: r ? r.other : 0,
      total: r ? r.total : 0,
    })
  }
  return out
}

// GET /api/workspaces/:wsId/analytics/node-usage
// Two aggregates merged by node type: how many nodes of each type exist across
// the workspace's graphs, and the average duration of successful steps per type.
router.get('/workspaces/:wsId/analytics/node-usage', auth, (req, res) => {
  try {
    if (!isMember(req.params.wsId, req.user.id)) {
      return res.status(404).json({ error: 'Workspace not found' })
    }

    // Static composition from the workflow graphs. graph_json is a denormalised
    // blob, so iterate its nodes array with json_each rather than scanning rows.
    const usageRows = db.prepare(`
      SELECT json_extract(node.value, '$.type') AS node_type, COUNT(*) AS cnt
      FROM workflows w, json_each(json_extract(w.graph_json, '$.nodes')) node
      WHERE w.workspace_id = ? AND json_extract(node.value, '$.type') IS NOT NULL
      GROUP BY node_type
    `).all(req.params.wsId)

    // Observed timing: average duration of successful steps, per node type.
    // (Skipped steps are ~0ms and failed steps include retry backoff, so both
    // would skew "how long does this node take" — restrict to succeeded.)
    const timingRows = db.prepare(`
      SELECT es.node_type AS node_type,
        COUNT(*) AS executions,
        AVG((julianday(es.finished_at) - julianday(es.started_at)) * 86400000) AS avg_ms
      FROM execution_steps es
      JOIN executions e ON e.id = es.execution_id
      JOIN workflows w ON w.id = e.workflow_id
      WHERE w.workspace_id = ?
        AND es.status = 'succeeded'
        AND es.started_at IS NOT NULL AND es.finished_at IS NOT NULL
        AND es.node_type IS NOT NULL
      GROUP BY es.node_type
    `).all(req.params.wsId)

    const byType = new Map()
    for (const r of usageRows) {
      byType.set(r.node_type, {
        nodeType: r.node_type, count: r.cnt, executions: 0, avgDurationMs: null,
      })
    }
    for (const r of timingRows) {
      const entry = byType.get(r.node_type) || {
        nodeType: r.node_type, count: 0, executions: 0, avgDurationMs: null,
      }
      entry.executions = r.executions
      entry.avgDurationMs = round(r.avg_ms)
      byType.set(r.node_type, entry)
    }

    // Most-used first, then by how often they actually ran.
    const nodeUsage = [...byType.values()].sort(
      (a, b) =>
        b.count - a.count ||
        b.executions - a.executions ||
        a.nodeType.localeCompare(b.nodeType)
    )
    res.json({ nodeUsage })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Whitelist of sortable columns → the SQL expression to order by. Keeps the
// user-supplied `sort` param out of the query string (no injection surface).
const WORKFLOW_SORTS = {
  name: 'name',
  executions: 'executions',
  successRate: 'success_rate',
  avgDurationMs: 'avg_ms',
  lastRun: 'last_run',
}

// GET /api/workspaces/:wsId/analytics/workflows?days=N&sort=&order=
// Per-workflow stats over the window. LEFT JOIN so workflows with no runs in the
// window still appear (executions = 0). The frontend table also sorts client-side.
router.get('/workspaces/:wsId/analytics/workflows', auth, (req, res) => {
  try {
    if (!isMember(req.params.wsId, req.user.id)) {
      return res.status(404).json({ error: 'Workspace not found' })
    }
    const days = parseDays(req.query.days)
    const since = windowStart(days)

    const sortCol = WORKFLOW_SORTS[req.query.sort] || 'executions'
    const order = String(req.query.order).toLowerCase() === 'asc' ? 'ASC' : 'DESC'

    const rows = db.prepare(`
      SELECT w.id, w.name,
        COUNT(e.id) AS executions,
        SUM(CASE WHEN e.status = 'completed' THEN 1 ELSE 0 END) AS successful,
        SUM(CASE WHEN e.status = 'failed' THEN 1 ELSE 0 END) AS failed,
        CAST(SUM(CASE WHEN e.status = 'completed' THEN 1 ELSE 0 END) AS REAL)
          / NULLIF(COUNT(e.id), 0) AS success_rate,
        AVG(CASE WHEN e.started_at IS NOT NULL AND e.finished_at IS NOT NULL
              THEN ${DURATION_MS} END) AS avg_ms,
        MAX(e.started_at) AS last_run
      FROM workflows w
      LEFT JOIN executions e
        ON e.workflow_id = w.id AND e.started_at >= ?
      WHERE w.workspace_id = ?
      GROUP BY w.id
      ORDER BY ${sortCol} ${order} NULLS LAST, w.name ASC
    `).all(since, req.params.wsId)

    res.json({
      range: { days, since },
      workflows: rows.map((r) => ({
        id: r.id,
        name: r.name,
        executions: r.executions,
        successful: r.successful || 0,
        failed: r.failed || 0,
        successRate: r.success_rate == null ? null : r.success_rate,
        avgDurationMs: round(r.avg_ms),
        lastRun: r.last_run,
      })),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
