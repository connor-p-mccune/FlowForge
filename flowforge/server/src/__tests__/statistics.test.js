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
  mannWhitneyU,
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
