// Schedule backfill — run a scheduled workflow over a window of the past.
//
// The need is ordinary and the existing features don't cover it: a schedule was
// deployed late, or was paused through an incident, or its logic was fixed and
// the last three weeks need recomputing. Replay re-runs *one recorded* run;
// backfill runs the ones that never happened.
//
// The idea that makes it more than a for-loop is the **logical date**: the
// instant a run *represents*, which is not the instant it executes. A backfill
// of last Tuesday runs today, but it is "about" last Tuesday, and a workflow
// that fetches "yesterday's orders" has to be told which yesterday it means or
// every backfilled run recomputes today. So each generated run carries its
// scheduled instant into the graph as trigger data:
//
//   {{<trigger-node-id>.logicalDate}}   2026-07-14T09:00:00.000Z
//   {{<trigger-node-id>.backfill}}      true
//
// which is exactly the mechanism webhook payloads already use — no new
// templating concept, and a workflow written for live traffic keeps working
// because ordinary runs simply have no logicalDate.
//
// Boundaries, all deliberate:
//
//   - **Bounded up front.** A range is refused if it would generate more than
//     MAX_OCCURRENCES runs, rather than silently truncating. "I asked for a
//     year and got the first 500" is a worse outcome than being told to narrow
//     the range.
//   - **Low lane by default.** A backfill is bulk work and must never starve
//     live traffic; priority lanes already express that, so backfilled runs
//     ride `low` unless the caller says otherwise.
//   - **Idempotent by default.** Occurrences whose logical date already has a
//     run are skipped, so re-submitting an overlapping range is safe — the
//     common case after a partial backfill. `skipExisting: false` overrides it
//     for a deliberate recompute.
//   - **Pause is honoured; the rate limit is not.** Pause means "stop
//     everything", and a backfill is exactly the traffic an operator paused the
//     workflow to prevent. The rate limit exists to bound *unattended*
//     frequency — a runaway cron, a bursty sender — and a backfill is neither;
//     it is an explicit, bounded, human-initiated action whose load is governed
//     by the concurrency cap at worker pickup, which is the control that
//     actually protects the downstream system.

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const { nextRuns, isValid } = require('./cronExpression')
const { isValidTimeZone } = require('./timezone')

// The most runs one submission may create. Generous enough for a month of
// hourly runs (744) to be a two-step operation rather than impossible, small
// enough that a fat-fingered decade doesn't enqueue a hundred thousand jobs.
const MAX_OCCURRENCES = 1000

// How far back a backfill may reach. Five years is past the point where "the
// schedule should have run then" is a real claim, and it bounds the cron
// search regardless of what a caller passes.
const MAX_RANGE_MS = 5 * 365 * 24 * 60 * 60 * 1000

// The schedule trigger's cron + zone from a workflow's stored graph, or null
// when it has no schedule trigger. A backfill only means something for a
// workflow that *has* a cadence — for a webhook-driven workflow there is no
// set of occurrences to reconstruct, which is why this returns null rather
// than inventing one.
function scheduleOf(workflow) {
  let graph
  try {
    graph = JSON.parse(workflow.graph_json)
  } catch {
    return null
  }
  const node = (graph.nodes || []).find((n) => n.type === 'trigger-schedule')
  const cron = node?.data?.config?.cron
  if (typeof cron !== 'string' || cron.trim() === '' || !isValid(cron.trim())) return null
  const zone = node?.data?.config?.timezone
  return {
    nodeId: node.id,
    cron: cron.trim(),
    timeZone: typeof zone === 'string' && zone.trim() !== '' && isValidTimeZone(zone.trim())
      ? zone.trim()
      : null,
  }
}

// Validate and normalise the requested window. Returns { from, to } as Dates,
// or { error } for the route to turn into a 400.
function parseRange(fromRaw, toRaw) {
  const from = new Date(fromRaw)
  const to = new Date(toRaw)
  if (Number.isNaN(from.getTime())) return { error: '`from` must be an ISO-8601 timestamp' }
  if (Number.isNaN(to.getTime())) return { error: '`to` must be an ISO-8601 timestamp' }
  if (to.getTime() <= from.getTime()) return { error: '`to` must be after `from`' }
  if (to.getTime() - from.getTime() > MAX_RANGE_MS) {
    return { error: 'The window must span at most five years' }
  }
  // A backfill reconstructs the past. Allowing a future `to` would generate
  // runs for occurrences that are still going to fire naturally, producing
  // duplicates the scheduler would then add to — so the window is clamped to
  // now rather than refused, since "from last month until forever" is a
  // reasonable thing to ask and an obvious thing to mean.
  const now = new Date()
  return { from, to: to.getTime() > now.getTime() ? now : to }
}

// The scheduled instants in (from, to]. Uses the same cron engine — and the
// same time zone — the live scheduler fires on, so a backfill reproduces
// exactly the occurrences that *would* have happened, DST included: a
// backfill across a spring-forward gets the same one-run-that-day the live
// schedule would have.
//
// `nextRuns` returns fire times strictly after its cursor, which makes the
// window half-open at the `from` end: a backfill starting at the instant of a
// previous run does not repeat that run.
function planOccurrences(workflow, from, to) {
  const schedule = scheduleOf(workflow)
  if (!schedule) return { error: 'This workflow has no schedule trigger to backfill' }

  const occurrences = []
  let cursor = from
  // One extra so an over-cap range is *detected* rather than silently trimmed.
  while (occurrences.length <= MAX_OCCURRENCES) {
    const [next] = nextRuns(schedule.cron, 1, cursor, {
      timeZone: schedule.timeZone || undefined,
    })
    if (!next || next.getTime() > to.getTime()) break
    occurrences.push(next)
    cursor = next
  }

  if (occurrences.length > MAX_OCCURRENCES) {
    return {
      error:
        `That window would create more than ${MAX_OCCURRENCES} runs. ` +
        'Narrow the range and backfill it in parts.',
    }
  }
  return { schedule, occurrences }
}

// Which of these logical dates already have a run? Returned as a Set of ISO
// strings so the planner can mark each occurrence, and the caller can see how
// much of the window is already covered before committing to anything.
function existingLogicalDates(workflowId, occurrences) {
  if (occurrences.length === 0) return new Set()
  const rows = db
    .prepare(
      `SELECT DISTINCT logical_date FROM executions
        WHERE workflow_id = ? AND logical_date IS NOT NULL
          AND logical_date >= ? AND logical_date <= ?`
    )
    .all(
      workflowId,
      occurrences[0].toISOString(),
      occurrences[occurrences.length - 1].toISOString()
    )
  return new Set(rows.map((r) => r.logical_date))
}

// Plan a backfill without creating anything: the occurrences, which are new,
// and which already have runs. This is what the preview shows and what the
// submit path calls first — one implementation, so the preview cannot promise
// something different from what submitting does.
function planBackfill(workflow, { from, to, skipExisting = true } = {}) {
  const range = parseRange(from, to)
  if (range.error) return range

  const plan = planOccurrences(workflow, range.from, range.to)
  if (plan.error) return plan

  const existing = existingLogicalDates(workflow.id, plan.occurrences)
  const occurrences = plan.occurrences.map((date) => {
    const iso = date.toISOString()
    return { logicalDate: iso, alreadyRan: existing.has(iso) }
  })
  const toRun = skipExisting ? occurrences.filter((o) => !o.alreadyRan) : occurrences

  return {
    cron: plan.schedule.cron,
    timeZone: plan.schedule.timeZone || 'UTC',
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    total: occurrences.length,
    skipped: occurrences.length - toRun.length,
    willRun: toRun.length,
    occurrences,
  }
}

// Create and enqueue the runs. Returns { backfillId, created, plan } or
// { error }.
//
// Row creation is one transaction: a submission either produces its whole batch
// or none of it, so a failure halfway through can't leave a partial backfill
// that someone has to reconcile by hand. Enqueuing happens after the
// transaction commits — Bull is not transactional, and a job whose row was
// rolled back would be a job pointing at nothing.
function submitBackfill(workflow, actorId, options = {}) {
  const plan = planBackfill(workflow, options)
  if (plan.error) return plan
  if (plan.willRun === 0) {
    return {
      error:
        plan.total === 0
          ? 'No scheduled occurrences fall in that window'
          : 'Every occurrence in that window already has a run',
    }
  }

  const { resolvePriority } = require('./runPriority')
  // Bulk work rides the low lane unless the caller insists: a backfill must
  // never push live traffic down the queue.
  const priority = options.priority ? resolvePriority(options.priority, workflow) : 'low'
  const backfillId = uuidv4()
  const now = new Date().toISOString()
  const runs = plan.occurrences
    .filter((o) => !(options.skipExisting !== false && o.alreadyRan))
    .map((o) => ({
      executionId: uuidv4(),
      logicalDate: o.logicalDate,
      // The graph reads this exactly like a webhook body. `backfill: true` lets
      // a workflow branch on it — skipping a notification step when replaying
      // history is a thing people legitimately want.
      payload: { logicalDate: o.logicalDate, backfill: true },
    }))

  const insert = db.prepare(
    `INSERT INTO executions
       (id, workflow_id, status, triggered_by, trigger_type, trigger_data, priority,
        logical_date, backfill_id, created_at)
     VALUES (?, ?, 'pending', ?, 'backfill', ?, ?, ?, ?, ?)`
  )
  db.transaction(() => {
    for (const run of runs) {
      insert.run(
        run.executionId,
        workflow.id,
        actorId ?? null,
        JSON.stringify(run.payload),
        priority,
        run.logicalDate,
        backfillId,
        now
      )
    }
  })()

  return { backfillId, priority, runs, plan }
}

// Progress for every backfill batch of a workflow, newest first. Derived from
// the runs themselves rather than a status column on a batch row: there is no
// second source of truth to reconcile, and a batch's state is exactly the
// aggregate of its runs.
function listBackfills(workflowId, limit = 20) {
  return db
    .prepare(
      `SELECT backfill_id AS backfillId,
              COUNT(*) AS total,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
              SUM(CASE WHEN status IN ('pending', 'running') THEN 1 ELSE 0 END) AS active,
              MIN(logical_date) AS firstLogicalDate,
              MAX(logical_date) AS lastLogicalDate,
              MIN(created_at) AS submittedAt
         FROM executions
        WHERE workflow_id = ? AND backfill_id IS NOT NULL
        GROUP BY backfill_id
        ORDER BY submittedAt DESC
        LIMIT ?`
    )
    .all(workflowId, Math.max(1, Math.min(Number(limit) || 20, 100)))
}

// Stop a batch: request cancellation on every run of it that hasn't settled.
//
// Reuses the ordinary cancel path rather than deleting rows, so a
// half-finished backfill leaves the same evidence as any other cancelled run —
// which matters, because "we backfilled March and stopped it partway" is
// exactly the kind of thing someone needs to reconstruct later. Queued runs are
// finalized immediately (they have nothing to wind down); running ones settle
// cooperatively at their next scheduling round, like every other cancellation.
function cancelBackfill(workflowId, backfillId) {
  const rows = db
    .prepare(
      `SELECT * FROM executions
        WHERE workflow_id = ? AND backfill_id = ? AND status IN ('pending', 'running')`
    )
    .all(workflowId, backfillId)

  const { requestCancel } = require('./executionControl')
  let cancelled = 0
  for (const row of rows) {
    try {
      requestCancel(row)
      cancelled++
    } catch (err) {
      // One stuck row must not abort the rest of the batch — cancelling 200
      // runs is precisely when partial failure is least acceptable.
      console.error(`Backfill cancel failed for ${row.id}:`, err.message)
    }
  }
  return { cancelled }
}

module.exports = {
  MAX_OCCURRENCES,
  scheduleOf,
  parseRange,
  planBackfill,
  submitBackfill,
  listBackfills,
  cancelBackfill,
}
