// Is this workflow's concurrency cap the right number?
//
// `max_concurrent_runs` is a number somebody typed once. Everything downstream
// of it — whether a run starts now or sits in the queue, whether a burst
// drains or accumulates — follows from it, and nothing in the product has ever
// said whether it was a good number.
//
// It is answerable. Three measurements decide it, and the database already
// holds all three: how often runs arrive (`created_at`), how long each occupies
// its slot (`finished_at − started_at`), and how many slots there are. The
// maths is in `queueing.js`; this file measures the inputs and assembles the
// report.
//
// ---
//
// **The report grades itself.** Every capacity tool produces a model, and a
// model is a claim. This one is in the unusual position of being able to check
// its own claim, because the wait it predicts is also *recorded*:
// `started_at − created_at` is exactly the queueing delay, per run, already in
// the table. So the report predicts the wait at the current cap, compares it
// against what actually happened over the same window, and publishes the gap.
//
// That comparison is the most valuable line in the output. A model that agrees
// with history has earned the counterfactual it is really being asked for —
// *what would the wait be at a cap of 8?* — which is the one question no amount
// of measurement can answer, because that cap was never run.
//
// **What it refuses to answer.** Below `MIN_RUNS` there is nothing to measure.
// Past saturation there is no steady state, so the report says the backlog
// grows without bound rather than quoting a large finite wait — which would be
// describing a transient on the way to infinity. And a workflow with no cap set
// is not queueing at all, so there is no queue to model.
//
// **What the cap does not cover.** A sub-workflow call runs inside the
// caller's engine loop, holding the *caller's* slot; it never asks the worker
// for one of the callee's, so it never queues and the callee's cap never sees
// it. A workflow that is mostly invoked as a subroutine therefore has a cap
// that governs almost nothing, and the honest report of it is not a wait
// prediction — it is that sentence. `governance` carries the split on every
// payload, and a workflow with enough traffic but not enough *governed*
// traffic is `not-governed` rather than `not-enough-runs`, because those two
// send somebody to do entirely different things.

const db = require('../config/database')
const queueing = require('./queueing')
const { percentile, mean } = require('./runStats')

// A week of history by default: long enough to cover a weekly cycle, short
// enough that a cap changed a month ago is not being judged on traffic it never
// saw.
const WINDOW_DAYS = 7

// Below this the arrival rate is a rumour. Ten runs over a week is not a
// Poisson process, it is ten events, and sizing a production cap on it would be
// worse than saying nothing.
const MIN_RUNS = 30

// Candidate caps the report evaluates around the current one, so the answer to
// "what if I doubled it?" is in the payload rather than requiring another call.
const CURVE_SPAN = 8

const isoAgo = (days) => new Date(Date.now() - days * 86400000).toISOString()
const msOf = (iso) => (iso ? Date.parse(iso) : NaN)

// The runs the measurement is built from — which is to say, the runs the cap
// actually governs.
//
// Dry runs are excluded because they never occupied a slot. Runs still in
// flight are excluded from the *service* sample (their duration is unknown) but
// kept in the *arrival* sample, because they did arrive — dropping them would
// under-count exactly the traffic a saturated queue is drowning in.
//
// **Sub-workflow child runs are excluded too**, and that one is not a modelling
// nicety. The cap is enforced by the worker at pickup, and the worker only ever
// sees top-level runs: a sub-workflow call executes inside the parent's engine
// loop, holding the *parent's* slot and never asking for one of the callee's.
// So a called run does not queue, does not wait, and is not subject to the
// number this report is about.
//
// Including them was wrong in both directions at once. They inflated the
// arrival rate the model predicts a wait from, and — because their
// `started_at` is effectively their `created_at` — they filled the observed
// wait sample with zeros. The calibration check compares those two, so a
// mostly-called workflow could report agreement built entirely out of traffic
// neither number describes.
function sampleRuns(workflowId, windowDays) {
  return db.prepare(`
    SELECT created_at, started_at, finished_at, status
    FROM executions
    WHERE workflow_id = ? AND created_at >= ?
      AND (trigger_type IS NULL OR trigger_type != 'dry-run')
      AND parent_execution_id IS NULL
    ORDER BY created_at ASC
  `).all(workflowId, isoAgo(windowDays))
}

// What reaches this workflow without passing the cap, and who sent it.
//
// Read from the executions themselves rather than from the call graph: this is
// traffic that happened, not traffic a graph says could. A workflow whose
// callers were rewired last week should report last week's callers as gone.
function calledTraffic(workflowId, windowDays) {
  const since = isoAgo(windowDays)
  const { n } = db
    .prepare(
      `SELECT COUNT(*) AS n FROM executions
        WHERE workflow_id = ? AND created_at >= ?
          AND (trigger_type IS NULL OR trigger_type != 'dry-run')
          AND parent_execution_id IS NOT NULL`
    )
    .get(workflowId, since)
  const callers = db
    .prepare(
      `SELECT DISTINCT pw.id AS id, pw.name AS name
         FROM executions e
         JOIN executions p ON p.id = e.parent_execution_id
         JOIN workflows pw ON pw.id = p.workflow_id
        WHERE e.workflow_id = ? AND e.created_at >= ?
        ORDER BY pw.name`
    )
    .all(workflowId, since)
  return { runs: n, callers }
}

// What the history says, before any model touches it.
function measure(rows, windowDays) {
  const arrivals = rows.map((r) => msOf(r.created_at)).filter(Number.isFinite)

  const serviceMs = []
  const waitMs = []
  for (const row of rows) {
    const created = msOf(row.created_at)
    const started = msOf(row.started_at)
    const finished = msOf(row.finished_at)
    // A run that never started contributes no wait *yet* — counting the time it
    // has been waiting so far would report a censored value as a completed one.
    if (Number.isFinite(created) && Number.isFinite(started) && started >= created) {
      waitMs.push(started - created)
    }
    if (Number.isFinite(started) && Number.isFinite(finished) && finished >= started) {
      serviceMs.push(finished - started)
    }
  }

  // The denominator is the period the workflow was actually able to receive
  // traffic, not the nominal window.
  //
  // A workflow three days old asked about over thirty days would otherwise
  // report a tenth of its real arrival rate — and that error runs in the
  // dangerous direction: it makes a cap look far safer than it is, on exactly
  // the workflows nobody has capacity data for yet. Floored at an hour so a
  // burst inside one minute cannot divide by almost nothing.
  const nominalMs = windowDays * 86400000
  const firstArrivalMs = arrivals.length ? Math.min(...arrivals) : NaN
  const observedMs = Number.isFinite(firstArrivalMs) ? Date.now() - firstArrivalMs : nominalMs
  const windowMs = Math.max(3600000, Math.min(nominalMs, observedMs))

  // The mean rate is the wrong statistic for deciding a cap, and it is wrong in
  // the direction that matters: a workflow taking 20 runs an hour on average
  // and 200 every Monday at nine is unstable every Monday at nine, and an
  // average over the week says 80% utilised and looks fine. The queue does not
  // experience the average.
  //
  // Two window lengths, because they answer different questions. The busiest
  // hour is about *bursts* — whether the queue absorbs a spike. The busiest day
  // is about *sustained* load, which is what actually diverges.
  const peakHour = queueing.peakRate(arrivals, 3600000)
  const peakDay = queueing.peakRate(arrivals, 86400000)

  return {
    runs: rows.length,
    windowDays,
    // What the rate was actually measured over, which is the nominal window
    // only once the workflow is at least that old.
    measuredOverDays: Number((windowMs / 86400000).toFixed(2)),
    // Per millisecond, which is what queueing.js wants; the surfaces convert.
    arrivalRatePerMs: arrivals.length / windowMs,
    arrivalsPerHour: (arrivals.length / windowMs) * 3600000,
    peakHour: {
      ratePerMs: peakHour.ratePerMs,
      perHour: peakHour.ratePerMs * 3600000,
      runs: peakHour.count,
      startedAt: peakHour.startedAtMs ? new Date(peakHour.startedAtMs).toISOString() : null,
    },
    peakDay: {
      ratePerMs: peakDay.ratePerMs,
      perHour: peakDay.ratePerMs * 3600000,
      runs: peakDay.count,
      startedAt: peakDay.startedAtMs ? new Date(peakDay.startedAtMs).toISOString() : null,
    },
    serviceMeanMs: mean(serviceMs),
    serviceP50Ms: percentile(serviceMs, 50),
    serviceP95Ms: percentile(serviceMs, 95),
    // The two numbers that decide whether M/M/c would have been good enough.
    cvSquaredService: queueing.squaredCv(serviceMs),
    cvSquaredArrival: queueing.squaredCv(queueing.interArrivalGaps(arrivals)),
    observedWaitMeanMs: mean(waitMs),
    observedWaitP50Ms: percentile(waitMs, 50),
    observedWaitP95Ms: percentile(waitMs, 95),
    sampled: { service: serviceMs.length, wait: waitMs.length },
  }
}

// The model's prediction at one cap, at a given arrival rate.
//
// `rate` defaults to the measured mean; passing a peak rate is how the report
// answers the question the mean cannot — *and what about Monday morning?*
function predict(measured, servers, rate = null) {
  const { serviceMeanMs, cvSquaredArrival, cvSquaredService } = measured
  const arrivalRatePerMs = rate ?? measured.arrivalRatePerMs
  const ca = cvSquaredArrival ?? 1
  const cs = cvSquaredService ?? 1
  const s = queueing.stability(arrivalRatePerMs, serviceMeanMs, servers)
  if (!s.stable) {
    return {
      servers,
      stable: false,
      utilisation: s.utilisation,
      headroom: s.headroom,
      waitMeanMs: null,
      waitP95Ms: null,
    }
  }
  return {
    servers,
    stable: true,
    utilisation: s.utilisation,
    headroom: s.headroom,
    waitMeanMs: queueing.waitMs(arrivalRatePerMs, serviceMeanMs, servers, ca, cs),
    waitP95Ms: queueing.waitPercentileMs(arrivalRatePerMs, serviceMeanMs, servers, 0.95, ca, cs),
  }
}

// How well the model describes the window it was measured from.
//
// `ratio` is predicted ÷ observed. Near 1 the model has earned the
// counterfactual it is about to be asked for; far from it, the report says so
// and the recommendation is downgraded to a suggestion.
//
// The asymmetry in the verdicts is deliberate. Predicting *more* wait than
// happened is the safe direction — a cap sized on it is generous. Predicting
// less is the direction that under-provisions, so it gets the sharper label.
function calibrate(measured, predicted) {
  const observed = measured.observedWaitMeanMs
  if (predicted.waitMeanMs == null || observed == null || measured.sampled.wait < MIN_RUNS) {
    return { comparable: false, ratio: null, verdict: 'not-enough-history' }
  }
  // Both near zero: an idle queue is not evidence for or against a model, and a
  // ratio of two tiny numbers is noise dressed as a diagnostic.
  const FLOOR_MS = 50
  if (observed < FLOOR_MS && predicted.waitMeanMs < FLOOR_MS) {
    return { comparable: true, ratio: null, verdict: 'no-queue-to-check' }
  }
  const ratio = predicted.waitMeanMs / Math.max(observed, 1)
  const verdict =
    ratio >= 0.5 && ratio <= 2 ? 'agrees' : ratio > 2 ? 'over-predicts' : 'under-predicts'
  return { comparable: true, ratio, verdict, observedMs: observed, predictedMs: predicted.waitMeanMs }
}

// The whole report for one workflow.
//
// `targetWaitMs` is what the recommendation is sized against. Null means no
// recommendation is made — the curve is still there for somebody to read.
function analyzeCapacity(
  workflowId,
  { windowDays = WINDOW_DAYS, targetWaitMs = null, cap = null } = {}
) {
  const workflow = db
    .prepare('SELECT id, name, max_concurrent_runs FROM workflows WHERE id = ?')
    .get(workflowId)
  if (!workflow) return { available: false, reason: 'not-found' }

  const configured = cap ?? workflow.max_concurrent_runs ?? null
  if (!configured || configured <= 0) {
    // No cap means no queue: runs start when the worker picks them up. There is
    // a global worker limit above this, but it is not this workflow's number and
    // reporting it here would attribute somebody else's contention to this
    // graph.
    return { available: false, reason: 'no-cap', workflowId, name: workflow.name }
  }

  const rows = sampleRuns(workflowId, windowDays)
  const called = calledTraffic(workflowId, windowDays)
  const reaching = rows.length + called.runs
  // How much of what reaches this workflow the cap is actually applied to.
  // Reported on every payload, including the ones that decline to model
  // anything, because "the cap governs a tenth of the traffic" is the more
  // useful sentence in exactly the cases the model has least to say.
  const governance = {
    governed: rows.length,
    called: called.runs,
    share: reaching > 0 ? Number((rows.length / reaching).toFixed(3)) : 1,
    callers: called.callers.map((c) => ({ workflowId: c.id, name: c.name })),
  }

  if (rows.length < MIN_RUNS) {
    return {
      available: false,
      // Two different sentences, and conflating them sends somebody to wait for
      // history that is already there. A workflow called thirty times and
      // triggered twice does not lack traffic; it lacks traffic this cap has
      // any say over.
      reason: called.runs >= MIN_RUNS ? 'not-governed' : 'not-enough-runs',
      workflowId,
      name: workflow.name,
      runs: rows.length,
      needed: MIN_RUNS,
      windowDays,
      governance,
    }
  }

  const measured = measure(rows, windowDays)
  if (!measured.serviceMeanMs || measured.serviceMeanMs <= 0) {
    return { available: false, reason: 'no-service-time', workflowId, name: workflow.name }
  }

  const current = predict(measured, configured)
  const calibration = calibrate(measured, current)

  // Caps around the current one, so "what if I doubled it?" is already answered.
  const lowest = Math.max(1, configured - Math.floor(CURVE_SPAN / 2))
  const curve = []
  for (let c = lowest; c <= configured + CURVE_SPAN; c += 1) curve.push(predict(measured, c))

  // The same cap judged at the rates that actually happened rather than at the
  // average of them. A cap can be comfortable on the mean and diverging every
  // Monday, and only one of those two facts is worth being woken up about.
  const peak = {
    hour: {
      ...predict(measured, configured, measured.peakHour.ratePerMs),
      perHour: measured.peakHour.perHour,
      runs: measured.peakHour.runs,
      startedAt: measured.peakHour.startedAt,
    },
    day: {
      ...predict(measured, configured, measured.peakDay.ratePerMs),
      perHour: measured.peakDay.perHour,
      runs: measured.peakDay.runs,
      startedAt: measured.peakDay.startedAt,
    },
  }

  const confident =
    calibration.verdict === 'agrees' || calibration.verdict === 'no-queue-to-check'

  const sizeFor = (rate) =>
    queueing.serversFor(
      rate,
      measured.serviceMeanMs,
      targetWaitMs,
      measured.cvSquaredArrival ?? 1,
      measured.cvSquaredService ?? 1
    )

  let recommendation = null
  let peakRecommendation = null
  if (targetWaitMs != null && Number.isFinite(targetWaitMs)) {
    const needed = sizeFor(measured.arrivalRatePerMs)
    recommendation = {
      targetWaitMs,
      servers: needed,
      change: needed == null ? null : needed - configured,
      // A model that does not describe the past has not earned an instruction
      // about the future. Same number, weaker claim.
      confident,
    }
    // Reported separately rather than folded into the recommendation, because
    // provisioning for the busiest hour of the week is a cost decision somebody
    // else gets to make. What this owes them is the number, not the choice.
    const neededAtPeak = sizeFor(measured.peakHour.ratePerMs)
    peakRecommendation = {
      targetWaitMs,
      servers: neededAtPeak,
      change: neededAtPeak == null ? null : neededAtPeak - configured,
      basis: 'busiest-hour',
      confident,
    }
  }

  return {
    available: true,
    workflowId,
    name: workflow.name,
    cap: configured,
    // What the cap governs, beside what it was measured on. A number this
    // report has just sized against a tenth of the traffic is a number whose
    // limits belong in the payload, not only in the docs.
    governance,
    measured,
    current,
    peak,
    calibration,
    curve,
    recommendation,
    peakRecommendation,
    // Stated in the payload rather than only in the docs: a consumer that
    // reports the wait without reporting what it assumed is doing the thing
    // this whole file exists to argue against.
    model: {
      name: 'Allen–Cunneen G/G/c',
      variabilityFactor: queueing.variabilityFactor(
        measured.cvSquaredArrival ?? 1,
        measured.cvSquaredService ?? 1
      ),
      // What M/M/c would have said, so the cost of the exponential assumption
      // is visible rather than argued about.
      mmcWaitMeanMs: current.stable
        ? queueing.mmcWaitMs(measured.arrivalRatePerMs, measured.serviceMeanMs, configured)
        : null,
    },
  }
}

module.exports = { analyzeCapacity, measure, predict, calibrate, WINDOW_DAYS, MIN_RUNS }
