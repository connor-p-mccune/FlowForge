// Change-point detection: when a workflow's behaviour changed, not merely that
// it drifted.
//
// Two properties matter, and the second more than the first. It has to **find a
// step and locate it accurately**, because the location is the whole product —
// an approximate answer sends somebody to audit the wrong deploy. And it has to
// **say nothing about noise**, because this runs over every workflow's history
// rather than over a deliberate experiment, so a false positive costs an
// afternoon and a handful of them cost the feature's credibility.

const cp = require('../services/changePoint')

// A deterministic pseudo-random source, so a test that passes today passes in
// six months. Mulberry32 — small, well-distributed, and reproducible.
function rng(seed) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Right-skewed like real run durations: a base plus an occasional long tail,
// which is precisely the shape that makes a mean-based test cry wolf.
function durations(n, base, seed) {
  const random = rng(seed)
  return Array.from({ length: n }, () => {
    const spike = random() < 0.12 ? base * (1 + random() * 3) : 0
    return Math.round(base + random() * base * 0.2 + spike)
  })
}

const series = (values, start = 0) =>
  values.map((value, i) => ({ at: new Date(start + i * 60_000).toISOString(), value }))

describe('ranking', () => {
  it('shares a rank between tied values', () => {
    expect(cp.averageRanks([5, 1, 5, 3])).toEqual([3.5, 1, 3.5, 2])
  })
})

describe('Pettitt’s test', () => {
  it('declines a series too short to say anything about', () => {
    expect(cp.pettitt([1, 2, 3, 4, 5])).toBeNull()
  })

  it('locates a clean step exactly', () => {
    const values = [...Array(20).fill(100), ...Array(20).fill(500)]
    const result = cp.pettitt(values)
    // Index 19 is the last point before the change.
    expect(result.index).toBe(19)
    expect(result.pValue).toBeLessThan(0.001)
  })

  it('finds a step buried in a heavy tail', () => {
    const values = [...durations(40, 200, 7), ...durations(40, 900, 11)]
    const result = cp.pettitt(values)
    expect(Math.abs(result.index - 39)).toBeLessThanOrEqual(3)
    expect(result.pValue).toBeLessThan(0.01)
  })

  it('reports nothing convincing about a flat noisy series', () => {
    const result = cp.pettitt(durations(120, 300, 3))
    expect(result.pValue).toBeGreaterThan(cp.DEFAULT_ALPHA)
  })

  it('never reports a probability above one', () => {
    // A perfectly flat series makes the statistic zero and the approximation
    // 2·exp(0) = 2, which is not a probability.
    expect(cp.pettitt(Array(30).fill(5)).pValue).toBe(1)
  })
})

describe('segmentation', () => {
  it('finds every change in a series with two of them', () => {
    const values = [
      ...Array(30).fill(100),
      ...Array(30).fill(600),
      ...Array(30).fill(120),
    ]
    const found = cp.segment(values)
    expect(found.map((c) => c.index)).toEqual([29, 59])
  })

  it('reports nothing for a flat series', () => {
    expect(cp.segment(durations(150, 250, 21))).toEqual([])
  })

  it('refuses a split that would leave a segment too short to characterise', () => {
    // The step is real but sits two points from the end: the median after it
    // would be two numbers, which is not a finding.
    const values = [...Array(28).fill(100), 900, 900]
    expect(cp.segment(values)).toEqual([])
  })

  it('caps how many it will report', () => {
    const values = []
    for (let i = 0; i < 12; i++) values.push(...Array(20).fill(i % 2 === 0 ? 100 : 900))
    expect(cp.segment(values).length).toBeLessThanOrEqual(cp.MAX_CHANGE_POINTS)
  })
})

describe('the reported change', () => {
  it('describes the step in the terms somebody would act on', () => {
    const values = [...Array(25).fill(200), ...Array(25).fill(1000)]
    const report = cp.detectChangePoints(series(values, Date.UTC(2026, 0, 1)))

    expect(report.analysed).toBe(true)
    expect(report.changePoints).toHaveLength(1)
    const [change] = report.changePoints
    expect(change.direction).toBe('worse')
    expect(change.before).toEqual({ median: 200, runs: 25 })
    expect(change.after).toEqual({ median: 1000, runs: 25 })
    expect(change.delta).toBe(800)
    expect(change.ratio).toBe(5)
    // The instant reported is the first run that behaved differently, and the
    // one before it — the two ends of the window a deploy has to fall inside.
    expect(change.at).toBe(new Date(Date.UTC(2026, 0, 1) + 25 * 60_000).toISOString())
    expect(change.previousAt).toBe(new Date(Date.UTC(2026, 0, 1) + 24 * 60_000).toISOString())
  })

  it('reports an improvement as an improvement', () => {
    const values = [...Array(25).fill(1000), ...Array(25).fill(200)]
    const [change] = cp.detectChangePoints(series(values)).changePoints
    expect(change.direction).toBe('better')
    expect(change.delta).toBe(-800)
  })

  it('gives each change its own segment rather than the whole series', () => {
    const values = [
      ...Array(20).fill(100),
      ...Array(20).fill(600),
      ...Array(20).fill(1200),
    ]
    const { changePoints } = cp.detectChangePoints(series(values))
    expect(changePoints).toHaveLength(2)
    expect(changePoints[0].before.median).toBe(100)
    expect(changePoints[0].after.median).toBe(600)
    expect(changePoints[1].before.median).toBe(600)
    expect(changePoints[1].after.median).toBe(1200)
  })

  it('says it could not analyse rather than reporting nothing found', () => {
    const short = cp.detectChangePoints(series([1, 2, 3]))
    expect(short.analysed).toBe(false)
    expect(short.reason).toBe('not-enough-runs')
    // "We looked and found nothing" is a different answer, and it is analysed.
    expect(cp.detectChangePoints(series(durations(100, 300, 5))).analysed).toBe(true)
  })

  it('reports no ratio rather than an infinite one', () => {
    const values = [...Array(20).fill(0), ...Array(20).fill(500)]
    const [change] = cp.detectChangePoints(series(values)).changePoints
    expect(change.ratio).toBeNull()
    expect(change.delta).toBe(500)
  })
})
