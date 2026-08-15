// Regression attribution — *what changed* when a workflow's behaviour changed.
//
// `changePoint.js` answers "when did this get slower?". On its own that is half
// an answer: somebody still has to work out what happened on the 12th. This
// module supplies the other half from data the product already keeps, and the
// pairing is the whole feature —
//
//     Order sync got 4.6× slower on 12 Jan (210ms → 970ms over 84 runs).
//     Version 7 was deployed 40 minutes earlier and changed Fetch orders'
//     config.url. The step that moved is Fetch orders: 90ms → 850ms.
//
// — every clause of which is derived rather than typed.
//
// Three joins do it, and each is worth stating because each has a case where it
// declines to answer:
//
//   * **Deploys.** `workflow_versions` records a snapshot per deploy with a
//     timestamp, so the deploys that could explain a change are exactly those
//     landing between the last run of the old behaviour and the first run of
//     the new one. One is a suspect; several are a list; **none is a finding in
//     its own right** — the cause is outside this workflow, which is the answer
//     that stops somebody re-reading their own diff for an afternoon.
//
//   * **What the deploy changed.** The snapshot before it is also stored, so
//     the suspect comes with the semantic diff (`graphDiff.js`) that the
//     history drawer already renders. A version number is a pointer; "changed
//     Fetch orders' config.url" is the answer.
//
//   * **Which step moved.** A run's duration is the sum of a path through its
//     steps, and `execution_steps` keeps every one of them. Running the same
//     detector per node finds the step whose own timing shifted at the same
//     moment — so the finding names a node on the canvas rather than a
//     workflow.
//
// Nothing here is a monitor. It raises no alerts and writes nothing; it is a
// question someone asks about a workflow that already looks wrong, and the
// answer is derived from rows that were being kept anyway.

const db = require('../config/database')
const { detectChangePoints } = require('./changePoint')
const { diffGraphs } = require('./graphDiff')

// How many recent runs the analysis reads. Change-point detection over a very
// long history is both slower and less useful — a regime change from eight
// months ago is history, not a regression.
const DEFAULT_LIMIT = 300
const MAX_LIMIT = 1000

// Milliseconds between a row's started_at/finished_at, as the analytics and
// insights routes compute it: julianday() parses the trailing 'Z' and returns
// days, so scale.
const durationMs = (alias = '') =>
  `(julianday(${alias}finished_at) - julianday(${alias}started_at)) * 86400000`

// Rounded to the millisecond, which is the resolution the timestamps actually
// have, and for the reason the canary analysis rounds before ranking:
// julianday()'s floating-point subtraction leaves sub-microsecond dust that
// varies with the absolute date, so two genuinely identical durations recorded
// a month apart come back unequal. Every statistic here is rank-based, and a
// rank test handed that dust reads it as a systematic ordering — which, across
// a series that necessarily spans time, is exactly the shape of the thing being
// looked for.
const toMs = (value) => (typeof value === 'number' ? Math.round(value) : value)

function parseLimit(value) {
  const n = parseInt(value, 10)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(n, MAX_LIMIT)
}

// The population every duration statistic in this codebase uses: completed,
// real (non-dry-run), top-level runs, in chronological order. Failed runs are
// excluded for the reason the insights percentiles exclude them — a failed
// run's wall time measures how long it took to break, which is a different
// quantity and would move the median for reasons that are not a regression.
function completedRuns(workflowId, limit) {
  return db
    .prepare(
      `SELECT id, created_at, finished_at, ${durationMs()} AS duration_ms
         FROM executions
        WHERE workflow_id = ?
          AND status = 'completed'
          AND started_at IS NOT NULL
          AND finished_at IS NOT NULL
          AND parent_execution_id IS NULL
          AND (trigger_type IS NULL OR trigger_type != 'dry-run')
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?`
    )
    .all(workflowId, limit)
    .reverse()
    .map((r) => ({ at: r.created_at, value: toMs(r.duration_ms), executionId: r.id }))
}

// Per-step durations for the same population, keyed by node. Read in one query
// rather than per node: a workflow with twenty nodes over three hundred runs is
// six thousand rows, which SQLite returns in one pass and JavaScript groups
// faster than twenty round trips.
function stepSeries(workflowId, limit) {
  const rows = db
    .prepare(
      `SELECT s.node_id, s.node_type, e.created_at, ${durationMs('s.')} AS duration_ms
         FROM execution_steps s
         JOIN executions e ON e.id = s.execution_id
        WHERE e.workflow_id = ?
          AND e.status = 'completed'
          AND e.parent_execution_id IS NULL
          AND (e.trigger_type IS NULL OR e.trigger_type != 'dry-run')
          AND s.status = 'succeeded'
          AND s.started_at IS NOT NULL
          AND s.finished_at IS NOT NULL
          AND e.created_at >= (
            SELECT MIN(created_at) FROM (
              SELECT created_at FROM executions
               WHERE workflow_id = ? AND status = 'completed'
               ORDER BY created_at DESC LIMIT ?
            )
          )
        ORDER BY e.created_at`
    )
    .all(workflowId, workflowId, limit)

  const byNode = new Map()
  for (const row of rows) {
    if (!byNode.has(row.node_id)) {
      byNode.set(row.node_id, { nodeId: row.node_id, nodeType: row.node_type, points: [] })
    }
    byNode.get(row.node_id).points.push({ at: row.created_at, value: toMs(row.duration_ms) })
  }
  return [...byNode.values()]
}

// The deploys that landed in the window a change point brackets. Half-open at
// the start: a deploy at exactly the instant of the last old-behaviour run
// cannot have caused that run, and including it would attribute the change to
// something that had not happened yet from that run's point of view.
function deploysBetween(workflowId, previousAt, at) {
  return db
    .prepare(
      `SELECT v.id, v.version, v.graph_json, v.created_at, u.display_name AS created_by_name
         FROM workflow_versions v
         LEFT JOIN users u ON u.id = v.created_by
        WHERE v.workflow_id = ?
          AND v.created_at > ?
          AND v.created_at <= ?
        ORDER BY v.version`
    )
    .all(workflowId, previousAt, at)
}

// What a deploy actually changed, against the snapshot before it. Returns null
// for the very first version — there is nothing to compare it to, and inventing
// "everything was added" would drown the real signal in every other case.
function describeDeploy(workflowId, version) {
  const previous = db
    .prepare(
      `SELECT graph_json FROM workflow_versions
        WHERE workflow_id = ? AND version < ?
        ORDER BY version DESC LIMIT 1`
    )
    .get(workflowId, version.version)
  if (!previous) return null

  let diff
  try {
    diff = diffGraphs(JSON.parse(previous.graph_json), JSON.parse(version.graph_json))
  } catch {
    return null
  }
  return {
    changedNodes: diff.changedNodes.map((c) => ({
      nodeId: c.node.id,
      label: c.node.data?.label || c.node.id,
      changes: c.changes,
    })),
    addedNodes: diff.addedNodes.map((n) => n.id),
    removedNodes: diff.removedNodes.map((n) => n.id),
    rewiredEdges: diff.addedEdges.length + diff.removedEdges.length,
    identical: diff.identical,
  }
}

// Which step's own timing moved at the same moment the run's did. "The same
// moment" is deliberately loose — a step series has its own runs and its own
// change points, so the match is by proximity in time rather than by index —
// and a step whose change lands somewhere else entirely is not reported, since
// it is answering a different question than the one being asked.
const CO_LOCATION_TOLERANCE_MS = 60 * 60 * 1000

function attributeToSteps(steps, changePoint) {
  const target = new Date(changePoint.at).getTime()
  const suspects = []
  for (const step of steps) {
    const report = detectChangePoints(step.points)
    if (!report.analysed) continue
    for (const change of report.changePoints) {
      if (change.direction !== changePoint.direction) continue
      const distance = Math.abs(new Date(change.at).getTime() - target)
      if (distance > CO_LOCATION_TOLERANCE_MS) continue
      suspects.push({
        nodeId: step.nodeId,
        nodeType: step.nodeType,
        at: change.at,
        before: change.before.median,
        after: change.after.median,
        delta: change.delta,
      })
    }
  }
  // The step that moved most explains most of the run's move. Ordering by
  // absolute delta rather than by ratio on purpose: a step that went from 2ms
  // to 8ms is a 4× regression and irrelevant to a run that got 700ms slower.
  return suspects.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 3)
}

// The verdict for one change point, in the form somebody can act on.
function attribute(workflowId, changePoint, steps) {
  const deploys = deploysBetween(workflowId, changePoint.previousAt, changePoint.at)
  const cause =
    deploys.length === 0 ? 'external' : deploys.length === 1 ? 'deploy' : 'ambiguous'
  return {
    ...changePoint,
    cause,
    deploys: deploys.map((v) => ({
      versionId: v.id,
      version: v.version,
      createdAt: v.created_at,
      createdBy: v.created_by_name || null,
      // Only worth diffing the one that is actually a suspect; with several,
      // the list is the answer and each diff is noise.
      changed: deploys.length === 1 ? describeDeploy(workflowId, v) : null,
    })),
    steps: attributeToSteps(steps, changePoint),
  }
}

// The full report for a workflow.
function analyzeRegressions(workflowId, { limit } = {}) {
  const window = parseLimit(limit)
  const runs = completedRuns(workflowId, window)
  const report = detectChangePoints(runs)

  if (!report.analysed) {
    return {
      analysed: false,
      reason: report.reason,
      runs: runs.length,
      changePoints: [],
      // A CI gate keys on this: no *detected* regression. An unanalysable
      // history is not a regression, so it is `ok` — the alternative would fail
      // every young workflow's build.
      ok: true,
    }
  }

  const steps = stepSeries(workflowId, window)
  const changePoints = report.changePoints.map((c) => attribute(workflowId, c, steps))
  return {
    analysed: true,
    reason: null,
    runs: report.runs,
    changePoints,
    ok: !changePoints.some((c) => c.direction === 'worse'),
  }
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  CO_LOCATION_TOLERANCE_MS,
  parseLimit,
  completedRuns,
  stepSeries,
  deploysBetween,
  describeDeploy,
  attributeToSteps,
  attribute,
  analyzeRegressions,
}
