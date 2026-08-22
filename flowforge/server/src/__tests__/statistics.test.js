// Inferential statistics. The arithmetic is the feature, so these pin exact
// numbers against values computed independently — a test that only asserted
// "returns a number" would pass on an implementation that is off by a factor of
// the sample size and useless.
//
// The other half of the file is about *refusal*: every one of these returns
// null rather than a verdict when the sample cannot support one, because a
// confidently wrong answer here auto-rolls-back a good release.

const {
  normalCdf,
  upperTail,
  wilsonInterval,
  twoProportionTest,
  proportionShiftTest,
  mannWhitneyU,
  kolmogorovSmirnov,
  populationStabilityIndex,
} = require('../services/statistics')

describe('normalCdf', () => {
  it('matches the standard normal table', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6)
    expect(normalCdf(1)).toBeCloseTo(0.841345, 5)
    expect(normalCdf(1.96)).toBeCloseTo(0.975002, 5)
    expect(normalCdf(2.5758)).toBeCloseTo(0.995, 4)
    expect(normalCdf(-1.645)).toBeCloseTo(0.05, 4)
  })

  it('is symmetric about zero', () => {
    for (const z of [0.3, 1.1, 2.4, 3.7]) {
      expect(normalCdf(z) + normalCdf(-z)).toBeCloseTo(1, 6)
    }
  })

  it('saturates rather than drifting at the extremes', () => {
    expect(normalCdf(40)).toBeCloseTo(1, 10)
    expect(normalCdf(-40)).toBeCloseTo(0, 10)
    expect(normalCdf(Infinity)).toBe(1)
  })

  it('upperTail is the one-sided complement', () => {
    expect(upperTail(1.645)).toBeCloseTo(0.05, 4)
  })
})

describe('wilsonInterval', () => {
  it('brackets the observed proportion', () => {
    const ci = wilsonInterval(30, 100)
    expect(ci.point).toBeCloseTo(0.3, 10)
    expect(ci.lower).toBeLessThan(0.3)
    expect(ci.upper).toBeGreaterThan(0.3)
    // Independently computed: 95% Wilson for 30/100 is [0.2189, 0.3959].
    expect(ci.lower).toBeCloseTo(0.2189, 3)
    expect(ci.upper).toBeCloseTo(0.3959, 3)
  })

  it('never collapses at the boundary — the reason it is used here', () => {
    // The normal interval would say 0 failures in 20 runs means "certainly 0%",
    // which is exactly the claim a small canary must not be allowed to make.
    const ci = wilsonInterval(0, 20)
    expect(ci.point).toBe(0)
    expect(ci.lower).toBe(0)
    expect(ci.upper).toBeGreaterThan(0.1)
  })

  it('never leaves [0, 1]', () => {
    for (const [s, n] of [[0, 1], [1, 1], [1, 3], [19, 20]]) {
      const ci = wilsonInterval(s, n)
      expect(ci.lower).toBeGreaterThanOrEqual(0)
      expect(ci.upper).toBeLessThanOrEqual(1)
    }
  })

  it('narrows as the sample grows', () => {
    const small = wilsonInterval(5, 10)
    const large = wilsonInterval(500, 1000)
    expect(large.upper - large.lower).toBeLessThan(small.upper - small.lower)
  })

  it('returns null for an empty sample', () => {
    expect(wilsonInterval(0, 0)).toBeNull()
  })
})

describe('twoProportionTest', () => {
  it('finds no difference between identical rates', () => {
    const result = twoProportionTest(10, 100, 10, 100)
    expect(result.z).toBeCloseTo(0, 10)
    expect(result.pValue).toBeCloseTo(0.5, 6)
    expect(result.significant).toBe(false)
  })

  it('computes the textbook z for a known pair', () => {
    // 30/100 vs 20/100: pooled = 0.25, SE = sqrt(0.25·0.75·0.02) ≈ 0.061237,
    // z = 0.10 / 0.061237 ≈ 1.633.
    const result = twoProportionTest(30, 100, 20, 100)
    expect(result.z).toBeCloseTo(1.633, 3)
    expect(result.difference).toBeCloseTo(0.1, 10)
    expect(result.significant).toBe(false) // 1.633 < 1.645 — just short
  })

  it('is one-sided: a lower rate in A is never "significant"', () => {
    const result = twoProportionTest(2, 100, 40, 100)
    expect(result.z).toBeLessThan(0)
    expect(result.pValue).toBeGreaterThan(0.9)
    expect(result.significant).toBe(false)
  })

  it('detects a real regression on a decent sample', () => {
    const result = twoProportionTest(20, 100, 5, 200)
    expect(result.significant).toBe(true)
    expect(result.pValue).toBeLessThan(0.001)
  })

  it('refuses to call a small unlucky streak a regression', () => {
    // The canary case that matters: 7.5% vs 5.3% *looks* worse on a 40-run
    // canary, and it is three coin flips. z ≈ 0.59.
    const result = twoProportionTest(3, 40, 20, 380)
    expect(result.rateA).toBeGreaterThan(result.rateB)
    expect(result.z).toBeCloseTo(0.591, 2)
    expect(result.significant).toBe(false)
  })

  it('reports no difference when nothing failed anywhere', () => {
    // Pooled proportion 0 makes the standard error zero and the test
    // undefined — which is itself the answer.
    const result = twoProportionTest(0, 50, 0, 50)
    expect(result).toMatchObject({ z: 0, pValue: 1, significant: false })
  })

  it('returns null when a group is empty', () => {
    expect(twoProportionTest(0, 0, 1, 10)).toBeNull()
    expect(twoProportionTest(1, 10, 0, 0)).toBeNull()
  })
})

describe('mannWhitneyU', () => {
  const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

  it('finds no difference between identical samples', () => {
    const sample = range(1, 20)
    const result = mannWhitneyU(sample, [...sample])
    expect(result.effect).toBeCloseTo(0.5, 6)
    expect(result.significant).toBe(false)
  })

  it('detects a shifted distribution', () => {
    const slow = range(1, 20).map((v) => v + 40)
    const fast = range(1, 20)
    const result = mannWhitneyU(slow, fast)
    expect(result.effect).toBe(1) // every slow value exceeds every fast one
    expect(result.significant).toBe(true)
  })

  it('is one-sided: a faster group is never flagged', () => {
    const result = mannWhitneyU(range(1, 20), range(41, 60))
    expect(result.effect).toBe(0)
    expect(result.significant).toBe(false)
  })

  it('is not fooled by a single extreme outlier, unlike a mean comparison', () => {
    const withOutlier = [...range(1, 19), 100000]
    const plain = range(1, 20)
    // The means differ by thousands; the ranks barely move.
    expect(mannWhitneyU(withOutlier, plain).significant).toBe(false)
  })

  it('corrects for ties instead of manufacturing significance from them', () => {
    // Durations rounded to the millisecond tie constantly. Without the
    // correction the variance is understated and the z-score inflates.
    const a = new Array(20).fill(5)
    const b = new Array(20).fill(5)
    const result = mannWhitneyU(a, b)
    expect(result.z).toBeCloseTo(0, 10)
    expect(result.significant).toBe(false)
  })

  it('refuses a sample too small for the normal approximation', () => {
    expect(mannWhitneyU([1, 2, 3], [4, 5, 6])).toBeNull()
    expect(mannWhitneyU(range(1, 8), range(1, 7))).toBeNull()
    expect(mannWhitneyU(range(1, 8), range(1, 8))).not.toBeNull()
  })

  it('ignores non-finite values rather than poisoning the ranking', () => {
    const withNulls = [...range(1, 20), null, undefined, NaN]
    expect(mannWhitneyU(withNulls, range(1, 20)).n1).toBe(20)
  })
})

// ---------------------------------------------------------------------------
// The drift monitor's half of the file: has this field's distribution moved?
// ---------------------------------------------------------------------------

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

describe('proportionShiftTest', () => {
  it('detects a shift in either direction, unlike the one-sided test', () => {
    // A null rate that fell from 40% to 2% has changed as much as one that rose.
    const fell = proportionShiftTest(2, 100, 40, 100)
    expect(fell.significant).toBe(true)
    expect(fell.difference).toBeLessThan(0)
    // The one-sided test asks only "is A higher than B", so it sees nothing.
    expect(twoProportionTest(2, 100, 40, 100).significant).toBe(false)
  })

  it('is symmetric in its verdict', () => {
    const up = proportionShiftTest(40, 100, 2, 100)
    const down = proportionShiftTest(2, 100, 40, 100)
    expect(up.pValue).toBeCloseTo(down.pValue, 12)
    expect(up.z).toBeCloseTo(-down.z, 12)
  })

  it('reports exactly twice the one-sided tail', () => {
    const one = twoProportionTest(60, 100, 40, 100)
    const two = proportionShiftTest(60, 100, 40, 100)
    expect(two.pValue).toBeCloseTo(2 * one.pValue, 12)
  })

  it('finds nothing in a difference the sample cannot support', () => {
    expect(proportionShiftTest(3, 10, 2, 10).significant).toBe(false)
  })

  it('returns null for an empty group and a flat verdict for a degenerate one', () => {
    expect(proportionShiftTest(1, 0, 1, 10)).toBeNull()
    // Nothing failed in either group: no difference exists to detect.
    expect(proportionShiftTest(0, 50, 0, 50).significant).toBe(false)
  })
})

// A deterministic pseudo-sample, so a KS assertion is reproducible rather than
// a story about a build that went red once.
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const sample = (n, seed, f) => {
  const r = rng(seed)
  return Array.from({ length: n }, () => f(r()))
}

describe('kolmogorovSmirnov', () => {
  it('is zero for two identical samples', () => {
    const xs = range(1, 40)
    const result = kolmogorovSmirnov(xs, xs)
    expect(result.d).toBe(0)
    expect(result.pValue).toBe(1)
    expect(result.significant).toBe(false)
  })

  it('is 1 for two samples that do not overlap at all', () => {
    const result = kolmogorovSmirnov(range(1, 40), range(101, 140))
    expect(result.d).toBe(1)
    expect(result.significant).toBe(true)
  })

  it('computes D as the largest gap between the two empirical CDFs', () => {
    // Half of b sits below all of a: the CDFs separate by exactly 0.5.
    const a = range(11, 30) // 20 values, 11..30
    const b = [...range(1, 10), ...range(11, 20)] // 20 values, half below a
    expect(kolmogorovSmirnov(a, b).d).toBeCloseTo(0.5, 10)
  })

  it('finds a shift in shape that leaves the centre alone', () => {
    // Same median, one sample bimodal. A test on means would report nothing.
    const centred = sample(300, 11, () => 50)
    const bimodal = sample(300, 12, (u) => (u < 0.5 ? 0 : 100))
    const result = kolmogorovSmirnov(centred, bimodal)
    expect(result.significant).toBe(true)
    expect(result.d).toBeGreaterThan(0.4)
  })

  it('does not cry wolf on two samples from the same distribution', () => {
    const a = sample(400, 21, (u) => Math.round(u * 1000))
    const b = sample(400, 22, (u) => Math.round(u * 1000))
    expect(kolmogorovSmirnov(a, b).significant).toBe(false)
  })

  it('handles heavily tied data without inventing a step', () => {
    const a = new Array(50).fill(7)
    const b = new Array(50).fill(7)
    const result = kolmogorovSmirnov(a, b)
    expect(result.d).toBe(0)
    expect(result.significant).toBe(false)
  })

  it('refuses a sample too small to judge', () => {
    expect(kolmogorovSmirnov(range(1, 19), range(1, 40))).toBeNull()
    expect(kolmogorovSmirnov(range(1, 40), range(1, 19))).toBeNull()
    expect(kolmogorovSmirnov(range(1, 20), range(1, 20))).not.toBeNull()
  })

  it('ignores non-finite values rather than poisoning the CDF', () => {
    const dirty = [...range(1, 25), null, NaN, undefined]
    expect(kolmogorovSmirnov(dirty, range(1, 25)).n1).toBe(25)
  })
})

describe('populationStabilityIndex', () => {
  it('is zero for an unchanged distribution', () => {
    const counts = { a: 50, b: 30, c: 20 }
    const result = populationStabilityIndex(counts, counts)
    expect(result.psi).toBeCloseTo(0, 12)
    expect(result.severity).toBe('none')
  })

  it('is unchanged by sample size — it is an effect size, not a test', () => {
    const small = populationStabilityIndex({ a: 50, b: 50 }, { a: 30, b: 70 })
    const large = populationStabilityIndex({ a: 50000, b: 50000 }, { a: 30000, b: 70000 })
    expect(large.psi).toBeCloseTo(small.psi, 6)
  })

  it('matches the closed form on a known shift', () => {
    // (0.3 − 0.5)·ln(0.3/0.5) + (0.7 − 0.5)·ln(0.7/0.5)
    //   = (−0.2)(−0.510826) + (0.2)(0.336472) = 0.169460
    const result = populationStabilityIndex({ a: 50, b: 50 }, { a: 30, b: 70 })
    expect(result.psi).toBeCloseTo(0.16946, 4)
    expect(result.severity).toBe('minor')
  })

  it('calls a large shift major', () => {
    expect(populationStabilityIndex({ a: 90, b: 10 }, { a: 20, b: 80 }).severity).toBe('major')
  })

  it('floors an absent category instead of returning infinity', () => {
    const result = populationStabilityIndex({ a: 100 }, { a: 50, b: 50 })
    expect(Number.isFinite(result.psi)).toBe(true)
    expect(result.severity).toBe('major')
  })

  it('names the categories that moved most', () => {
    const result = populationStabilityIndex(
      { ok: 900, retry: 90, error: 10 },
      { ok: 500, retry: 100, error: 400 }
    )
    expect(result.contributions[0].key).toBe('error')
  })

  it('returns null when either side is empty', () => {
    expect(populationStabilityIndex({}, {})).toBeNull()
    expect(populationStabilityIndex({ a: 0 }, { a: 5 })).toBeNull()
  })
})
