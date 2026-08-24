// Queueing theory for the concurrency cap.
//
// A workflow's `max_concurrent_runs` is a number somebody typed. The question
// it answers — *how long will a run wait before it starts?* — has a closed-form
// answer given three measurements the database already holds: how often runs
// arrive, how long they occupy a slot, and how many slots there are.
//
// This file is the maths, and nothing else. It takes numbers and returns
// numbers; `capacity.js` is what measures the numbers from run history.
//
// ---
//
// **Why not just watch utilisation.** The obvious dashboard divides running
// runs by the cap and alerts at 80%. Utilisation is not wait, and treating it
// as one is wrong by an order of magnitude in ordinary cases:
//
//     ρ = 0.8, c = 1   →  a run waits about 4.00 × its own service time
//     ρ = 0.8, c = 10  →  a run waits about 0.20 × its own service time
//
// Same utilisation, twenty times the experience. One threshold across pools of
// different sizes is not a conservative approximation of anything — it is
// simultaneously paranoid about the large pool and blind to the small one.
// (This is the square-root staffing result: the headroom a pool needs grows
// like √c, not like c.)
//
// **Why not M/M/c.** The textbook fix assumes exponential service times. A
// workflow's service time is nothing of the sort. A run that waits on a human
// approval holds its slot for however long the human takes; a run that retries
// three times holds it for four attempts and two backoffs. Squared coefficients
// of variation in the tens are ordinary here, not pathological.
//
// So the model is **Allen–Cunneen**, the standard G/G/c approximation:
//
//     Wq(G/G/c)  ≈  (CV²_arrival + CV²_service) / 2  ×  Wq(M/M/c)
//
// With both CV² = 1 the factor is 1 and it reduces to M/M/c exactly, which is
// the property that makes it safe to use everywhere. With a measured service
// CV² of 4 — one human approval is enough — it says the wait is 2.5× what
// M/M/c predicts, so a cap sized on M/M/c under-provisions by that much.
//
// It is an approximation, and the report treats it as one: `capacity.js`
// compares its prediction at the *current* cap against the wait actually
// measured over the same window, and publishes the discrepancy rather than
// asking anyone to take the model on faith.

// — Erlang B and C ————————————————————————————————————————————————————

// Erlang B: the blocking probability of an M/M/c/c loss system with offered
// load `a` erlangs.
//
// Computed by the recurrence rather than the factorial form, and the reason is
// practical: `a^c / c!` overflows a double at c ≈ 170 and loses precision well
// before that, while
//
//     B(0) = 1,  B(k) = a·B(k−1) / (k + a·B(k−1))
//
// is bounded in [0, 1] at every step and exact to the last bit for any cap
// anybody will ever set.
function erlangB(c, a) {
  if (!Number.isFinite(a) || a < 0) return NaN
  if (c <= 0) return 1
  let b = 1
  for (let k = 1; k <= c; k += 1) b = (a * b) / (k + a * b)
  return b
}

// Erlang C: the probability that an arriving job finds every server busy and
// has to queue at all, for M/M/c with offered load `a` and `c` servers.
//
// Derived from Erlang B rather than summed directly, for the same numerical
// reason. Undefined at ρ ≥ 1 — an overloaded queue does not have a steady state
// to compute a probability in — so the caller must check stability first.
function erlangC(c, a) {
  if (c <= 0) return 1
  const rho = a / c
  if (rho >= 1) return 1
  const b = erlangB(c, a)
  return b / (1 - rho * (1 - b))
}

// — Waiting time ——————————————————————————————————————————————————————

// Mean time in queue for M/M/c, in the same time unit as `serviceMs`.
//
//     Wq = C(c, a) · E[S] / (c · (1 − ρ))
function mmcWaitMs(arrivalsPerMs, serviceMs, servers) {
  const a = arrivalsPerMs * serviceMs
  const rho = a / servers
  if (!(rho < 1)) return Infinity
  return (erlangC(servers, a) * serviceMs) / (servers * (1 - rho))
}

// The Allen–Cunneen correction factor. Exactly 1 for Poisson arrivals and
// exponential service, which is what makes this safe to apply unconditionally:
// where the M/M assumptions hold, it changes nothing.
function variabilityFactor(cvSquaredArrival, cvSquaredService) {
  const ca = Number.isFinite(cvSquaredArrival) && cvSquaredArrival >= 0 ? cvSquaredArrival : 1
  const cs = Number.isFinite(cvSquaredService) && cvSquaredService >= 0 ? cvSquaredService : 1
  return (ca + cs) / 2
}

// Mean time in queue for G/G/c (Allen–Cunneen). The number the report leads
// with.
function waitMs(arrivalsPerMs, serviceMs, servers, cvSquaredArrival = 1, cvSquaredService = 1) {
  const base = mmcWaitMs(arrivalsPerMs, serviceMs, servers)
  if (!Number.isFinite(base)) return base
  return variabilityFactor(cvSquaredArrival, cvSquaredService) * base
}

// A percentile of the waiting time.
//
// M/M/c has an exact tail — `P(W > t) = C·e^(−(cμ−λ)t)` — and G/G/c does not.
// What this does is keep that exponential *shape* while stretching it to the
// corrected mean, which is the usual engineering compromise and is stated as an
// approximation everywhere it surfaces. It is also the number the report
// cross-checks hardest against measured history, precisely because it is the
// weakest link in the model.
function waitPercentileMs(
  arrivalsPerMs,
  serviceMs,
  servers,
  p,
  cvSquaredArrival = 1,
  cvSquaredService = 1
) {
  const a = arrivalsPerMs * serviceMs
  const rho = a / servers
  if (!(rho < 1)) return Infinity
  const c = erlangC(servers, a)
  const q = 1 - p
  // Less likely to queue at all than the percentile asks about: that share of
  // arrivals starts immediately, so the percentile is zero.
  if (c <= q) return 0
  const rate = (servers * (1 - rho)) / serviceMs
  const base = Math.log(c / q) / rate
  return variabilityFactor(cvSquaredArrival, cvSquaredService) * base
}

// — Sizing ————————————————————————————————————————————————————————————

// The smallest cap whose mean wait is at or under `targetMs`.
//
// Searched rather than solved, because Erlang C has no closed-form inverse in
// `c` and the search is over a handful of integers. `maxServers` bounds it so a
// target nothing can meet returns null instead of looping — which happens more
// often than it sounds, since a target below the queueing floor of a single
// busy server is not reachable by adding servers at all.
function serversFor(
  arrivalsPerMs,
  serviceMs,
  targetMs,
  cvSquaredArrival = 1,
  cvSquaredService = 1,
  maxServers = 512
) {
  const offered = arrivalsPerMs * serviceMs
  // Below this the queue has no steady state whatever the target is.
  const floor = Math.max(1, Math.floor(offered) + 1)
  for (let c = floor; c <= maxServers; c += 1) {
    if (waitMs(arrivalsPerMs, serviceMs, c, cvSquaredArrival, cvSquaredService) <= targetMs) {
      return c
    }
  }
  return null
}

// — Stability —————————————————————————————————————————————————————————

// Everything about whether the queue has a steady state at all.
//
// `headroom` is the multiple of today's arrival rate at which this cap
// saturates — the single most useful number in the report, because it is the
// one an operator can act on before anything is on fire. Below 1 the backlog is
// already growing without bound and no percentile of the wait is meaningful;
// saying "the wait is 40 minutes" there would be describing a transient on the
// way to infinity.
function stability(arrivalsPerMs, serviceMs, servers) {
  const offered = arrivalsPerMs * serviceMs
  const utilisation = offered / servers
  const capacityPerMs = servers / serviceMs
  return {
    offered,
    utilisation,
    stable: utilisation < 1,
    // Arrivals per ms this cap can absorb before the queue diverges.
    saturationRate: capacityPerMs,
    headroom: arrivalsPerMs > 0 ? capacityPerMs / arrivalsPerMs : Infinity,
  }
}

// — Sample statistics —————————————————————————————————————————————————

// The squared coefficient of variation, Var(X)/E[X]² — the only thing the
// model wants to know about a distribution's shape beyond its mean.
//
// Null rather than a number below two samples or at a zero mean: a CV² invented
// from one observation would silently become the 1.0 that means "exponential",
// which is exactly the assumption this file exists to stop anybody making by
// accident.
function squaredCv(values) {
  const n = values.length
  if (n < 2) return null
  const mean = values.reduce((sum, v) => sum + v, 0) / n
  if (!(mean > 0)) return null
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1)
  return variance / mean ** 2
}

// Gaps between consecutive arrival timestamps, in ms. The input need not be
// sorted; the output is what the arrival CV² is computed over.
function interArrivalGaps(timestampsMs) {
  const sorted = [...timestampsMs].sort((a, b) => a - b)
  const gaps = []
  for (let i = 1; i < sorted.length; i += 1) gaps.push(sorted[i] - sorted[i - 1])
  return gaps
}

// The busiest window of a given length, as an arrival rate.
//
// The mean rate is the wrong statistic for deciding a cap, and it is wrong in
// the direction that matters. A workflow taking 20 runs an hour on average and
// 200 every Monday at nine is *unstable every Monday at nine*, and a report
// averaging over the week says 80% utilised and looks fine. The queue does not
// experience the average.
//
// Directly measured rather than modelled: no seasonality decomposition, no
// hour-of-week bucketing, no minimum-samples-per-bucket problem to reason
// about. A rolling window over the actual arrivals answers the operational
// question as asked — *what is the worst hour this has really had?* — and a
// week of history gives it 168 candidate positions rather than one sample.
//
// Two pointers, so it is one pass. Returns the rate and when it occurred, since
// "Monday 09:00" is what makes somebody recognise their own traffic.
function peakRate(timestampsMs, windowMs) {
  const sorted = [...timestampsMs].sort((a, b) => a - b)
  if (sorted.length === 0 || !(windowMs > 0)) return { ratePerMs: 0, count: 0, startedAtMs: null }

  let best = 0
  let bestStart = sorted[0]
  let left = 0
  for (let right = 0; right < sorted.length; right += 1) {
    while (sorted[right] - sorted[left] >= windowMs) left += 1
    const count = right - left + 1
    if (count > best) {
      best = count
      bestStart = sorted[left]
    }
  }
  return { ratePerMs: best / windowMs, count: best, startedAtMs: bestStart }
}

module.exports = {
  erlangB,
  erlangC,
  mmcWaitMs,
  waitMs,
  waitPercentileMs,
  variabilityFactor,
  serversFor,
  stability,
  squaredCv,
  interArrivalGaps,
  peakRate,
}
