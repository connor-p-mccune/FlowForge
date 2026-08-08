// SLO error budgets and multi-window burn-rate alerting.
//
// The SLA monitor answers "is this run bad?" and "has the success rate crossed
// a floor?". Both are useful and both share a blind spot: they treat every
// failure as equally urgent. A workflow with a 99% objective is *allowed* to
// fail 1% of the time — that allowance is the point of choosing 99% rather than
// 100% — so an alert on every dip below the floor pages someone for failures the
// objective already budgeted for, and alert fatigue does the rest.
//
// An **error budget** makes the allowance explicit: over a rolling window, a
// 99% objective across 1,000 runs permits 10 failures. The interesting question
// is no longer "did a run fail?" but **"how fast are we spending the budget?"**
//
//   burn rate = observed failure rate ÷ allowed failure rate
//
// A burn rate of 1 exhausts the budget exactly at the end of the window — which
// is what an objective *means*. A burn rate of 14.4 exhausts a 28-day budget in
// under two days.
//
// ## Why two windows
//
// This follows the multi-window, multi-burn-rate approach from Google's SRE
// Workbook, and the reason it uses two windows is the whole design:
//
//   - A **short** window alone is jumpy. Three failures in five minutes is a
//     huge burn rate and often nothing — a deploy, a blip, a flaky dependency
//     that recovered on its own.
//   - A **long** window alone is slow. A severe outage burning 5% of the budget
//     an hour has to run for many hours before a 28-day average notices.
//
// Requiring **both** to be over threshold gives fast detection with far fewer
// false alarms: the short window supplies urgency, the long window supplies
// confirmation that it isn't noise. Two tiers then separate severity:
//
//   fast burn  14.4× over 1h (confirmed by 6h)  → 2% of a 28-day budget in 1h
//   slow burn   6×   over 6h (confirmed by 3d)  → a real, sustained degradation
//
// Those constants are the Workbook's, and they are not arbitrary: 14.4 = 0.02 ×
// (28 days / 1 hour), i.e. exactly the rate that consumes 2% of the window's
// budget within the window's own alerting period.
//
// ## What counts
//
// Only settled, non-dry, top-level runs — the same population the SLA monitor
// and the status page use. Cancelled runs count as **neither** good nor bad: a
// person stopping a run is not the service failing, and counting it against the
// budget would penalise the operator for intervening.

const db = require('../config/database')

// The Workbook's tiers: [short window, long confirmation window, threshold].
// Hours throughout, so the arithmetic below stays in one unit.
const BURN_TIERS = [
  { name: 'fast', shortHours: 1, longHours: 6, threshold: 14.4, severity: 'page' },
  { name: 'slow', shortHours: 6, longHours: 72, threshold: 6, severity: 'ticket' },
]

// Below this many settled runs in a window, a rate is not evidence. Two
// failures out of three runs is a 67% failure rate and means nothing.
const MIN_RUNS_FOR_BURN = 5

// A workflow's objective, or null when it hasn't declared one. The target is a
// *success* fraction (0.99 = "99% of runs succeed"), stored as it is written.
function objectiveFor(workflow) {
  const target = Number(workflow?.slo_target)
  if (!Number.isFinite(target) || target <= 0 || target >= 1) return null
  const days = Number(workflow?.slo_window_days)
  return {
    target,
    windowDays: Number.isFinite(days) && days >= 1 ? Math.floor(days) : 28,
    // The fraction of runs the objective permits to fail. This is the
    // denominator of every burn rate below.
    allowedFailureRate: 1 - target,
  }
}

// Count good/bad runs in the trailing `hours`.
//
// Cancelled runs are excluded from both counts rather than counted as failures:
// a person stopping a run is an intervention, not a service failure, and
// charging it to the budget would penalise exactly the response you want.
function countRuns(workflowId, hours, now = new Date()) {
  const since = new Date(now.getTime() - hours * 3600 * 1000).toISOString()
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS good,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS bad
       FROM executions
      WHERE workflow_id = ?
        AND created_at >= ?
        AND status IN ('completed', 'failed')
        AND (trigger_type IS NULL OR trigger_type != 'dry-run')`
    )
    .get(workflowId, since)
  const good = row?.good || 0
  const bad = row?.bad || 0
  return { good, bad, total: good + bad }
}

// The burn rate over a window: observed failure rate ÷ allowed failure rate.
//
// Returns null when the window holds too few runs to mean anything — which is
// the difference between "we are fine" and "we don't know", and the two must
// not be conflated by returning 0.
function burnRate(workflowId, hours, objective, now) {
  const { bad, total } = countRuns(workflowId, hours, now)
  if (total < MIN_RUNS_FOR_BURN) return { rate: null, total, bad }
  return { rate: bad / total / objective.allowedFailureRate, total, bad }
}

// Evaluate every tier. A tier fires only when its short *and* long windows are
// both over threshold — short for urgency, long for confirmation that the spike
// is not noise.
function evaluateBurn(workflowId, objective, now = new Date()) {
  return BURN_TIERS.map((tier) => {
    const short = burnRate(workflowId, tier.shortHours, objective, now)
    const long = burnRate(workflowId, tier.longHours, objective, now)
    const firing =
      short.rate !== null &&
      long.rate !== null &&
      short.rate >= tier.threshold &&
      long.rate >= tier.threshold
    return {
      name: tier.name,
      severity: tier.severity,
      threshold: tier.threshold,
      shortWindowHours: tier.shortHours,
      longWindowHours: tier.longHours,
      shortRate: short.rate,
      longRate: long.rate,
      shortRuns: short.total,
      firing,
    }
  })
}

// The full SLO picture for a workflow: budget consumed, budget remaining, burn
// tiers, and when the budget runs out at the current rate.
function computeSlo(workflow, now = new Date()) {
  const objective = objectiveFor(workflow)
  if (!objective) return { configured: false }

  const window = countRuns(workflow.id, objective.windowDays * 24, now)
  // The budget is a count of runs, not a percentage: "10 failures" is what an
  // operator can actually reason about, and it is what the burn rates consume.
  const budgetRuns = window.total * objective.allowedFailureRate
  const consumedFraction = budgetRuns > 0 ? window.bad / budgetRuns : 0

  const burn = evaluateBurn(workflow.id, objective, now)
  // The tightest firing tier decides the headline state; 'page' outranks
  // 'ticket' because the tiers are ordered by urgency, not by which fired first.
  const firing = burn.filter((b) => b.firing)

  // Projected exhaustion. Uses the *long* window of the slow tier as the rate
  // estimate rather than the fastest one: a projection built on the jumpiest
  // measurement would swing between "fine" and "two hours left" run to run,
  // which is not a number anyone can act on.
  const sustained = burn.find((b) => b.name === 'slow')?.longRate ?? null
  let exhaustsInHours = null
  if (sustained !== null && sustained > 0 && consumedFraction < 1) {
    // At burn rate r, the whole window's budget is consumed in windowHours / r.
    exhaustsInHours = ((1 - consumedFraction) * objective.windowDays * 24) / sustained
  }

  return {
    configured: true,
    target: objective.target,
    windowDays: objective.windowDays,
    runs: window.total,
    failures: window.bad,
    // Fractional on purpose: 0.4 of a permitted failure is meaningful when the
    // window is small, and rounding it to zero would hide early burn.
    budgetRuns,
    consumedFraction,
    remainingFraction: Math.max(0, 1 - consumedFraction),
    exhausted: consumedFraction >= 1,
    burn,
    alerting: firing.length > 0 ? firing[0].severity : null,
    exhaustsInHours,
  }
}

module.exports = {
  BURN_TIERS,
  MIN_RUNS_FOR_BURN,
  objectiveFor,
  countRuns,
  burnRate,
  evaluateBurn,
  computeSlo,
}
