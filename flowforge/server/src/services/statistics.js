// Inferential statistics: the tests that decide whether two groups of runs
// actually differ, or merely look like they do.
//
// `runStats.js` describes *one* population — percentiles, a robust outlier
// score, a monotonic trend. This module compares *two*, which is a different
// question and the one a canary release turns on: the new version failed 3 of
// 40 runs and the old one failed 2 of 380. Is that a regression, or is it
// three coin flips?
//
// The same shape serves a second question the drift monitor asks: the new
// window's values for this field look different from last month's — is that a
// distribution that moved, or is it thirty samples?
//
// Hand-rolled, in the same spirit as the metrics registry, the cron engine, and
// the logger: what is needed is a handful of closed-form tests over small
// samples, not a statistics package. Each is a few lines of arithmetic with a
// citation, and every one of them returns `null` rather than a number when the
// sample cannot support a conclusion — the single most important property here,
// because a confidently wrong verdict auto-rolls-back a good release, ships a
// bad one, or teaches somebody to ignore a drift alert.
//
// Every test is also non-parametric. Nothing here assumes a distribution,
// because nothing here knows one: run durations are right-skewed, and the values
// a workflow's nodes emit could be anything at all.

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

// Two-sided version of the pooled two-proportion z-test above. The canary asks a
// directional question ("is the new version *worse*?"); a drift check does not —
// a field whose null rate fell from 40% to 2% has changed just as much as one
// that went the other way, and quite possibly for the same reason.
function proportionShiftTest(successesA, totalA, successesB, totalB) {
  if (totalA <= 0 || totalB <= 0) return null
  const pA = successesA / totalA
  const pB = successesB / totalB
  const pooled = (successesA + successesB) / (totalA + totalB)
  if (pooled <= 0 || pooled >= 1) {
    return { rateA: pA, rateB: pB, difference: pA - pB, z: 0, pValue: 1, significant: false }
  }
  const standardError = Math.sqrt(pooled * (1 - pooled) * (1 / totalA + 1 / totalB))
  const z = (pA - pB) / standardError
  const pValue = 2 * upperTail(Math.abs(z))
  return { rateA: pA, rateB: pB, difference: pA - pB, z, pValue, significant: pValue < 0.05 }
}

// Two-sample Kolmogorov-Smirnov: do these two samples come from the same
// distribution?
//
// The statistic is the largest vertical gap between the two empirical CDFs,
//
//   D = max over x of |F_a(x) − F_b(x)|
//
// which makes it the right tool for the question a drift check actually asks.
// It is **distribution-free** — no assumption of normality, which matters here
// for the same reason it does everywhere else in this file: the values a
// workflow's nodes emit (durations, amounts, counts) are not normal and nobody
// knows what they are. It is also sensitive to a change in *shape*, not only in
// centre: a field whose mean is unchanged but which has become bimodal is a real
// event, and a t-test would report nothing.
//
// The p-value uses the asymptotic Kolmogorov distribution
//
//   Q(λ) = 2 Σ_{k≥1} (−1)^(k−1) e^(−2k²λ²),   λ = (√nₑ + 0.12 + 0.11/√nₑ) · D
//
// with the effective sample size nₑ = n₁n₂/(n₁+n₂) and the small-sample
// correction from Numerical Recipes §14.3. The series converges geometrically,
// so it is summed until the terms stop mattering.
//
// Returns null below MIN_KS_SAMPLE in either group. That floor is the whole
// safety property: a "distribution changed" alert from eleven values is noise
// wearing a p-value, and the second time somebody sees one they stop reading the
// alerts.
const MIN_KS_SAMPLE = 20

function kolmogorovQ(lambda) {
  if (!(lambda > 0)) return 1
  let sum = 0
  let previousTerm = 0
  for (let k = 1; k <= 200; k++) {
    const term = 2 * (k % 2 === 1 ? 1 : -1) * Math.exp(-2 * k * k * lambda * lambda)
    sum += term
    // Converged: this term and the last are both negligible against the total.
    if (Math.abs(term) <= 1e-10 * Math.abs(sum) || Math.abs(term) <= 1e-12 * previousTerm) break
    previousTerm = Math.abs(term)
  }
  return Math.min(1, Math.max(0, sum))
}

function kolmogorovSmirnov(a, b) {
  const xs = a.filter(Number.isFinite).sort((p, q) => p - q)
  const ys = b.filter(Number.isFinite).sort((p, q) => p - q)
  const n1 = xs.length
  const n2 = ys.length
  if (n1 < MIN_KS_SAMPLE || n2 < MIN_KS_SAMPLE) return null

  // Walk both sorted samples together, advancing whichever is behind, and take
  // the largest gap between the two running fractions. Ties advance both, which
  // is what keeps a heavily-tied sample (integers, rounded amounts) from
  // reporting a step that isn't there.
  let i = 0
  let j = 0
  let d = 0
  while (i < n1 && j < n2) {
    const x = xs[i]
    const y = ys[j]
    if (x <= y) {
      while (i < n1 && xs[i] === x) i++
    }
    if (y <= x) {
      while (j < n2 && ys[j] === y) j++
    }
    d = Math.max(d, Math.abs(i / n1 - j / n2))
  }

  const ne = (n1 * n2) / (n1 + n2)
  const root = Math.sqrt(ne)
  const lambda = (root + 0.12 + 0.11 / root) * d
  const pValue = kolmogorovQ(lambda)
  return { d, pValue, significant: pValue < 0.05, n1, n2 }
}

// Population Stability Index: how far a categorical distribution has moved.
//
//   PSI = Σ_i (aᵢ − eᵢ) · ln(aᵢ / eᵢ)
//
// over the *proportions* in each bin. It is the symmetrised Kullback-Leibler
// divergence, and it is used here rather than a chi-square goodness-of-fit test
// for one reason: it does not grow with the sample. A χ² over ten thousand
// records will call a 0.3% shift significant, which is true and useless. PSI is
// an effect size with conventional cut-offs that have meant the same thing in
// model monitoring for twenty years — under 0.1 nothing has happened, 0.1 to
// 0.25 is worth a look, over 0.25 is a real shift.
//
// A category present in one window and absent from the other makes the log
// infinite, so empty bins are floored. The floor is derived from the sample
// (1/(4n), the standard continuity-style correction) rather than a fixed
// epsilon: a fixed one would make the same absent category score differently
// depending on how many records happened to be in the window.
const PSI_MINOR = 0.1
const PSI_MAJOR = 0.25

function populationStabilityIndex(expectedCounts, actualCounts) {
  const keys = new Set([...Object.keys(expectedCounts || {}), ...Object.keys(actualCounts || {})])
  if (keys.size === 0) return null
  const total = (counts) => Object.values(counts || {}).reduce((sum, n) => sum + (n || 0), 0)
  const eTotal = total(expectedCounts)
  const aTotal = total(actualCounts)
  if (eTotal <= 0 || aTotal <= 0) return null

  const eFloor = 1 / (4 * eTotal)
  const aFloor = 1 / (4 * aTotal)
  let psi = 0
  const contributions = []
  for (const key of keys) {
    const e = Math.max((expectedCounts?.[key] || 0) / eTotal, eFloor)
    const a = Math.max((actualCounts?.[key] || 0) / aTotal, aFloor)
    const contribution = (a - e) * Math.log(a / e)
    psi += contribution
    contributions.push({ key, expected: e, actual: a, contribution })
  }
  contributions.sort((p, q) => q.contribution - p.contribution)
  return {
    psi,
    // 'none' is a verdict, not the absence of one — it is what most comparisons
    // should return, and a caller that treated it as "no result" would report
    // every stable field as unknown.
    severity: psi >= PSI_MAJOR ? 'major' : psi >= PSI_MINOR ? 'minor' : 'none',
    contributions: contributions.slice(0, 5),
  }
}

module.exports = {
  normalCdf,
  upperTail,
  wilsonInterval,
  twoProportionTest,
  proportionShiftTest,
  mannWhitneyU,
  kolmogorovSmirnov,
  populationStabilityIndex,
  MIN_RANK_SUM_SAMPLE,
  MIN_KS_SAMPLE,
  PSI_MINOR,
  PSI_MAJOR,
}
