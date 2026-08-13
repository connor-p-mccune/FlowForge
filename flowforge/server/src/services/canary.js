// Progressive delivery: run a workflow's new definition for a slice of traffic,
// compare it against the old one statistically, and promote or roll back.
//
// The problem it solves is one FlowForge previously had in an unusually sharp
// form. A deployed workflow executes its **live graph**, so editing the canvas
// of something in production changes production immediately and completely —
// there is no gradual anything. A canary inverts that for as long as it runs:
//
//   * **stable** traffic executes a pinned **version snapshot** — the last
//     known-good deploy — and
//   * **canary** traffic executes the **live canvas**, the edits under test.
//
// That framing makes three otherwise-awkward things fall out for free.
//
// **Rollback is instant and destroys nothing.** Stable is already running the
// baseline snapshot, so "roll back" is `percent = 0`: the next run uses the
// baseline, the author's canvas is untouched, and there is no graph to move or
// restore under someone's cursor.
//
// **Promotion is an ordinary deploy.** The live canvas is what the canary was
// already proving, so promoting it is the snapshot-and-mark the deploy route
// has always done, plus clearing the canary.
//
// **Nothing new decides what runs.** The engine already reads one graph per
// run; it now reads a *version's* graph when the execution row names one. One
// column, one branch.
//
// The verdict is statistical rather than threshold-based (`services/
// statistics.js`): a canary is a small sample, and "3 failures out of 40 vs 20
// out of 380" looks alarming and is noise. Auto-promotion on a rate that merely
// *looks* fine is the same mistake in the other direction, so both directions
// wait for evidence.

const db = require('../config/database')
const { twoProportionTest, mannWhitneyU, wilsonInterval } = require('./statistics')

// How often the sweep re-evaluates running canaries. Like the heartbeat and
// maintenance monitors, this is a background pass because "enough runs have
// accumulated" is the passage of time, not an event.
const CHECK_INTERVAL_MS = parseInt(process.env.CANARY_CHECK_INTERVAL_MS || '60000', 10)

// Minimum canary runs before any verdict. Below this the comparison is
// theatre — and the default is deliberately not tiny, because the whole point
// is to out-wait a run of bad luck.
const DEFAULT_MIN_RUNS = 20

// Minimum *stable* runs before a comparison means anything. A canary judged
// against three baseline runs is judged against nothing.
const MIN_BASELINE_RUNS = 10

// A canary failing everything doesn't need a hypothesis test. Below this many
// runs statistics can't speak, but "every single one failed" is not a subtle
// signal, and waiting for the twentieth run to say so is twenty broken runs.
const CATASTROPHIC_MIN_RUNS = 3

// Milliseconds between a run's start and finish, as a SQL expression (the same
// shape the analytics and insights routes use).
const DURATION_MS = '(julianday(finished_at) - julianday(started_at)) * 86400000'

function clampPercent(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.min(100, Math.max(0, Math.round(n)))
}

// The workflow's running canary, or null. `rolled_back` is retained rather than
// cleared: traffic is at 0% and the record of *why* is still on screen, which is
// what an author needs in order to fix the thing and try again.
function activeCanary(workflow) {
  if (!workflow?.canary_baseline_version_id || !workflow.canary_state) return null
  return {
    baselineVersionId: workflow.canary_baseline_version_id,
    percent: clampPercent(workflow.canary_percent) ?? 0,
    state: workflow.canary_state,
    startedAt: workflow.canary_started_at,
    minRuns: workflow.canary_min_runs || DEFAULT_MIN_RUNS,
    auto: workflow.canary_auto === 1,
  }
}

function versionRow(versionId, workflowId) {
  return db.prepare(
    'SELECT * FROM workflow_versions WHERE id = ? AND workflow_id = ?'
  ).get(versionId, workflowId)
}

// Which definition should this run execute?
//
// Returns { channel, versionId, graphJson }. `channel` is null when the run is
// outside the experiment entirely (dry runs, and every run of a workflow with
// no canary), so the analysis below can select on the column without also
// having to know the rules that produced it.
//
// Three cases are decided before any dice are rolled:
//
//   * **A resumed run inherits its source's assignment.** Resume reuses the
//     source run's recorded step outputs, so it *must* re-execute the same
//     definition — adopting outputs from one graph into another would be
//     incoherent in a way no error message would explain.
//   * **Dry runs always execute the live canvas** and take no channel. Test
//     mode exists to try the edits, and letting it randomly run the baseline
//     instead would make the canvas lie about itself.
//   * **A stale baseline degrades to the live graph.** If the pinned version
//     was deleted, the safe reading is "no experiment", not "fail the run".
function resolveRelease(execution, workflow, { dryRun = false } = {}) {
  const live = { channel: null, versionId: null, graphJson: workflow.graph_json }

  // Already assigned (a re-processed job, or a row the caller pinned).
  if (execution.release_channel) {
    if (!execution.graph_version_id) {
      return { channel: execution.release_channel, versionId: null, graphJson: workflow.graph_json }
    }
    const pinned = versionRow(execution.graph_version_id, workflow.id)
    return pinned
      ? { channel: execution.release_channel, versionId: pinned.id, graphJson: pinned.graph_json }
      : { ...live, channel: execution.release_channel }
  }

  if (execution.resumed_from_execution_id) {
    const source = db.prepare(
      'SELECT release_channel, graph_version_id FROM executions WHERE id = ?'
    ).get(execution.resumed_from_execution_id)
    if (source?.release_channel) {
      const pinned = source.graph_version_id
        ? versionRow(source.graph_version_id, workflow.id)
        : null
      return {
        channel: source.release_channel,
        versionId: pinned?.id ?? null,
        graphJson: pinned ? pinned.graph_json : workflow.graph_json,
      }
    }
    return live
  }

  // Dry runs and **debug runs** stay out of the experiment, for two reasons
  // that both matter.
  //
  // The statistical one: a run somebody paused at a breakpoint for five minutes
  // is not a sample of anything. Its duration is a measure of how long a person
  // took to read a JSON blob, and feeding that into the Mann-Whitney comparison
  // on run times — the test that decides whether a release ships — would let one
  // debugging session veto a healthy canary.
  //
  // The mechanical one: breakpoints are validated against the *live* graph when
  // the run is submitted, so a debug run assigned to the stable arm would
  // execute a pinned baseline in which those node ids may not exist. The run
  // would simply never stop, and the person waiting for it would have no idea
  // why.
  if (dryRun || execution.debug_json) return live

  const canary = activeCanary(workflow)
  if (!canary) return live

  const baseline = versionRow(canary.baselineVersionId, workflow.id)
  if (!baseline) return live

  // The split. Random per run rather than hashed on some key: a workflow's runs
  // have no stable identity to hash (a schedule tick is not a user), and the
  // comparison wants independent samples, which is exactly what a fair coin
  // gives.
  const toCanary = Math.random() * 100 < canary.percent
  return toCanary
    ? { channel: 'canary', versionId: null, graphJson: workflow.graph_json }
    : { channel: 'stable', versionId: baseline.id, graphJson: baseline.graph_json }
}

// Record the assignment on the execution row. Best-effort, like every other
// piece of bookkeeping the engine does: a run must not fail because its
// experiment label could not be stored — it would just fall out of the sample.
function recordRelease(executionId, release) {
  if (!release.channel) return
  try {
    db.prepare('UPDATE executions SET release_channel = ?, graph_version_id = ? WHERE id = ?')
      .run(release.channel, release.versionId, executionId)
  } catch (err) {
    console.error(`Failed to record release channel for ${executionId}: ${err.message}`)
  }
}

// — analysis ————————————————————————————————————————————————————————————

function channelStats(workflowId, channel, since) {
  const rows = db.prepare(`
    SELECT status,
      CASE WHEN started_at IS NOT NULL AND finished_at IS NOT NULL
        THEN ${DURATION_MS} END AS duration_ms
    FROM executions
    WHERE workflow_id = ?
      AND release_channel = ?
      AND created_at >= ?
      AND status IN ('completed', 'failed')
  `).all(workflowId, channel, since)

  const total = rows.length
  const failures = rows.filter((r) => r.status === 'failed').length
  // Rounded to the millisecond, which is the resolution the timestamps actually
  // have. The SQL derives duration from julianday(), whose floating-point
  // subtraction leaves sub-microsecond dust that differs with the absolute
  // date — so two genuinely identical durations recorded an hour apart come back
  // unequal. A rank test would read that dust as an ordering and, given two arms
  // that necessarily occupy different time ranges, could call a systematic
  // difference where there is none.
  const durations = rows
    .filter((r) => r.status === 'completed' && typeof r.duration_ms === 'number')
    .map((r) => Math.round(r.duration_ms))
  return {
    runs: total,
    failures,
    successes: total - failures,
    failureRate: total > 0 ? failures / total : null,
    successRate: total > 0 ? (total - failures) / total : null,
    // Wilson rather than the point estimate, so "0 failures in 12 runs" reports
    // an honest upper bound instead of implying certainty.
    failureRateInterval: wilsonInterval(failures, total),
    durations,
  }
}

// Compare the canary against the baseline and recommend an action.
//
// Cancelled runs are excluded from both groups, matching the SLO budget and the
// status page: someone stopping a run is an intervention, not a service
// failure, and charging it to whichever arm happened to be running would
// penalise exactly the response you want during an incident. Dry runs never had
// a channel, so they are excluded structurally rather than by a rule.
function analyze(workflow) {
  const canary = activeCanary(workflow)
  if (!canary) return { active: false }

  const since = canary.startedAt || '1970-01-01T00:00:00.000Z'
  const canaryStats = channelStats(workflow.id, 'canary', since)
  const stableStats = channelStats(workflow.id, 'stable', since)

  const base = {
    active: true,
    state: canary.state,
    percent: canary.percent,
    auto: canary.auto,
    minRuns: canary.minRuns,
    startedAt: canary.startedAt,
    baselineVersionId: canary.baselineVersionId,
    canary: canaryStats,
    stable: stableStats,
  }

  // Catastrophe short-circuit. No test is needed to read "everything failed",
  // and waiting for the twentieth run to say so costs twenty broken runs.
  if (canaryStats.runs >= CATASTROPHIC_MIN_RUNS && canaryStats.failures === canaryStats.runs) {
    return {
      ...base,
      verdict: 'failing',
      recommendation: 'rollback',
      reason: `every canary run failed (${canaryStats.failures}/${canaryStats.runs})`,
      successTest: null,
      durationTest: null,
    }
  }

  if (canaryStats.runs < canary.minRuns) {
    return {
      ...base,
      verdict: 'pending',
      recommendation: 'wait',
      reason: `${canaryStats.runs} of ${canary.minRuns} canary runs so far`,
      successTest: null,
      durationTest: null,
    }
  }
  if (stableStats.runs < MIN_BASELINE_RUNS) {
    return {
      ...base,
      verdict: 'pending',
      recommendation: 'wait',
      reason: `only ${stableStats.runs} baseline runs to compare against`,
      successTest: null,
      durationTest: null,
    }
  }

  // Is the canary's *failure* rate higher than the baseline's by more than
  // chance? One-sided: a canary that fails less is a good thing, not a finding.
  const successTest = twoProportionTest(
    canaryStats.failures, canaryStats.runs,
    stableStats.failures, stableStats.runs
  )
  // Is it slower? Rank-based, because durations are right-skewed and one bad
  // afternoon should not decide a release.
  const durationTest = mannWhitneyU(canaryStats.durations, stableStats.durations)

  if (successTest?.significant) {
    return {
      ...base,
      verdict: 'degraded',
      recommendation: 'rollback',
      reason: `canary failure rate ${(canaryStats.failureRate * 100).toFixed(1)}% vs ${(stableStats.failureRate * 100).toFixed(1)}% (p = ${successTest.pValue.toFixed(4)})`,
      successTest,
      durationTest,
    }
  }
  if (durationTest?.significant) {
    return {
      ...base,
      verdict: 'degraded',
      recommendation: 'rollback',
      reason: `canary runs are significantly slower (p = ${durationTest.pValue.toFixed(4)})`,
      successTest,
      durationTest,
    }
  }

  return {
    ...base,
    verdict: 'healthy',
    recommendation: 'promote',
    reason: `${canaryStats.runs} canary runs with no detectable regression`,
    successTest,
    durationTest,
  }
}

// — transitions —————————————————————————————————————————————————————————

const CLEAR = `
  UPDATE workflows
     SET canary_baseline_version_id = NULL, canary_percent = NULL,
         canary_state = NULL, canary_started_at = NULL,
         canary_min_runs = NULL, canary_auto = NULL
   WHERE id = ?`

// Roll back: stop sending traffic to the canary. Nothing is restored and
// nothing is overwritten, because stable was already executing the baseline
// snapshot — the author's canvas keeps their work so they can fix it and try
// again. The row is kept in `rolled_back` rather than cleared so the reason is
// still on screen; clearing it would hand every run straight back to the graph
// that was just judged bad.
function rollback(workflowId, { reason = null } = {}) {
  db.prepare(
    "UPDATE workflows SET canary_state = 'rolled_back', canary_percent = 0 WHERE id = ?"
  ).run(workflowId)
  return { rolledBack: true, reason }
}

// Promote: the live canvas becomes the deployed definition. This is exactly an
// ordinary deploy — snapshot the graph as a new version, mark the workflow
// deployed — so the caller passes in the snapshot function the deploy route
// already owns rather than this module growing a second copy of it.
function promote(workflow, { snapshot }) {
  const version = db.transaction(() => {
    const v = snapshot()
    db.prepare("UPDATE workflows SET status = 'deployed', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), workflow.id)
    db.prepare(CLEAR).run(workflow.id)
    return v
  })()
  return { promoted: true, version }
}

// End the experiment without promoting or rolling back: the live canvas serves
// every run again, which is the behaviour of a workflow that never had a canary.
function abandon(workflowId) {
  db.prepare(CLEAR).run(workflowId)
  return { ended: true }
}

// Start a canary. The baseline is a version snapshot — by default the most
// recent deploy, which is the definition currently believed good.
function start(workflow, { versionId, percent, minRuns, auto }) {
  const baseline = versionId
    ? versionRow(versionId, workflow.id)
    : db.prepare(
        'SELECT * FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC LIMIT 1'
      ).get(workflow.id)
  if (!baseline) return { error: 'The workflow has no deployed version to use as a baseline' }

  const pct = clampPercent(percent)
  if (pct === null || pct <= 0 || pct >= 100) {
    return { error: 'percent must be between 1 and 99' }
  }
  const min = minRuns == null ? DEFAULT_MIN_RUNS : Number(minRuns)
  if (!Number.isFinite(min) || min < CATASTROPHIC_MIN_RUNS) {
    return { error: `minRuns must be at least ${CATASTROPHIC_MIN_RUNS}` }
  }

  db.prepare(
    `UPDATE workflows
        SET canary_baseline_version_id = ?, canary_percent = ?, canary_state = 'running',
            canary_started_at = ?, canary_min_runs = ?, canary_auto = ?
      WHERE id = ?`
  ).run(baseline.id, pct, new Date().toISOString(), Math.round(min), auto === false ? 0 : 1, workflow.id)

  return { started: true, baselineVersion: baseline.version, percent: pct }
}

module.exports = {
  activeCanary,
  resolveRelease,
  recordRelease,
  analyze,
  start,
  promote,
  rollback,
  abandon,
  channelStats,
  CHECK_INTERVAL_MS,
  DEFAULT_MIN_RUNS,
  MIN_BASELINE_RUNS,
  CATASTROPHIC_MIN_RUNS,
}
