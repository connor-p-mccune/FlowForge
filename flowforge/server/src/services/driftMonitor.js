// Drift monitoring: has what this workflow's nodes *produce* changed?
//
// `dataProfile.js` is the pure half — profile a value, merge a window, compare
// two windows. This is the half that knows where the windows come from, when to
// look, and who to tell.
//
// The comparison is always **the last N runs against the N before them**, from
// the workflow's own history. There is no "expected schema" to declare and keep
// up to date, because a schema somebody has to maintain is a schema that goes
// stale and then reports a workflow compliant forever — the same failure the
// policy engine's type-checked rules exist to prevent. The workflow's own recent
// past is a baseline that maintains itself.
//
// Three rules about which steps count, and each excludes data that would
// otherwise be quietly wrong:
//
//   * **Succeeded steps only.** A failed step's `output_json` is an error
//     object. Profiling it would report "the shape changed" every time
//     something broke, which is a fact already covered by the success rate.
//   * **Not `reused` or `cached`.** Those adopted an *earlier* run's output.
//     Letting them into the recent window injects the baseline's own values
//     into the thing being compared against the baseline, which biases every
//     verdict toward "nothing changed" — the direction a monitor must never
//     fail in.
//   * **Real runs only.** A dry run simulates its side-effecting nodes, so its
//     outputs are previews rather than data.
//
// Analysis is always available on demand (panel, CLI, public API). *Alerting*
// is opt-in per workflow, like the SLA targets, the SLO objective and the
// heartbeat — a workflow that has not asked for it is never swept.

const crypto = require('crypto')
const db = require('../config/database')
const { profileRecord, mergeProfiles, compareProfiles } = require('./dataProfile')
const { recordDriftDetected } = require('./metrics')

// Window sizes. The baseline is deliberately several times the recent window:
// it has to be a stable description of "normal", and a baseline as jumpy as the
// thing being compared to it produces a monitor that alerts on its own noise.
const RECENT_RUNS = 50
const BASELINE_RUNS = 200
// Below this in either window there is not enough history to say anything, and
// saying so is the answer.
const MIN_WINDOW_RUNS = 15

// A single step output larger than this is skipped rather than parsed. The
// analysis is a read endpoint; one workflow returning a 40 MB document must not
// be able to stall it.
const MAX_OUTPUT_BYTES = 262144

// SQLite's default parameter ceiling is 999; stay well inside it.
const ID_CHUNK = 400

// How often a monitored workflow is re-analysed by the sweep. The analysis
// parses hundreds of JSON documents, so it is deliberately not per-run.
const CHECK_INTERVAL_MS = Math.max(5000, Number(process.env.DRIFT_CHECK_INTERVAL_MS) || 60 * 1000)
const REANALYSE_INTERVAL_MS = Math.max(
  60 * 1000,
  Number(process.env.DRIFT_REANALYSE_INTERVAL_MS) || 30 * 60 * 1000
)

// The runs each window is built from, newest first.
function recentRuns(workflowId, limit) {
  return db.prepare(`
    SELECT id, created_at FROM executions
    WHERE workflow_id = ? AND status = 'completed'
      AND (trigger_type IS NULL OR trigger_type != 'dry-run')
    ORDER BY created_at DESC, rowid DESC
    LIMIT ?
  `).all(workflowId, limit)
}

// Accumulate a profile per node over a set of runs.
// → Map<nodeId, { nodeType, profile }>
function profileRuns(runIds) {
  const byNode = new Map()
  if (runIds.length === 0) return byNode

  for (let offset = 0; offset < runIds.length; offset += ID_CHUNK) {
    const chunk = runIds.slice(offset, offset + ID_CHUNK)
    const placeholders = chunk.map(() => '?').join(',')
    const rows = db.prepare(`
      SELECT node_id, node_type, output_json
      FROM execution_steps
      WHERE execution_id IN (${placeholders})
        AND status = 'succeeded'
        AND output_json IS NOT NULL
    `).all(...chunk)

    for (const row of rows) {
      if (row.output_json.length > MAX_OUTPUT_BYTES) continue
      let value
      try {
        value = JSON.parse(row.output_json)
      } catch {
        continue // an unparseable output is not a signal, it is a bad row
      }
      const existing = byNode.get(row.node_id)
      const profile = profileRecord(value)
      if (existing) {
        existing.profile = mergeProfiles(existing.profile, profile)
      } else {
        byNode.set(row.node_id, { nodeType: row.node_type, profile })
      }
    }
  }
  return byNode
}

// Node labels from the workflow's current graph, so a finding names what is on
// the canvas rather than an internal id.
function labelsFor(workflow) {
  const labels = {}
  try {
    const graph = JSON.parse(workflow.graph_json || '{}')
    for (const node of graph.nodes || []) {
      if (node?.id) labels[node.id] = node.data?.label || node.id
    }
  } catch {
    /* an unparseable graph just means unlabelled findings */
  }
  return labels
}

// A stable identity for a set of findings, so the alert is edge-triggered on
// *what drifted* rather than on drift existing. A second field breaking while
// the first is still broken is new information and alerts; the same field still
// broken tomorrow is not and does not.
function fingerprintOf(findings) {
  const keys = findings
    .filter((f) => f.severity === 'major')
    .map((f) => `${f.nodeId}:${f.path}:${f.kind}`)
    .sort()
  if (keys.length === 0) return null
  return crypto.createHash('sha256').update(keys.join('|')).digest('hex').slice(0, 32)
}

// The full report for a workflow. Read-only; runs nothing and writes nothing.
function analyzeWorkflowDrift(workflowId, options = {}) {
  const recentSize = Math.max(1, Math.min(Number(options.recentRuns) || RECENT_RUNS, 200))
  const baselineSize = Math.max(1, Math.min(Number(options.baselineRuns) || BASELINE_RUNS, 500))
  const minWindow = Number.isFinite(options.minWindowRuns) ? options.minWindowRuns : MIN_WINDOW_RUNS

  const workflow = db.prepare('SELECT id, name, graph_json FROM workflows WHERE id = ?').get(workflowId)
  if (!workflow) return { available: false, reason: 'not-found' }

  const rows = recentRuns(workflowId, recentSize + baselineSize)
  const recent = rows.slice(0, recentSize)
  const baseline = rows.slice(recentSize, recentSize + baselineSize)

  if (recent.length < minWindow || baseline.length < minWindow) {
    return {
      available: false,
      reason: 'insufficient-history',
      needed: minWindow * 2,
      have: rows.length,
    }
  }

  const recentProfiles = profileRuns(recent.map((r) => r.id))
  const baselineProfiles = profileRuns(baseline.map((r) => r.id))
  const labels = labelsFor(workflow)

  const nodes = []
  const allFindings = []
  let skippedNodes = 0

  // Only nodes present in both windows can be compared. A node that exists in
  // one is either new or removed, which is a change to the *graph* — already
  // covered by version diffs, and reporting it here would double up.
  for (const [nodeId, { nodeType, profile }] of recentProfiles) {
    const base = baselineProfiles.get(nodeId)
    if (!base) {
      skippedNodes += 1
      continue
    }
    const result = compareProfiles(base.profile, profile, options)
    const findings = result.findings.map((f) => ({ ...f, nodeId, nodeLabel: labels[nodeId] || nodeId }))
    allFindings.push(...findings)
    nodes.push({
      nodeId,
      nodeLabel: labels[nodeId] || nodeId,
      nodeType: nodeType ?? null,
      records: { baseline: base.profile.records, recent: profile.records },
      compared: result.compared,
      skipped: result.skipped,
      findings,
    })
  }

  nodes.sort((a, b) => b.findings.length - a.findings.length || a.nodeId.localeCompare(b.nodeId))

  const major = allFindings.filter((f) => f.severity === 'major').length
  return {
    available: true,
    workflowId,
    window: {
      recent: { runs: recent.length, from: recent[recent.length - 1]?.created_at, to: recent[0]?.created_at },
      baseline: { runs: baseline.length, from: baseline[baseline.length - 1]?.created_at, to: baseline[0]?.created_at },
    },
    summary: {
      major,
      minor: allFindings.length - major,
      nodesCompared: nodes.length,
      nodesSkipped: skippedNodes,
      fieldsCompared: nodes.reduce((sum, n) => sum + n.compared, 0),
      fieldsSkipped: nodes.reduce((sum, n) => sum + n.skipped.length, 0),
    },
    fingerprint: fingerprintOf(allFindings),
    nodes,
  }
}

// ---------------------------------------------------------------------------
// Alerting
// ---------------------------------------------------------------------------

function summarize(workflow, report) {
  const major = report.nodes.flatMap((n) => n.findings).filter((f) => f.severity === 'major')
  const first = major[0]
  const rest = major.length - 1
  return (
    `"${workflow.name}" — ${first.nodeLabel}: ${first.summary}` +
    (rest > 0 ? ` (and ${rest} other ${rest === 1 ? 'change' : 'changes'})` : '')
  )
}

// Fan out through the surfaces that already exist: the activity feed (which
// relays to outbound webhook subscriptions) and an owner notification. Every
// path is best-effort — a monitoring fault must never break anything else.
function raiseAlert(workflow, report, eventType) {
  const findings = report.nodes.flatMap((n) => n.findings).filter((f) => f.severity === 'major')
  const message =
    eventType === 'workflow.data_drift'
      ? summarize(workflow, report)
      : `"${workflow.name}" — the output drift reported earlier has cleared.`

  try {
    require('./activityService').logEvent(workflow.workspace_id, null, eventType, {
      type: 'workflow',
      id: workflow.id,
      name: workflow.name,
      metadata: {
        workflowId: workflow.id,
        findings: findings.slice(0, 10).map((f) => ({
          nodeId: f.nodeId,
          nodeLabel: f.nodeLabel,
          path: f.path,
          kind: f.kind,
          summary: f.summary,
        })),
        window: report.window,
      },
    })
  } catch (err) {
    console.error('driftMonitor: activity log failed:', err.message)
  }

  if (workflow.created_by) {
    try {
      require('./notificationService').createNotification(workflow.created_by, {
        type: eventType === 'workflow.data_drift' ? 'data-drift' : 'data-drift-recovered',
        title: eventType === 'workflow.data_drift' ? 'Output drift detected' : 'Output drift cleared',
        message,
        link: `/workflow/${workflow.id}`,
      })
    } catch (err) {
      console.error('driftMonitor: notification failed:', err.message)
    }
  }
}

const setState = db.prepare(
  'UPDATE workflows SET drift_checked_at = ?, drift_alerted_at = ?, drift_fingerprint = ? WHERE id = ?'
)

// Evaluate one workflow and raise/clear its alert. Returns the transition it
// made ('detected' | 'changed' | 'recovered' | null) so tests and the sweep can
// see what happened without re-reading the row.
function evaluateWorkflow(workflow, options = {}) {
  const now = new Date().toISOString()
  const report = analyzeWorkflowDrift(workflow.id, options)
  if (!report.available) {
    setState.run(now, workflow.drift_alerted_at ?? null, workflow.drift_fingerprint ?? null, workflow.id)
    return null
  }

  const fingerprint = report.fingerprint
  const wasAlerting = Boolean(workflow.drift_alerted_at)

  // Clean now, alerting before: close the incident. Every open gets a close, so
  // a downstream Slack channel is not left holding an alert nobody resolved.
  //
  // Worth being explicit about *when* this happens, because it is later than it
  // looks. The baseline is the workflow's own recent past, so immediately after
  // somebody fixes a field the baseline *is* the broken period and the recent
  // window is the healthy one — still a change, still the same field, so the
  // fingerprint is unchanged and the branch below keeps quiet rather than
  // re-alerting on the recovery. The incident closes only once the drifted
  // period has aged out of the baseline too, i.e. when the data has genuinely
  // been normal for a full baseline window. That is the right moment to tell
  // somebody it is over.
  if (!fingerprint) {
    setState.run(now, null, null, workflow.id)
    if (wasAlerting) {
      raiseAlert(workflow, report, 'workflow.data_drift_recovered')
      return 'recovered'
    }
    return null
  }

  // Still exactly the same drift: stay silent. This is the edge-trigger, and it
  // is keyed on *what* drifted rather than on drift existing — so a second field
  // breaking while the first is still broken is new information and does alert.
  if (wasAlerting && workflow.drift_fingerprint === fingerprint) {
    setState.run(now, workflow.drift_alerted_at, fingerprint, workflow.id)
    return null
  }

  setState.run(now, now, fingerprint, workflow.id)
  raiseAlert(workflow, report, 'workflow.data_drift')
  try {
    for (const finding of report.nodes.flatMap((n) => n.findings)) {
      if (finding.severity === 'major') recordDriftDetected(finding.kind)
    }
  } catch {
    /* metrics must never break monitoring */
  }
  return wasAlerting ? 'changed' : 'detected'
}

// One sweep over the workflows that asked to be monitored.
function checkOnce(options = {}) {
  const cutoff = new Date(Date.now() - REANALYSE_INTERVAL_MS).toISOString()
  const due = db.prepare(`
    SELECT * FROM workflows
    WHERE drift_monitoring = 1
      AND status = 'deployed'
      AND (drift_checked_at IS NULL OR drift_checked_at < ?)
  `).all(options.force ? new Date(Date.now() + 1000).toISOString() : cutoff)

  const transitions = []
  for (const workflow of due) {
    try {
      const transition = evaluateWorkflow(workflow, options)
      if (transition) transitions.push({ workflowId: workflow.id, event: transition })
    } catch (err) {
      console.error(`driftMonitor: check failed for ${workflow.id}:`, err.message)
    }
  }
  return transitions
}

let timer = null

function startDriftMonitor() {
  if (timer) return timer
  timer = setInterval(() => {
    checkOnce()
  }, CHECK_INTERVAL_MS)
  timer.unref()
  return timer
}

// Stop sweeping (graceful shutdown). Alert state lives in columns, so the next
// boot resumes exactly where this one left off.
function stopDriftMonitor() {
  if (!timer) return
  clearInterval(timer)
  timer = null
}

module.exports = {
  analyzeWorkflowDrift,
  evaluateWorkflow,
  checkOnce,
  startDriftMonitor,
  stopDriftMonitor,
  fingerprintOf,
  RECENT_RUNS,
  BASELINE_RUNS,
  MIN_WINDOW_RUNS,
}
