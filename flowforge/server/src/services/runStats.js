// Robust run statistics: the math behind the workflow-insights endpoint and the
// SLA monitor. Kept as pure functions of plain number arrays — no database, no
// engine, no I/O — so it's exhaustively unit-testable and the two callers (a
// read endpoint and a completion-time alert) share exactly one implementation.
//
// Two design choices are deliberate:
//
//  1. Percentiles use linear interpolation between order statistics (the "R-7"
//     method — NumPy's default and Excel's PERCENTILE.INC), not a nearest-rank
//     pick. For the small samples a single workflow produces, interpolating
//     avoids a p95 that lurches between two raw observations as one run ages out
//     of the window.
//
//  2. Anomaly detection is a *robust* method — the modified z-score of Iglewicz
//     & Hoaglin (1993), built on the median and the median absolute deviation
//     (MAD) rather than the mean and standard deviation. A workflow's durations
//     are heavy-tailed (a handful of runs that hit a cold cache or a slow
//     upstream sit far above the body), and the mean/stdev a classic z-score
//     needs are dragged toward those very outliers, masking them. The median and
//     MAD have a ~50% breakdown point, so half the sample can be pathological
//     before the estimate moves — exactly what "was this run abnormally slow?"
//     wants.

// Iglewicz & Hoaglin's recommended cut-off: |modified z| > 3.5 flags a point as
// a potential outlier. Exposed so the API, the SLA monitor, and the tests all
// agree on one number.
const OUTLIER_THRESHOLD = 3.5

// 0.6745 is the 0.75 quantile of the standard normal (≈ E[MAD]/σ for normal
// data), so dividing by MAD/0.6745 rescales the deviation to be comparable to a
// standard z-score. 1.253314 = √(π/2) is the analogous factor for the *mean*
// absolute deviation, used only in the MAD = 0 fallback below.
const MAD_SCALE = 0.6745
const MEAN_AD_SCALE = 1.253314

// Median of an already-sorted numeric array. Returns null for an empty array so
// callers can distinguish "no data" from a real zero.
function medianSorted(sorted) {
  const n = sorted.length
  if (n === 0) return null
  const mid = n >> 1
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// The p-th percentile (p in [0, 100]) of a numeric array by linear
// interpolation between the two closest order statistics (R-7). Copies before
// sorting so the caller's array is left untouched.
function percentile(values, p) {
  const n = values.length
  if (n === 0) return null
  if (n === 1) return values[0]
  const sorted = [...values].sort((a, b) => a - b)
  const rank = (Math.min(Math.max(p, 0), 100) / 100) * (n - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return sorted[lo]
  const frac = rank - lo
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac
}

function mean(values) {
  if (values.length === 0) return null
  return values.reduce((a, b) => a + b, 0) / values.length
}

// Sample standard deviation (n − 1 denominator). Needs at least two points;
// a single observation has no spread, so return 0.
function stdev(values) {
  const n = values.length
  if (n < 2) return n === 1 ? 0 : null
  const m = mean(values)
  const variance = values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (n - 1)
  return Math.sqrt(variance)
}

// Median absolute deviation about the median: median(|xᵢ − median(x)|). The
// robust scale estimate the modified z-score is built on.
function medianAbsoluteDeviation(values, med) {
  if (values.length === 0) return null
  const center = med == null ? medianSorted([...values].sort((a, b) => a - b)) : med
  const deviations = values.map((v) => Math.abs(v - center)).sort((a, b) => a - b)
  return medianSorted(deviations)
}

// Modified z-score for every value, aligned to the input order:
//
//   Mᵢ = 0.6745 · (xᵢ − median) / MAD
//
// When MAD is 0 (more than half the sample shares the median value — common for
// fast, near-constant steps) the formula is undefined, so fall back to the mean
// absolute deviation form Iglewicz & Hoaglin give for exactly this case:
//
//   Mᵢ = (xᵢ − median) / (1.253314 · meanAD)
//
// If both dispersion estimates are 0 the sample is constant and nothing is an
// outlier, so every score is 0. Fewer than three points can't establish a
// baseline (a two-point sample makes each look like it deviates), so scores are
// all 0 there too — the caller treats that as "not enough history to judge".
function modifiedZScores(values) {
  const n = values.length
  if (n < 3) return values.map(() => 0)
  const sorted = [...values].sort((a, b) => a - b)
  const med = medianSorted(sorted)
  const mad = medianAbsoluteDeviation(values, med)
  if (mad && mad > 0) {
    return values.map((v) => (MAD_SCALE * (v - med)) / mad)
  }
  const meanAd = mean(values.map((v) => Math.abs(v - med)))
  if (meanAd && meanAd > 0) {
    return values.map((v) => (v - med) / (MEAN_AD_SCALE * meanAd))
  }
  return values.map(() => 0)
}

// Two-sided z at the 95% confidence level — the significance cut-off for the
// Mann-Kendall trend test below.
const TREND_Z_95 = 1.96

// Mann-Kendall test for a monotonic trend in a time-ordered series. A
// non-parametric test (it ranks pairs, never assumes normality or linearity),
// which suits run durations: it answers "is this workflow trending slower?"
// without pretending the trend is a straight line or the noise is Gaussian.
//
// S = Σ_{i<j} sign(xⱼ − xᵢ) counts how many later values exceed earlier ones vs.
// the reverse. Under the no-trend null, S is ~normal with mean 0 and variance
//
//   Var(S) = [ n(n−1)(2n+5) − Σ_g t_g(t_g−1)(2t_g+5) ] / 18
//
// where the tie correction sums over groups of t_g equal values (durations
// repeat, so the correction matters). The test statistic applies a continuity
// correction (±1), Kendall's τ = S / (n(n−1)/2) is the effect size, and a trend
// is called only when |z| clears the 95% cut-off. `values` must be in
// chronological order (oldest → newest).
function mannKendall(values) {
  const n = values.length
  if (n < 3) return { n, s: 0, tau: null, z: null, trend: 'insufficient', significant: false }

  let s = 0
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) s += Math.sign(values[j] - values[i])
  }

  const counts = new Map()
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1)
  let tieCorrection = 0
  for (const t of counts.values()) if (t > 1) tieCorrection += t * (t - 1) * (2 * t + 5)

  const varS = (n * (n - 1) * (2 * n + 5) - tieCorrection) / 18
  const tau = s / ((n * (n - 1)) / 2)

  let z = 0
  if (varS > 0) {
    if (s > 0) z = (s - 1) / Math.sqrt(varS)
    else if (s < 0) z = (s + 1) / Math.sqrt(varS)
  }

  const significant = Math.abs(z) > TREND_Z_95
  const trend = significant ? (s > 0 ? 'increasing' : 'decreasing') : 'flat'
  return { n, s, tau, z, trend, significant }
}

// A value is a *slow* outlier when its modified z-score exceeds the threshold —
// one-sided on purpose. For run durations only "slower than usual" is
// actionable; a run that finishes unusually fast is good news, not an alert.
function isSlowOutlier(score) {
  return score > OUTLIER_THRESHOLD
}

// Bucket a modified z-score into a severity the UI and alerts can key on. The
// second cut-off (2×) separates "notably slow" from "extreme" so a dashboard can
// draw the eye to the worst offenders.
function severityFor(score) {
  if (score > OUTLIER_THRESHOLD * 2) return 'severe'
  if (score > OUTLIER_THRESHOLD) return 'slow'
  return 'normal'
}

// Descriptive summary of a set of durations (milliseconds). Nulls throughout
// when there's no data so a caller can render "—" rather than a misleading 0.
function summarizeDurations(durations) {
  const values = durations.filter((d) => typeof d === 'number' && Number.isFinite(d))
  if (values.length === 0) {
    return { count: 0, min: null, max: null, mean: null, stdev: null, p50: null, p90: null, p95: null, p99: null }
  }
  return {
    count: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    mean: mean(values),
    stdev: stdev(values),
    p50: percentile(values, 50),
    p90: percentile(values, 90),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
  }
}

// Score a list of runs (each { id, durationMs, ... }) against the distribution
// of the durations present. Runs without a numeric duration (still running,
// never started) get a null score and 'unknown' severity — they don't
// participate in the baseline and can't be judged by it. Returns the runs in
// input order, each augmented with { anomalyScore, severity, isAnomaly }.
function classifyRuns(runs) {
  const timed = runs.filter((r) => typeof r.durationMs === 'number' && Number.isFinite(r.durationMs))
  const scores = modifiedZScores(timed.map((r) => r.durationMs))
  const scoreById = new Map()
  timed.forEach((r, i) => scoreById.set(r, scores[i]))
  return runs.map((r) => {
    if (!scoreById.has(r)) {
      return { ...r, anomalyScore: null, severity: 'unknown', isAnomaly: false }
    }
    const score = scoreById.get(r)
    return {
      ...r,
      anomalyScore: score,
      severity: severityFor(score),
      isAnomaly: isSlowOutlier(score),
    }
  })
}

module.exports = {
  OUTLIER_THRESHOLD,
  percentile,
  mean,
  stdev,
  medianSorted,
  medianAbsoluteDeviation,
  modifiedZScores,
  mannKendall,
  isSlowOutlier,
  severityFor,
  summarizeDurations,
  classifyRuns,
}
