// Change-point detection — *when* a workflow's behaviour changed, and by how
// much.
//
// `runStats.mannKendall` already answers "is this drifting?", and the answer is
// almost never actionable. A workflow that ran in 200ms for a month and has run
// in 900ms since Tuesday is reported as *degrading*, which is true, and leaves
// whoever reads it with the whole month to search. The question they actually
// have is:
//
//     when did it change, and what else changed then?
//
// The first half is this module. The second is `services/regressions.js`, which
// lines the answer up against the workflow's deploy history — because a step in
// duration next to a version snapshot is a suspect, and a step with no deploy
// anywhere near it is a different (and equally useful) finding: the cause is
// outside this workflow.
//
// ## Pettitt's test, and why this family
//
// Run durations are right-skewed with a long retry tail — the reason the canary
// comparison uses Mann-Whitney U rather than a mean, and the reason the anomaly
// score uses a median-and-MAD z-score rather than the classical one. A
// change-point test built on means and variances would be dragged around by
// exactly the tail this data always has.
//
// Pettitt (1979) is the rank-based answer, and it is not a new tool so much as
// one already in the file pointed sideways: it is the **Mann-Whitney statistic
// evaluated at every possible split point**, with the largest one taken as the
// candidate change. Same assumptions (none about the distribution), same
// family as the Mann-Kendall trend test already here, and it reports a
// *location* rather than only a direction.
//
//     U(t) = Σ_{i≤t} Σ_{j>t} sgn(x_i − x_j)
//     K    = max_t |U(t)|            the candidate change point
//     p    ≈ 2 exp( −6K² / (n³ + n²) )
//
// The double sum is O(n²) written literally, and unnecessary: U(t) is exactly
// `2·Σ_{i≤t} r_i − t(n+1)` over the ranks, so one sort and one prefix sum give
// every split point at once. Average ranks handle ties, which run durations
// rounded to the millisecond produce constantly.
//
// ## Several changes
//
// One test finds one change. **Binary segmentation** finds the rest: accept the
// strongest change, then re-run the test on each side of it. That is the
// classical multiple-change-point procedure, it needs no new statistic, and it
// terminates on its own — a segment too short to split is a segment the test
// declines to report.
//
// Every function here returns `null` rather than a number when the sample
// cannot support a conclusion, which is the rule the rest of the statistics in
// this codebase follow. A confidently wrong change point sends somebody to
// audit a deploy that changed nothing.

// Below this many points a rank test says nothing worth hearing. Ten is already
// generous for a statistic whose p-value approximation assumes an asymptotic
// distribution.
const MIN_SERIES = 10

// A change reported one point from the end is not a change, it is the last run.
// Each side of a split must hold at least this many points for the segment
// medians either side of it to mean anything.
const MIN_SEGMENT = 5

// The significance level. Deliberately stricter than the 0.05 used for the
// canary tests: this one runs over every workflow's history rather than over a
// deliberate experiment, so the multiple-comparisons pressure is much higher
// and a false positive costs somebody an afternoon.
const DEFAULT_ALPHA = 0.01

// How many change points one series may report. A workflow with fifteen genuine
// regime changes has a different problem, and a list of fifteen is not read.
const MAX_CHANGE_POINTS = 5

// Average ranks, so tied values share a rank rather than being ordered by their
// position in the array. Without this, a run of identical durations — which is
// what a fast workflow rounded to the millisecond looks like — would contribute
// a spurious ordering to every split point that fell inside it.
function averageRanks(values) {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v)
  const ranks = new Array(values.length)
  let i = 0
  while (i < order.length) {
    let j = i
    while (j + 1 < order.length && order[j + 1].v === order[i].v) j++
    const rank = (i + j) / 2 + 1 // ranks are 1-based
    for (let k = i; k <= j; k++) ranks[order[k].i] = rank
    i = j + 1
  }
  return ranks
}

// Pettitt's test over one series. Returns the split index (the last position
// *before* the change), the statistic, and its p-value — or null when the
// series is too short to test.
function pettitt(values) {
  const n = values.length
  if (n < MIN_SERIES) return null

  const ranks = averageRanks(values)
  // U(t) = 2·Σ_{i≤t} r_i − t(n+1), which is the double sum without the second
  // loop. Scanning t from 0 to n−2 keeps at least one point on the right.
  let prefix = 0
  let best = { index: null, u: 0, absU: -1 }
  for (let t = 0; t < n - 1; t++) {
    prefix += ranks[t]
    const u = 2 * prefix - (t + 1) * (n + 1)
    const absU = Math.abs(u)
    if (absU > best.absU) best = { index: t, u, absU }
  }
  if (best.index === null) return null

  // Pettitt's asymptotic approximation. Valid where it matters — it is
  // conservative for large p and the interesting region is small p — and
  // clamped because an approximation is allowed to be approximate, not
  // allowed to report a probability above one.
  const k = best.absU
  const pValue = Math.min(1, 2 * Math.exp((-6 * k * k) / (n ** 3 + n ** 2)))
  return { index: best.index, k, u: best.u, pValue, n }
}

const median = (values) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// Binary segmentation: accept the strongest change, then look for more on
// either side of it. Recursion depth is bounded by MIN_SEGMENT rather than by a
// counter — a segment that cannot be split into two usable halves is not tested
// — and the result is capped so a pathological series cannot produce a list
// nobody would read.
function segment(values, { alpha = DEFAULT_ALPHA, minSegment = MIN_SEGMENT, offset = 0 } = {}) {
  if (values.length < Math.max(MIN_SERIES, minSegment * 2)) return []
  const result = pettitt(values)
  if (!result || result.pValue > alpha) return []

  // A split that leaves either side too short to characterise is not reported,
  // even when the statistic likes it: the medians on either side are the
  // finding, and a median of two points is not one.
  const leftLength = result.index + 1
  const rightLength = values.length - leftLength
  if (leftLength < minSegment || rightLength < minSegment) return []

  const left = segment(values.slice(0, leftLength), { alpha, minSegment, offset })
  const right = segment(values.slice(leftLength), {
    alpha,
    minSegment,
    offset: offset + leftLength,
  })
  return [...left, { index: offset + result.index, pValue: result.pValue, k: result.k }, ...right]
    .sort((a, b) => a.index - b.index)
    .slice(0, MAX_CHANGE_POINTS)
}

// The user-facing shape: every change point with the segments either side of
// it, so the finding is "it went from 210ms to 940ms on the 12th" rather than a
// statistic and an array index.
//
// `series` is [{ at, value }] in chronological order. `at` is carried through
// untouched — it is whatever the caller keys on, and this module has no opinion
// about time.
function detectChangePoints(series, options = {}) {
  const points = series.map((p) => p.value).filter(Number.isFinite)
  if (points.length !== series.length || points.length < MIN_SERIES) {
    return { analysed: false, reason: 'not-enough-runs', changePoints: [] }
  }

  const found = segment(points, options)
  // Segment boundaries, so each change point can report the run of data either
  // side of it rather than the whole series.
  const bounds = [0, ...found.map((c) => c.index + 1), points.length]

  const changePoints = found.map((change, i) => {
    const before = points.slice(bounds[i], bounds[i + 1])
    const after = points.slice(bounds[i + 1], bounds[i + 2])
    const beforeMedian = median(before)
    const afterMedian = median(after)
    return {
      // The first run *after* the change: the one whose behaviour is new, which
      // is the instant a deploy has to precede to be a suspect.
      at: series[change.index + 1].at,
      // And the last one before it, so the attribution window has two ends.
      previousAt: series[change.index].at,
      index: change.index,
      pValue: change.pValue,
      direction: afterMedian > beforeMedian ? 'worse' : 'better',
      before: { median: beforeMedian, runs: before.length },
      after: { median: afterMedian, runs: after.length },
      delta: afterMedian - beforeMedian,
      // Null rather than Infinity when the earlier median is zero: a ratio
      // against nothing is not a number anybody can act on.
      ratio: beforeMedian > 0 ? afterMedian / beforeMedian : null,
    }
  })

  return { analysed: true, reason: null, runs: points.length, changePoints }
}

module.exports = {
  MIN_SERIES,
  MIN_SEGMENT,
  DEFAULT_ALPHA,
  MAX_CHANGE_POINTS,
  averageRanks,
  pettitt,
  segment,
  detectChangePoints,
  median,
}
