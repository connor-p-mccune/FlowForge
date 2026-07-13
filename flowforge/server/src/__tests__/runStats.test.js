const {
  OUTLIER_THRESHOLD,
  percentile,
  mean,
  stdev,
  medianSorted,
  medianAbsoluteDeviation,
  modifiedZScores,
  isSlowOutlier,
  severityFor,
  summarizeDurations,
  classifyRuns,
} = require('../services/runStats')

describe('percentile (R-7 linear interpolation)', () => {
  it('interpolates between order statistics', () => {
    const v = [1, 2, 3, 4, 5]
    expect(percentile(v, 50)).toBe(3)
    expect(percentile(v, 90)).toBeCloseTo(4.6, 10)
    expect(percentile(v, 95)).toBeCloseTo(4.8, 10)
    expect(percentile(v, 0)).toBe(1)
    expect(percentile(v, 100)).toBe(5)
  })

  it('interpolates on an even-length sample', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBeCloseTo(2.5, 10)
  })

  it('does not mutate the caller array', () => {
    const v = [5, 3, 1, 4, 2]
    percentile(v, 50)
    expect(v).toEqual([5, 3, 1, 4, 2])
  })

  it('handles empty and single-element inputs', () => {
    expect(percentile([], 50)).toBeNull()
    expect(percentile([42], 95)).toBe(42)
  })

  it('clamps out-of-range percentiles', () => {
    expect(percentile([1, 2, 3], -10)).toBe(1)
    expect(percentile([1, 2, 3], 250)).toBe(3)
  })
})

describe('mean / stdev / median', () => {
  it('computes the arithmetic mean', () => {
    expect(mean([2, 4, 6])).toBe(4)
    expect(mean([])).toBeNull()
  })

  it('computes the sample (n-1) standard deviation', () => {
    // [2,4,6]: mean 4, squared deviations 4+0+4=8, /(n-1)=4 → stdev 2
    expect(stdev([2, 4, 6])).toBeCloseTo(2, 10)
    expect(stdev([7])).toBe(0)
    expect(stdev([])).toBeNull()
  })

  it('takes the median of odd and even sorted arrays', () => {
    expect(medianSorted([1, 2, 3])).toBe(2)
    expect(medianSorted([1, 2, 3, 4])).toBe(2.5)
    expect(medianSorted([])).toBeNull()
  })
})

describe('medianAbsoluteDeviation', () => {
  it('measures spread about the median, unmoved by an extreme value', () => {
    // median 3.5; deviations sorted [0.5,0.5,1.5,1.5,2.5,96.5] → MAD 1.5
    expect(medianAbsoluteDeviation([1, 2, 3, 4, 5, 100])).toBeCloseTo(1.5, 10)
  })

  it('is zero for a constant sample', () => {
    expect(medianAbsoluteDeviation([5, 5, 5, 5])).toBe(0)
  })
})

describe('modifiedZScores (Iglewicz & Hoaglin)', () => {
  it('flags a lone extreme value well past the 3.5 threshold', () => {
    const scores = modifiedZScores([1, 2, 3, 4, 5, 100])
    // 0.6745 * (100 - 3.5) / 1.5 = 43.39283…
    expect(scores[5]).toBeCloseTo(43.3928, 3)
    expect(isSlowOutlier(scores[5])).toBe(true)
    // The body of the distribution stays well within the threshold.
    scores.slice(0, 5).forEach((s) => expect(Math.abs(s)).toBeLessThan(OUTLIER_THRESHOLD))
  })

  it('falls back to the mean-absolute-deviation form when MAD is zero', () => {
    // [5,5,5,5,5,20]: median 5, MAD 0, meanAD 2.5 → (20-5)/(1.253314*2.5) ≈ 4.787
    const scores = modifiedZScores([5, 5, 5, 5, 5, 20])
    expect(scores[5]).toBeCloseTo(4.7873, 3)
    expect(isSlowOutlier(scores[5])).toBe(true)
    scores.slice(0, 5).forEach((s) => expect(s).toBe(0))
  })

  it('returns all zeros for a constant sample (no dispersion)', () => {
    expect(modifiedZScores([7, 7, 7, 7])).toEqual([0, 0, 0, 0])
  })

  it('returns all zeros when there is too little history to judge', () => {
    expect(modifiedZScores([10, 500])).toEqual([0, 0])
    expect(modifiedZScores([])).toEqual([])
  })

  it('preserves input order', () => {
    const scores = modifiedZScores([100, 1, 2, 3, 4, 5])
    expect(isSlowOutlier(scores[0])).toBe(true)
    expect(scores.slice(1).every((s) => !isSlowOutlier(s))).toBe(true)
  })
})

describe('severityFor', () => {
  it('buckets scores into normal / slow / severe', () => {
    expect(severityFor(1)).toBe('normal')
    expect(severityFor(4)).toBe('slow')
    expect(severityFor(10)).toBe('severe')
  })

  it('treats a fast run (negative score) as normal', () => {
    expect(severityFor(-9)).toBe('normal')
  })
})

describe('summarizeDurations', () => {
  it('summarizes a duration set', () => {
    const s = summarizeDurations([100, 200, 300, 400, 500])
    expect(s.count).toBe(5)
    expect(s.min).toBe(100)
    expect(s.max).toBe(500)
    expect(s.mean).toBe(300)
    expect(s.p50).toBe(300)
    expect(s.p95).toBeCloseTo(480, 10)
  })

  it('ignores non-numeric entries', () => {
    const s = summarizeDurations([100, null, undefined, NaN, 300])
    expect(s.count).toBe(2)
    expect(s.mean).toBe(200)
  })

  it('returns nulls (not zeros) for an empty set', () => {
    const s = summarizeDurations([])
    expect(s).toEqual({
      count: 0, min: null, max: null, mean: null, stdev: null,
      p50: null, p90: null, p95: null, p99: null,
    })
  })
})

describe('classifyRuns', () => {
  it('tags each run with its anomaly score and severity, preserving order', () => {
    const runs = [
      { id: 'a', durationMs: 100 },
      { id: 'b', durationMs: 110 },
      { id: 'c', durationMs: 105 },
      { id: 'd', durationMs: 95 },
      { id: 'e', durationMs: 102 },
      { id: 'f', durationMs: 5000 }, // the slow one
    ]
    const out = classifyRuns(runs)
    expect(out.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(out[5].isAnomaly).toBe(true)
    expect(out[5].severity).toBe('severe')
    out.slice(0, 5).forEach((r) => expect(r.isAnomaly).toBe(false))
  })

  it('marks runs without a duration as unknown and excludes them from the baseline', () => {
    const runs = [
      { id: 'a', durationMs: 100 },
      { id: 'b', durationMs: 110 },
      { id: 'c', durationMs: 105 },
      { id: 'running', durationMs: null },
      { id: 'd', durationMs: 5000 },
    ]
    const out = classifyRuns(runs)
    const running = out.find((r) => r.id === 'running')
    expect(running.severity).toBe('unknown')
    expect(running.anomalyScore).toBeNull()
    // The 5000ms run is still an outlier relative to the three timed baseline runs.
    expect(out.find((r) => r.id === 'd').isAnomaly).toBe(true)
  })

  it('does not mutate the input run objects', () => {
    const runs = [{ id: 'a', durationMs: 100 }]
    classifyRuns(runs)
    expect(runs[0]).toEqual({ id: 'a', durationMs: 100 })
  })
})
