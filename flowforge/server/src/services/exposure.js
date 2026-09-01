// Which workflow should I look at first?
//
// Every analysis in this product answers a question about **one** workflow. The
// linter checks one graph, the effect report describes one run, path
// feasibility solves one set of branches, the capacity model sizes one queue.
// Each is complete and each assumes somebody already knew which workflow to
// open.
//
// Nobody has one workflow. A workspace that has been running for a year has
// forty, most of them built by somebody who left, and the honest state of a
// review is *"where do I even start"*. That question has never been answered
// here, and it is the only one an owner actually asks.
//
// ---
//
// ## The unit
//
// The answer has to be a quantity, not a vibe, and there is one available that
// is made entirely of things already measured:
//
//     outward actions per day  =  effects a run performs  ×  runs per day
//
// [The transitive effect report](./reach.js) supplies the left side — every
// HTTP call, email, Slack post and model call a run can reach, including the
// ones several sub-workflow calls away that nobody reading the canvas would
// see. The `executions` table supplies the right. Their product is a real
// quantity with a real unit: *how many times a day does this workspace do
// something outside itself because of this workflow.*
//
// Both halves are load-bearing and neither is sufficient. A workflow that
// charges cards and runs twice a year is not the fire. Neither is one that runs
// ten thousand times a day and only writes to a log.
//
// ## Why it is an interval
//
// Most effects are gated. `Charge card` happens when `Approve = true`, and
// nothing here evaluates that — [it is deliberately not evaluated](./PATHS.md),
// because how often a branch is taken is a question about inputs, not graphs.
//
// So a single number would have to guess, and instead there are two:
//
//   * **floor** — effects nothing gates, times the rate. What this workflow
//     *does*, every run, guaranteed by its shape.
//   * **ceiling** — every effect, times the rate. What it does if every gate
//     goes the effectful way.
//
// **Workflows are ranked by the ceiling**, and the reason is the subject of the
// report rather than a preference. This exists to find workflows nobody has
// checked. A gate nobody has tested is not a gate, it is a hope — so the review
// queue is built on the worst case, with the floor shown beside it because a
// large floor means the worst case is also the ordinary one.
//
// ## Why the rate counts direct runs only
//
// A sub-workflow call creates its own `executions` row, so a shared utility's
// raw run count includes every call made on somebody else's behalf.
//
// Counting those would count the same charge twice: once in the caller's row,
// where the transitive walk already put it, and again in the callee's. Worse,
// it would rank the utility above the workflow that decides to invoke it, which
// inverts the answer — the utility is a subroutine, and the thing to review is
// the caller that reaches it.
//
// So the rate is `parent_execution_id IS NULL`: runs somebody or something
// started. A workflow that is only ever called therefore scores zero, which
// would be a lie by omission if it were left at that, so those rows say which
// workflows their consequence was attributed to instead.
//
// ## Why assurance is not in the score
//
// The obvious next move is to subtract test coverage and publish one number.
// This does not, and the reason is that it cannot honestly.
//
// Four scenarios do not make a workflow four units safer. They might all assert
// the same trivial thing. A single pinned [guarantee](./GUARANTEES.md) can be
// worth more than a dozen of them, or nothing, depending on what it says — and
// nothing here reads what it says. What can be counted is *whether anybody has
// set anything up at all*, and the difference between zero and one is the only
// step in that scale this report can defend.
//
// So the four kinds of assurance are reported beside the exposure, unweighted
// and unsummed, and the queue is the plainest possible filter over them: high
// consequence, nothing checking it. That is a fact about the workspace rather
// than a judgement about a test suite.

const db = require('../config/database')
const { reachableEffects } = require('./reach')
const { subWorkflowGraphs } = require('./reachLookup')
const { buildWorkspaceGraph } = require('./workflowDependencies')

// A month of history. Long enough that a weekly workflow appears at all, short
// enough that a workflow retired in the spring is not still being ranked on the
// traffic it had then.
const WINDOW_DAYS = 30

const DAY_MS = 86400000

const round2 = (n) => Math.round(n * 100) / 100

// Runs per workflow over the window, split by who started them.
//
// `first_at` is the first *direct* run, and it is the denominator's job: a
// workflow deployed four days ago that has run 400 times runs 100 times a day,
// not 13. Floored at one day so a workflow deployed this morning does not
// extrapolate its first hour into a headline.
function runCounts(workspaceId, days) {
  const since = new Date(Date.now() - days * DAY_MS).toISOString()
  const rows = db
    .prepare(
      `SELECT e.workflow_id AS id,
              SUM(CASE WHEN e.parent_execution_id IS NULL THEN 1 ELSE 0 END) AS direct,
              SUM(CASE WHEN e.parent_execution_id IS NULL THEN 0 ELSE 1 END) AS called,
              MIN(CASE WHEN e.parent_execution_id IS NULL THEN e.created_at END) AS first_at
         FROM executions e
         JOIN workflows w ON w.id = e.workflow_id
        WHERE w.workspace_id = ? AND e.created_at >= ?
        GROUP BY e.workflow_id`
    )
    .all(workspaceId, since)

  const now = Date.now()
  const out = new Map()
  for (const row of rows) {
    const firstMs = row.first_at ? Date.parse(row.first_at) : NaN
    const spanDays = Number.isNaN(firstMs)
      ? days
      : Math.max(1, Math.min(days, (now - firstMs) / DAY_MS))
    out.set(row.id, {
      direct: row.direct,
      called: row.called,
      perDay: round2(row.direct / spanDays),
      observedDays: round2(spanDays),
    })
  }
  return out
}

// How many of each kind of check a workflow has. Counted, never weighted — see
// the header on why this is not folded into the ranking.
function assuranceCounts(workspaceId) {
  const scenarios = new Map()
  for (const row of db
    .prepare(
      `SELECT t.workflow_id AS id, COUNT(*) AS n
         FROM workflow_tests t JOIN workflows w ON w.id = t.workflow_id
        WHERE w.workspace_id = ? GROUP BY t.workflow_id`
    )
    .all(workspaceId)) {
    scenarios.set(row.id, row.n)
  }

  const assertions = new Map()
  for (const row of db
    .prepare(
      `SELECT a.workflow_id AS id, COUNT(*) AS n
         FROM workflow_assertions a JOIN workflows w ON w.id = a.workflow_id
        WHERE w.workspace_id = ? AND a.enabled = 1 GROUP BY a.workflow_id`
    )
    .all(workspaceId)) {
    assertions.set(row.id, row.n)
  }

  return { scenarios, assertions }
}

// Declared guarantees, counted without judging them. A malformed list counts as
// none, which matches what the deploy check would enforce.
function guaranteeCount(raw) {
  if (!raw) return 0
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.length : 0
  } catch {
    return 0
  }
}

function parseGraph(json) {
  try {
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed?.nodes)) return null
    return { nodes: parsed.nodes, edges: Array.isArray(parsed.edges) ? parsed.edges : [] }
  } catch {
    return null
  }
}

// Rank a workspace's workflows by how much of the outside world a day of them
// touches, and say which of them nothing is checking.
function exposureReport(workspaceId, { days = WINDOW_DAYS } = {}) {
  const workflows = db
    .prepare(
      `SELECT id, name, status, graph_json, guarantees_json, drift_monitoring
         FROM workflows WHERE workspace_id = ?`
    )
    .all(workspaceId)

  const runs = runCounts(workspaceId, days)
  const { scenarios, assertions } = assuranceCounts(workspaceId)
  const resolve = subWorkflowGraphs(workspaceId)
  const { edges } = buildWorkspaceGraph(workspaceId)

  // Who calls whom, so a workflow with no direct runs can name the callers its
  // consequence was attributed to rather than reporting a bare zero.
  const callersOf = new Map()
  const nameOf = new Map(workflows.map((w) => [w.id, w.name]))
  for (const [sourceId, targets] of edges) {
    for (const targetId of targets.keys()) {
      if (!callersOf.has(targetId)) callersOf.set(targetId, [])
      callersOf.get(targetId).push(nameOf.get(sourceId))
    }
  }

  // One cache across the whole sweep: a utility forty workflows call has its
  // effect report computed once rather than forty times.
  const cache = new Map()

  const rows = []
  let unreadable = 0

  for (const wf of workflows) {
    const graph = parseGraph(wf.graph_json)
    if (!graph) {
      unreadable += 1
      continue
    }

    const reach = reachableEffects({ id: wf.id, name: wf.name, graph }, resolve, { cache })
    const summary = reach.available
      ? reach.summary
      : { total: 0, direct: 0, inherited: 0, unconditional: 0, workflows: 0, deepest: 0 }

    const rate = runs.get(wf.id) || { direct: 0, called: 0, perDay: 0, observedDays: 0 }
    const callers = (callersOf.get(wf.id) || []).sort()

    // A workflow reached only through its callers has already had its
    // consequence counted in their rows. Scoring it again would double the
    // workspace total and rank the subroutine above the decision to call it.
    const attributed = rate.direct === 0 && (rate.called > 0 || callers.length > 0)

    const assurance = {
      scenarios: scenarios.get(wf.id) || 0,
      guarantees: guaranteeCount(wf.guarantees_json),
      assertions: assertions.get(wf.id) || 0,
      drift: Boolean(wf.drift_monitoring),
    }
    assurance.checked =
      assurance.scenarios > 0 || assurance.guarantees > 0 || assurance.assertions > 0 || assurance.drift

    rows.push({
      workflowId: wf.id,
      name: wf.name,
      status: wf.status,
      runs: rate,
      effects: {
        total: summary.total,
        unconditional: summary.unconditional,
        // Effects that live in a workflow this one calls: the part of the
        // answer that is invisible on the canvas a reviewer would open.
        inherited: summary.inherited,
        workflows: summary.workflows,
        deepest: summary.deepest,
        unresolved: reach.available ? reach.unresolved.length : 0,
      },
      exposure: {
        floor: round2(rate.perDay * summary.unconditional),
        ceiling: round2(rate.perDay * summary.total),
      },
      assurance,
      attributed,
      calledBy: callers,
    })
  }

  // Worst case first, then the workflows whose worst case is also their
  // ordinary case, then a stable name order so two identical rows do not swap
  // places between reads.
  rows.sort(
    (a, b) =>
      b.exposure.ceiling - a.exposure.ceiling ||
      b.exposure.floor - a.exposure.floor ||
      a.name.localeCompare(b.name)
  )

  // The work queue: consequence, and nothing watching it. Attributed rows are
  // left out because acting on them means acting on their callers, which are
  // in the list already.
  const queue = rows.filter((r) => r.exposure.ceiling > 0 && !r.assurance.checked && !r.attributed)

  const totalCeiling = rows.reduce((n, r) => n + r.exposure.ceiling, 0)
  const uncheckedCeiling = queue.reduce((n, r) => n + r.exposure.ceiling, 0)

  return {
    available: true,
    workspaceId,
    windowDays: days,
    workflows: rows,
    queue: queue.map((r) => r.workflowId),
    summary: {
      workflows: rows.length,
      // A graph that will not parse is not a zero — saying so is the difference
      // between "this workspace does nothing" and "this report could not tell".
      unreadable,
      runsPerDay: round2(rows.reduce((n, r) => n + r.runs.perDay, 0)),
      outwardPerDay: {
        floor: round2(rows.reduce((n, r) => n + r.exposure.floor, 0)),
        ceiling: round2(totalCeiling),
      },
      unchecked: queue.length,
      // The line somebody repeats in a meeting: the share of what this
      // workspace does to the outside world that sits on workflows nothing is
      // checking. Zero rather than NaN when the workspace does nothing at all.
      uncheckedShare: totalCeiling > 0 ? round2(uncheckedCeiling / totalCeiling) : 0,
      // Effects that happen inside a workflow somebody called — the part of the
      // workspace's behaviour no single canvas shows.
      offCanvas: rows.reduce((n, r) => n + r.effects.inherited, 0),
      attributed: rows.filter((r) => r.attributed).length,
    },
  }
}

module.exports = { exposureReport, WINDOW_DAYS }
