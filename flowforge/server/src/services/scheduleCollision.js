// Everything fires at midnight.
//
// Every timing analysis in this codebase is about **one** thing.
// [`scheduleSim.js`](./scheduleSim.js) models the parallelism cap inside a
// single run. [`capacity.js`](./capacity.js) models the queue in front of a
// single workflow. [`criticalPath.js`](./criticalPath.js) finds the longest
// chain in a single execution. Nothing models the machine all of them share.
//
// And the load on that machine is not random, because cron is written by
// people and people write round numbers. Nobody schedules a report for 03:47.
// They pick midnight, or the top of the hour, and every workflow added over
// three years picked it independently — so a workspace's scheduled load
// arrives in a spike nobody designed, at a time nobody is awake to see, and
// the only symptom is that the 00:00 runs are slower than the 00:05 ones.
//
// That is a **max-overlap problem**, which is a sweep line, which is thirty
// lines. The inputs are all recorded: the cron expressions, the time zones the
// scheduler already honours, and how long each workflow's runs actually take.
//
// ---
//
// ## What "collide" means here
//
// Not "start at the same instant" — that would miss the 40-minute job that
// starts at midnight and is still holding a worker when the 00:30 job lands.
// An occurrence occupies `[start, start + mean duration)`, and the peak is the
// largest number of those intervals that overlap at any instant. The same
// definition [capacity.js](./capacity.js) uses for a slot, applied to the
// workspace instead of to one workflow.
//
// ## Time zones are not decoration
//
// The scheduler evaluates each workflow's cron in its own zone
// (`scheduler.scheduleTimeZone`), so two workflows both scheduled for
// "midnight" in different zones do not collide, and two scheduled for
// different hours may. Expanding every expression in UTC would invent
// collisions and hide real ones, so each is expanded through the same
// `cronExpression.nextRuns` the preview uses, with the same zone the scheduler
// would use.
//
// ## What it will not do
//
// It reports a **lower bound** whenever a scheduled workflow has no measured
// duration, and says how many. Substituting a nominal duration would produce a
// peak built partly out of a number nobody measured, which is exactly the kind
// of figure that gets quoted in a capacity conversation and never questioned.

const db = require('../config/database')
const { nextRuns, isValid } = require('./cronExpression')
const { scheduleTimeZone } = require('./scheduler')

// A week: long enough that a weekly cron appears at all, short enough that the
// expansion stays small and the answer is about the schedule as it is now.
const HORIZON_DAYS = 7

// Cron expands to at most this many occurrences per workflow. A `* * * * *`
// schedule over a week is 10,080 fires, which is a legitimate thing to have and
// not something to expand one row at a time.
const MAX_OCCURRENCES = 500

const MINUTE_MS = 60000

// Where a suggested shift may move a run to. Minutes only, and inside the hour
// it already fires in: a daily 00:00 job moved to 00:17 still runs nightly, and
// one moved to 01:00 is a different schedule than the author asked for.
const SHIFT_LIMIT_MINUTES = 55

// The schedule trigger's cron and zone, or null when the workflow has neither.
function scheduleOf(workflow) {
  try {
    const { nodes } = JSON.parse(workflow.graph_json)
    const node = (nodes || []).find((n) => n.type === 'trigger-schedule')
    const cron = node?.data?.config?.cron
    if (!cron || !isValid(String(cron))) return null
    return { cron: String(cron), timeZone: scheduleTimeZone(node.data?.config) }
  } catch {
    // An unreadable graph has no schedule as far as this is concerned; the
    // linter owns saying so.
    return null
  }
}

// Mean wall-clock duration per workflow over recent history, in ms.
//
// The mean rather than the p95, because the question is how much of the machine
// this occupies on an ordinary night. A p95 peak would be the worst night of
// the quarter, which is a different and much less actionable report.
function meanDurations(workspaceId, days) {
  const since = new Date(Date.now() - days * 86400000).toISOString()
  const rows = db
    .prepare(
      `SELECT e.workflow_id AS id,
              AVG((julianday(e.finished_at) - julianday(e.started_at)) * 86400000) AS ms,
              COUNT(*) AS runs
         FROM executions e
         JOIN workflows w ON w.id = e.workflow_id
        WHERE w.workspace_id = ?
          AND e.created_at >= ?
          AND e.started_at IS NOT NULL AND e.finished_at IS NOT NULL
          AND (e.trigger_type IS NULL OR e.trigger_type != 'dry-run')
        GROUP BY e.workflow_id`
    )
    .all(workspaceId, since)
  const out = new Map()
  for (const row of rows) {
    if (Number.isFinite(row.ms) && row.ms > 0) out.set(row.id, { ms: row.ms, runs: row.runs })
  }
  return out
}

// Every occurrence of every schedule over the horizon, as intervals.
function expand(schedules, fromMs, horizonMs) {
  const intervals = []
  const from = new Date(fromMs)
  for (const s of schedules) {
    const fires = nextRuns(s.cron, MAX_OCCURRENCES, from, { timeZone: s.timeZone })
    for (const at of fires) {
      const startMs = at.getTime()
      if (startMs > fromMs + horizonMs) break
      intervals.push({ workflowId: s.workflowId, name: s.name, startMs, endMs: startMs + s.durationMs })
    }
  }
  return intervals
}

// Max overlap by sweep line: +1 at every start, -1 at every end, ends before
// starts at a tie because a run that finishes at exactly midnight has released
// its worker before the midnight run needs one.
function peakOverlap(intervals) {
  const events = []
  for (const i of intervals) {
    events.push({ at: i.startMs, delta: 1, interval: i })
    events.push({ at: i.endMs, delta: -1, interval: i })
  }
  events.sort((a, b) => a.at - b.at || a.delta - b.delta)

  const live = new Set()
  let best = { count: 0, at: null, intervals: [] }
  let count = 0
  for (const e of events) {
    if (e.delta === 1) {
      count += 1
      live.add(e.interval)
      if (count > best.count) best = { count, at: e.at, intervals: [...live] }
    } else {
      count -= 1
      live.delete(e.interval)
    }
  }
  return best
}

// How much of the schedule lands on a round number.
//
// Reported because it is the finding, not a curiosity: a workspace whose peak
// is an accident of everyone independently picking midnight has a cheap fix,
// and one whose load is genuinely that high does not.
function roundness(intervals) {
  let onTheHour = 0
  let atMidnight = 0
  for (const i of intervals) {
    const d = new Date(i.startMs)
    if (d.getUTCMinutes() === 0) onTheHour += 1
    if (d.getUTCMinutes() === 0 && d.getUTCHours() === 0) atMidnight += 1
  }
  return {
    occurrences: intervals.length,
    onTheHour,
    atMidnight,
    share: intervals.length ? Number((onTheHour / intervals.length).toFixed(3)) : 0,
  }
}

// The single move that flattens the peak most.
//
// Tries shifting one workflow's occurrences by a whole number of minutes inside
// the hour they already fire in, and re-measures. A suggestion rather than an
// action, and constrained to minutes on purpose: moving a daily 00:00 job to
// 00:17 still runs it nightly, and moving it to 01:00 is a different schedule
// than its author asked for.
function bestShift(intervals, peak) {
  if (peak.count < 2) return null

  // Only the workflows actually in the peak can reduce it, and only one of them
  // is moved — a report that suggested rescheduling six things at once is one
  // nobody acts on.
  const candidates = [...new Set(peak.intervals.map((i) => i.workflowId))]
  let best = null

  for (const workflowId of candidates) {
    for (let minutes = 5; minutes <= SHIFT_LIMIT_MINUTES; minutes += 5) {
      const shifted = intervals.map((i) =>
        i.workflowId === workflowId
          ? { ...i, startMs: i.startMs + minutes * MINUTE_MS, endMs: i.endMs + minutes * MINUTE_MS }
          : i
      )
      const after = peakOverlap(shifted).count
      if (after < peak.count && (!best || after < best.peakAfter)) {
        const one = peak.intervals.find((i) => i.workflowId === workflowId)
        best = { workflowId, name: one?.name, minutes, peakBefore: peak.count, peakAfter: after }
      }
    }
  }
  return best
}

// What a week of this workspace's schedules does to the machine they share.
function analyzeSchedule(workspaceId, { horizonDays = HORIZON_DAYS, capacity = null } = {}) {
  const workflows = db
    .prepare(
      `SELECT id, name, graph_json FROM workflows
        WHERE workspace_id = ? AND status = 'deployed' AND paused_at IS NULL`
    )
    .all(workspaceId)

  const durations = meanDurations(workspaceId, 30)
  const schedules = []
  const unmeasured = []

  for (const wf of workflows) {
    const schedule = scheduleOf(wf)
    if (!schedule) continue
    const measured = durations.get(wf.id)
    if (!measured) {
      // Kept out of the overlap rather than given a nominal duration: a peak
      // built partly from a number nobody measured is the kind of figure that
      // gets quoted and never questioned.
      unmeasured.push({ workflowId: wf.id, name: wf.name, cron: schedule.cron })
      continue
    }
    schedules.push({
      workflowId: wf.id,
      name: wf.name,
      cron: schedule.cron,
      timeZone: schedule.timeZone,
      durationMs: Math.round(measured.ms),
      runs: measured.runs,
    })
  }

  if (schedules.length === 0) {
    return {
      available: false,
      reason: unmeasured.length > 0 ? 'nothing-measured' : 'no-schedules',
      workspaceId,
      horizonDays,
      unmeasured,
    }
  }

  const fromMs = Date.now()
  const horizonMs = horizonDays * 86400000
  const intervals = expand(schedules, fromMs, horizonMs)
  const peak = peakOverlap(intervals)
  const shift = bestShift(intervals, peak)

  // Named once, at the peak, because "which workflows collide" is the question
  // and a list of every pair that ever overlaps is not an answer to it.
  const colliding = [...new Set(peak.intervals.map((i) => i.workflowId))].map((id) => {
    const s = schedules.find((x) => x.workflowId === id)
    return {
      workflowId: id,
      name: s.name,
      cron: s.cron,
      timeZone: s.timeZone,
      durationMs: s.durationMs,
    }
  })

  return {
    available: true,
    workspaceId,
    horizonDays,
    schedules: schedules.map((s) => ({
      workflowId: s.workflowId,
      name: s.name,
      cron: s.cron,
      timeZone: s.timeZone,
      durationMs: s.durationMs,
      occurrences: intervals.filter((i) => i.workflowId === s.workflowId).length,
    })),
    peak: {
      concurrent: peak.count,
      at: peak.at ? new Date(peak.at).toISOString() : null,
      workflows: colliding,
    },
    suggestion: shift,
    clock: roundness(intervals),
    summary: {
      scheduled: schedules.length,
      occurrences: intervals.length,
      // Stated rather than implied: with any of these excluded the peak is a
      // floor, not a measurement.
      unmeasured: unmeasured.length,
      lowerBound: unmeasured.length > 0,
      capacity,
      // Null when the caller did not say what the machine can do — inventing a
      // capacity would turn "here is your peak" into a verdict nobody asked for.
      overCapacity: capacity == null ? null : peak.count > capacity,
    },
    unmeasured,
  }
}

module.exports = {
  analyzeSchedule,
  peakOverlap,
  bestShift,
  roundness,
  HORIZON_DAYS,
  MAX_OCCURRENCES,
}
