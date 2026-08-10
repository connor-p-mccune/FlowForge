// Inferential statistics: the tests that decide whether two groups of runs
// actually differ, or merely look like they do.
//
// `runStats.js` describes *one* population — percentiles, a robust outlier
// score, a monotonic trend. This module compares *two*, which is a different
// question and the one a canary release turns on: the new version failed 3 of
// 40 runs and the old one failed 2 of 380. Is that a regression, or is it
// three coin flips?
//
// Hand-rolled, in the same spirit as the metrics registry, the cron engine, and
// the logger: what is needed is three closed-form tests over small integer
// counts, not a statistics package. Each is a few lines of arithmetic with a
// citation, and every one of them returns `null` rather than a number when the
// sample cannot support a conclusion — the single most important property here,
// because a confidently wrong verdict auto-rolls-back a good release or ships a
// bad one.

// The standard normal CDF, via the Abramowitz & Stegun 7.1.26 approximation to
// erf (|ε| < 1.5e-7). Every test below reduces to a z-score, so this is the one
// numerical routine the file needs, and 7 significant figures is far more than a
// p-value threshold of 0.05 can notice.
function normalCdf(z) {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0
  const sign = z < 0 ? -1 : 1
  const x = Math.abs(z) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * x)
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x)
  return 0.5 * (1 + sign * y)
}

// P(Z ≥ z) — the one-sided tail. Canary questions are directional ("is the new
// version *worse*?"), and a two-sided test would need twice the evidence to say
// so while also flagging an improvement as a problem.
const upperTail = (z) => 1 - normalCdf(z)

// Wilson score interval for a proportion. Preferred over the textbook normal
// interval for exactly the case that matters here: small samples and
// proportions near 0 or 1, where the normal interval produces bounds outside
// [0, 1] and a zero-width interval at p = 0 (`0 failures out of 20` is not
// "certainly 0% failure"). Wilson never leaves [0, 1] and never collapses.
//
// z defaults to 1.96 (95%).
function wilsonInterval(successes, total, z = 1.96) {
  if (!Number.isFinite(total) || total <= 0) return null
  const p = successes / total
  const z2 = z * z
  const denominator = 1 + z2 / total
  const centre = p + z2 / (2 * total)
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)
  return {
    point: p,
    lower: Math.max(0, (centre - spread) / denominator),
    upper: Math.min(1, (centre + spread) / denominator),
  }
}

// Two-proportion z-test with a pooled variance estimate: is group A's rate
// higher than group B's by more than sampling noise?
//
//   H0: pA = pB      H1: pA > pB   (one-sided — see upperTail)
//
// Returns null when either group is empty, or when the pooled proportion is 0
// or 1 (every run in both groups succeeded, or every one failed — the standard
// error is zero and the test is undefined, which is a real answer: there is no
// difference to detect).
function twoProportionTest(successesA, totalA, successesB, totalB) {
  if (totalA <= 0 || totalB <= 0) return null
  const pA = successesA / totalA
  const pB = successesB / totalB
  const pooled = (successesA + successesB) / (totalA + totalB)
  if (pooled <= 0 || pooled >= 1) {
    return { rateA: pA, rateB: pB, difference: pA - pB, z: 0, pValue: 1, significant: false }
  }
  const standardError = Math.sqrt(pooled * (1 - pooled) * (1 / totalA + 1 / totalB))
  const z = (pA - pB) / standardError
  const pValue = upperTail(z)
  return {
    rateA: pA,
    rateB: pB,
    difference: pA - pB,
    z,
    pValue,
    significant: pValue < 0.05,
  }
}

// Mann-Whitney U (Wilcoxon rank-sum), normal approximation with a tie
// correction: are the values in `a` stochastically larger than those in `b`?
//
// Deliberately non-parametric, because run durations are not normal — they are
// right-skewed with a long tail of retries and slow dependencies, which is
// exactly the shape that makes a t-test claim significance from one bad
// afternoon. Ranks care only about order, so a single 40-second outlier moves
// the statistic by one rank instead of by forty seconds.
//
// Returns null below the sample size where the normal approximation is
// meaningful (n ≥ 8 per group is the usual rule of thumb); a "probably slower"
// from five runs is not evidence, it is a mood.
const MIN_RANK_SUM_SAMPLE = 8

function mannWhitneyU(a, b) {
  const xs = a.filter(Number.isFinite)
  const ys = b.filter(Number.isFinite)
  const n1 = xs.length
  const n2 = ys.length
  if (n1 < MIN_RANK_SUM_SAMPLE || n2 < MIN_RANK_SUM_SAMPLE) return null

  // Rank the pooled sample, averaging ranks within each tied group.
  const pooled = [
    ...xs.map((v) => ({ v, group: 0 })),
    ...ys.map((v) => ({ v, group: 1 })),
  ].sort((p, q) => p.v - q.v)

  const ranks = new Array(pooled.length)
  const tieGroups = []
  let i = 0
  while (i < pooled.length) {
    let j = i
    while (j + 1 < pooled.length && pooled[j + 1].v === pooled[i].v) j++
    const averageRank = (i + j) / 2 + 1 // ranks are 1-based
    for (let k = i; k <= j; k++) ranks[k] = averageRank
    if (j > i) tieGroups.push(j - i + 1)
    i = j + 1
  }

  let rankSumA = 0
  for (let k = 0; k < pooled.length; k++) if (pooled[k].group === 0) rankSumA += ranks[k]

  const u1 = rankSumA - (n1 * (n1 + 1)) / 2
  const n = n1 + n2
  const meanU = (n1 * n2) / 2
  // Tie-corrected variance: without the correction, heavily tied data (runs
  // rounded to the millisecond) inflates the z-score and manufactures
  // significance.
  const tieTerm = tieGroups.reduce((sum, t) => sum + (t ** 3 - t), 0)
  const variance = ((n1 * n2) / 12) * (n + 1 - tieTerm / (n * (n - 1)))
  if (variance <= 0) {
    return { u: u1, z: 0, pValue: 1, significant: false, effect: 0.5, n1, n2 }
  }

  const z = (u1 - meanU) / Math.sqrt(variance)
  // The common-language effect size: P(a random value from A > a random value
  // from B). 0.5 is "no difference", and unlike a p-value it doesn't grow more
  // impressive just because the sample did.
  const effect = u1 / (n1 * n2)
  return {
    u: u1,
    z,
    pValue: upperTail(z),
    significant: upperTail(z) < 0.05,
    effect,
    n1,
    n2,
  }
}

module.exports = {
  normalCdf,
  upperTail,
  wilsonInterval,
  twoProportionTest,
  mannWhitneyU,
  MIN_RANK_SUM_SAMPLE,
}
