// Run priority lanes. Every run enters the shared Bull queue with one of
// three priorities — 'high', 'normal' (default), 'low' — so an interactive
// smoke test doesn't sit behind fifty bulk imports, and a nightly batch can
// be told to yield. Two knobs, resolved in order:
//
//   1. a per-trigger override (API body / public-API query param / CLI flag),
//   2. the workflow's default_priority column,
//
// falling back to 'normal'. Priority orders *pickup*, never preempts:
// jobs already executing are untouched, and Bull guarantees FIFO within a
// priority level, so equal-priority runs still execute in submission order.
// Dry runs always ride the high lane — someone is watching the canvas.
//
// The level is persisted on the execution row (executions.priority) so run
// history can show which lane a run took, and re-parks at a concurrency cap
// re-enqueue with the same Bull priority — deferral must not silently demote
// a run.

const LEVELS = ['high', 'normal', 'low']

// Bull: lower number = picked up sooner. Gaps left for the day someone needs
// a lane between these.
const BULL_PRIORITY = { high: 1, normal: 5, low: 10 }

function isValidPriority(value) {
  return LEVELS.includes(value)
}

// The lane a run should take: an explicit valid request wins, else the
// workflow's default, else 'normal'. Invalid *explicit* requests are the
// caller's error to surface (routes 400 them before calling this); an
// invalid stored default just falls through — a bad row must not break runs.
function resolvePriority(requested, workflow) {
  if (isValidPriority(requested)) return requested
  if (workflow && isValidPriority(workflow.default_priority)) return workflow.default_priority
  return 'normal'
}

// Bull job options for a level. Unknown levels map to normal so a legacy
// caller can never crash the enqueue.
function enqueueOpts(level) {
  return { priority: BULL_PRIORITY[level] ?? BULL_PRIORITY.normal }
}

module.exports = { LEVELS, isValidPriority, resolvePriority, enqueueOpts }
