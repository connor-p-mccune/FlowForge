// Public status pages: a statuspage.io for your workflows. A workspace owner
// mints a token; anyone holding the URL sees a read-only health rollup of
// the workspace's *deployed* workflows — recent run outcomes as uptime bars,
// success rate, typical duration, when it last ran. Built for sharing with
// people who shouldn't get accounts: the on-call channel, a client, a wall
// display.
//
// What the payload deliberately omits is most of the design. No workflow or
// execution ids (nothing on the page can be turned into an API call), no
// error messages or step data (failure *rates* are shareable; failure
// *details* often embed payloads), no draft/archived workflows (unfinished
// work isn't status), and no dry runs (tests aren't service health).

const crypto = require('crypto')
const db = require('../config/database')

// How many recent runs feed each workflow's bar strip and stats.
const RUNS_PER_WORKFLOW = 50

function mintToken() {
  return crypto.randomBytes(24).toString('hex')
}

function durationMs(run) {
  if (!run.started_at || !run.finished_at) return null
  const ms = new Date(run.finished_at) - new Date(run.started_at)
  return Number.isFinite(ms) && ms >= 0 ? ms : null
}

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

// The public payload for a workspace's status page.
function buildStatusPage(workspace) {
  const workflows = db.prepare(
    "SELECT id, name FROM workflows WHERE workspace_id = ? AND status = 'deployed' ORDER BY name"
  ).all(workspace.id)

  const readRuns = db.prepare(
    `SELECT status, started_at, finished_at, created_at
       FROM executions
      WHERE workflow_id = ? AND (trigger_type IS NULL OR trigger_type <> 'dry-run')
      ORDER BY created_at DESC
      LIMIT ?`
  )

  const entries = workflows.map((wf) => {
    const rows = readRuns.all(wf.id, RUNS_PER_WORKFLOW)
    // Newest-first from the query; the bar strip wants oldest → newest so
    // time reads left to right.
    const runs = rows
      .map((r) => ({ status: r.status, durationMs: durationMs(r), finishedAt: r.finished_at }))
      .reverse()

    const completed = rows.filter((r) => r.status === 'completed')
    const failed = rows.filter((r) => r.status === 'failed')
    const settled = completed.length + failed.length
    const latest = rows[0] || null

    return {
      name: wf.name,
      runs,
      // Success rate over settled outcomes only — cancelled and in-flight
      // runs are neither up nor down. null = nothing settled yet.
      successRate: settled > 0 ? completed.length / settled : null,
      p50DurationMs: median(completed.map(durationMs).filter((ms) => ms != null)),
      lastRunStatus: latest?.status ?? null,
      lastRunAt: latest ? (latest.finished_at || latest.created_at) : null,
    }
  })

  return {
    workspace: workspace.name,
    generatedAt: new Date().toISOString(),
    workflows: entries,
  }
}

module.exports = { mintToken, buildStatusPage, RUNS_PER_WORKFLOW }
