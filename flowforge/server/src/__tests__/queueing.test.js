// The queueing maths behind the concurrency cap.
//
// Checked against closed forms and published Erlang tables rather than against
// itself, because a model that only agrees with its own implementation is a
// model nobody should size a production cap on.

const {
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
} = require('../services/queueing')

const close = (actual, expected, tolerance = 1e-4) =>
  expect(Math.abs(actual - expected)).toBeLessThan(tolerance)

describe('erlangB', () => {
  it('matches the closed form for one server', () => {
    // B(1, a) = a / (1 + a)
    close(erlangB(1, 0.5), 0.5 / 1.5)
    close(erlangB(1, 8), 8 / 9)
  })

  it('blocks nothing with no load and everything with no servers', () => {
    close(erlangB(5, 0), 0)
    expect(erlangB(0, 3)).toBe(1)
  })

  it('stays finite where the factorial form overflows', () => {
    // a^c / c! is Infinity/Infinity past c ≈ 170. The recurrence is bounded in
    // [0, 1] at every step, which is the whole reason it is used.
    const b = erlangB(400, 380)
    expect(Number.isFinite(b)).toBe(true)
    expect(b).toBeGreaterThan(0)
    expect(b).toBeLessThan(1)
  })
})

describe('erlangC', () => {
  it('equals utilisation for a single server', () => {
    // M/M/1: an arrival queues exactly when the server is busy, which is ρ.
    close(erlangC(1, 0.8), 0.8)
    close(erlangC(1, 0.25), 0.25)
  })

  it('matches the published value for ten servers at 80% load', () => {
    // 0.4090 in any published Erlang C table; 0.409180151 by direct summation
    // of the series, which is what the recurrence is checked against here.
    close(erlangC(10, 8), 0.409180151, 1e-8)
  })

  it('is 1 at or past saturation, where there is no steady state to describe', () => {
    expect(erlangC(4, 4)).toBe(1)
    expect(erlangC(4, 9)).toBe(1)
  })
})

describe('mmcWaitMs', () => {
  it('matches the M/M/1 closed form', () => {
    // Wq = ρ·E[S] / (1 − ρ)
    close(mmcWaitMs(0.0008, 1000, 1), (0.8 * 1000) / 0.2, 1e-6)
    close(mmcWaitMs(0.0005, 1000, 1), (0.5 * 1000) / 0.5, 1e-6)
  })

  it('shows that utilisation alone says nothing about waiting', () => {
    // Both pools are 80% utilised. This is the number a utilisation dashboard
    // reports, and it is the same for both.
    const one = mmcWaitMs(0.0008, 1000, 1)
    const ten = mmcWaitMs(0.008, 1000, 10)
    close(one, 4000, 1e-6)
    close(ten, 204.590075, 1e-4)
    // Twenty times the wait at identical utilisation — which is why one
    // threshold across differently-sized pools cannot mean anything.
    expect(one / ten).toBeGreaterThan(19)
  })

  it('is infinite at saturation rather than a large finite number', () => {
    expect(mmcWaitMs(0.001, 1000, 1)).toBe(Infinity)
    expect(mmcWaitMs(0.002, 1000, 1)).toBe(Infinity)
  })
})

describe('variabilityFactor', () => {
  it('is exactly 1 for Poisson arrivals and exponential service', () => {
    // The property that makes Allen–Cunneen safe to apply unconditionally:
    // where the M/M assumptions hold it changes nothing.
    expect(variabilityFactor(1, 1)).toBe(1)
  })

  it('grows with either source of variability', () => {
    close(variabilityFactor(1, 4), 2.5)
    close(variabilityFactor(3, 1), 2)
  })

  it('assumes exponential rather than zero for a CV it was not given', () => {
    // A missing CV² must not silently become 0 — that would model a perfectly
    // regular arrival stream and halve the predicted wait.
    expect(variabilityFactor(null, undefined)).toBe(1)
    expect(variabilityFactor(NaN, -3)).toBe(1)
  })
})

describe('waitMs', () => {
  it('reduces to M/M/c when the variability is exponential', () => {
    close(waitMs(0.008, 1000, 10, 1, 1), mmcWaitMs(0.008, 1000, 10), 1e-9)
  })

  it('scales the wait by the measured variability', () => {
    // One human approval in the workflow is enough to put the service CV² in
    // this range, and M/M/c would then under-predict the wait by 2.5×.
    const exponential = waitMs(0.008, 1000, 10, 1, 1)
    const bursty = waitMs(0.008, 1000, 10, 1, 4)
    close(bursty / exponential, 2.5, 1e-9)
  })

  it('stays infinite past saturation however tame the variability', () => {
    expect(waitMs(0.002, 1000, 1, 0, 0)).toBe(Infinity)
  })
})

describe('waitPercentileMs', () => {
  it('matches the M/M/1 tail', () => {
    // P(W > t) = ρ·e^(−μ(1−ρ)t)  ⟹  t₉₅ = ln(ρ/0.05) / (μ(1−ρ))
    const expected = Math.log(0.8 / 0.05) / (0.2 / 1000)
    close(waitPercentileMs(0.0008, 1000, 1, 0.95), expected, 1e-6)
  })

  it('is zero when more arrivals start immediately than the percentile asks about', () => {
    // C(10, 8) ≈ 0.41, so 59% of arrivals never queue: the median wait is 0,
    // not a small positive number.
    expect(waitPercentileMs(0.008, 1000, 10, 0.5)).toBe(0)
  })

  it('carries the same variability correction as the mean', () => {
    const plain = waitPercentileMs(0.0008, 1000, 1, 0.95, 1, 1)
    const bursty = waitPercentileMs(0.0008, 1000, 1, 0.95, 1, 4)
    close(bursty / plain, 2.5, 1e-9)
  })

  it('is infinite past saturation', () => {
    expect(waitPercentileMs(0.002, 1000, 1, 0.95)).toBe(Infinity)
  })
})

describe('serversFor', () => {
  it('finds the smallest cap that meets a target', () => {
    // At 8 erlangs: c=9 waits 653ms, c=10 waits 205ms.
    expect(serversFor(0.008, 1000, 250)).toBe(10)
    expect(serversFor(0.008, 1000, 700)).toBe(9)
  })

  it('never returns a cap the load would saturate', () => {
    // A target of ten minutes is met by any stable cap, and 8 is not one.
    expect(serversFor(0.008, 1000, 600000)).toBe(9)
  })

  it('accounts for variability, so a bursty workflow is sized larger', () => {
    const exponential = serversFor(0.008, 1000, 250, 1, 1)
    const bursty = serversFor(0.008, 1000, 250, 1, 4)
    expect(bursty).toBeGreaterThan(exponential)
  })

  it('returns null for a target no cap can reach', () => {
    // Adding servers drives the wait towards zero but never below it, and a
    // search that looped forever looking would be worse than saying so.
    expect(serversFor(0.008, 1000, 0, 1, 1, 64)).toBeNull()
  })
})

describe('stability', () => {
  it('reports how much traffic growth the cap can absorb', () => {
    // 8 erlangs offered into 10 slots: 25% more arrivals and it saturates.
    const s = stability(0.008, 1000, 10)
    expect(s.stable).toBe(true)
    close(s.utilisation, 0.8)
    close(s.headroom, 1.25)
  })

  it('calls an overloaded queue unstable rather than slow', () => {
    // Below 1 the backlog grows without bound, and "the wait is 40 minutes"
    // would be describing a transient on the way to infinity.
    const s = stability(0.02, 1000, 10)
    expect(s.stable).toBe(false)
    expect(s.headroom).toBeLessThan(1)
  })

  it('has unbounded headroom with no arrivals', () => {
    expect(stability(0, 1000, 1).headroom).toBe(Infinity)
  })
})

describe('squaredCv', () => {
  it('is zero for a perfectly regular series', () => {
    expect(squaredCv([500, 500, 500, 500])).toBe(0)
  })

  it('is about 1 for an exponential-looking sample', () => {
    // Exponential has CV² = 1 by definition; this is the assumption M/M/c bakes
    // in, and the point of measuring is to find out when it does not hold.
    const sample = Array.from({ length: 2000 }, (_, i) => -Math.log((i + 0.5) / 2000))
    close(squaredCv(sample), 1, 0.05)
  })

  it('refuses rather than inventing the exponential assumption', () => {
    // Returning 1 from one observation would silently assert "exponential",
    // which is exactly the mistake this file exists to prevent.
    expect(squaredCv([500])).toBeNull()
    expect(squaredCv([])).toBeNull()
    expect(squaredCv([0, 0, 0])).toBeNull()
  })
})

describe('interArrivalGaps', () => {
  it('returns the gaps between consecutive arrivals', () => {
    expect(interArrivalGaps([0, 100, 250])).toEqual([100, 150])
  })

  it('sorts first, so an unordered query result is still correct', () => {
    expect(interArrivalGaps([250, 0, 100])).toEqual([100, 150])
  })

  it('has no gaps to report from a single arrival', () => {
    expect(interArrivalGaps([42])).toEqual([])
    expect(interArrivalGaps([])).toEqual([])
  })
})
