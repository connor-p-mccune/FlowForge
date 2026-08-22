// Tests for output profiling and drift comparison.
//
// Two halves, and the second is the important one. The first checks that a
// change in the data is found. The second checks the much harder property —
// that a report over stable data is **empty**, and that everything which would
// technically qualify as "different" but is not worth waking anybody for is
// filtered out with a reason. A drift checker that fires on every field is one
// nobody reads.

const {
  profileRecord,
  mergeProfiles,
  compareProfiles,
  downsample,
  parentOf,
  REDACTION_MASK,
} = require('../services/dataProfile')

// Accumulate `n` records produced by `make(i)` into one window profile.
const windowOf = (n, make) => {
  let profile = null
  for (let i = 0; i < n; i++) profile = mergeProfiles(profile, profileRecord(make(i)))
  return profile
}

const findingFor = (result, path, kind) =>
  result.findings.find((f) => f.path === path && (!kind || f.kind === kind))

describe('profileRecord', () => {
  it('records a path per field with its type', () => {
    const p = profileRecord({ id: 7, name: 'ada', ok: true })
    expect(p.records).toBe(1)
    expect(p.paths.id.types).toEqual({ number: 1 })
    expect(p.paths.name.types).toEqual({ string: 1 })
    expect(p.paths.ok.types).toEqual({ boolean: 1 })
    expect(p.paths.id.numeric).toEqual([7])
  })

  it('descends into nested objects with dotted paths', () => {
    const p = profileRecord({ customer: { address: { city: 'Leeds' } } })
    expect(p.paths['customer.address.city'].categories).toEqual({ Leeds: 1 })
  })

  it('counts nulls separately from absence', () => {
    const p = profileRecord({ email: null })
    expect(p.paths.email.seen).toBe(1)
    expect(p.paths.email.nulls).toBe(1)
    expect(p.paths.missing).toBeUndefined()
  })

  it('records an array’s length and profiles its elements', () => {
    // The common case: one record per run at the top, hundreds one level down —
    // and the field that breaks is almost always down there.
    const p = profileRecord({ orders: [{ amount: 10 }, { amount: 20 }] })
    expect(p.paths.orders.types).toEqual({ array: 1 })
    expect(p.paths.orders.lengths).toEqual([2])
    expect(p.paths['orders[].amount'].seen).toBe(2)
    expect(p.paths['orders[].amount'].numeric).toEqual([10, 20])
  })

  it('excludes redacted values instead of treating the mask as data', () => {
    const p = profileRecord({ token: REDACTION_MASK, plain: 'x' })
    expect(p.paths.token.masked).toBe(1)
    expect(p.paths.token.categories).toEqual({})
    expect(p.paths.plain.categories).toEqual({ x: 1 })
  })

  it('treats a long string as free text, not a label', () => {
    const p = profileRecord({ body: 'x'.repeat(500) })
    expect(p.paths.body.categories).toEqual({})
    expect(p.paths.body.categoryOverflow).toBe(true)
    expect(p.paths.body.lengths).toEqual([500])
  })

  it('bounds depth, array width, and path count, and says when it truncated', () => {
    const wide = { items: Array.from({ length: 100 }, (_, i) => ({ i })) }
    const p = profileRecord(wide)
    expect(p.paths['items[].i'].seen).toBe(25)
    expect(p.truncated).toBe(true)

    const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } }
    expect(profileRecord(deep).paths['a.b.c.d.e.f.g']).toBeUndefined()
  })

  it('profiles a bare array output', () => {
    const p = profileRecord([{ id: 1 }, { id: 2 }])
    expect(p.paths['[].id'].seen).toBe(2)
  })

  it('produces nothing for a scalar output', () => {
    expect(Object.keys(profileRecord(42).paths)).toHaveLength(0)
  })
})

describe('mergeProfiles', () => {
  it('accumulates counts across records', () => {
    const merged = windowOf(3, (i) => ({ n: i }))
    expect(merged.records).toBe(3)
    expect(merged.paths.n.seen).toBe(3)
    expect(merged.paths.n.numeric).toEqual([0, 1, 2])
  })

  it('is a no-op against null on either side', () => {
    const one = profileRecord({ a: 1 })
    expect(mergeProfiles(null, one)).toBe(one)
    expect(mergeProfiles(one, null)).toBe(one)
  })

  it('keeps a field seen in only some records', () => {
    const merged = mergeProfiles(profileRecord({ a: 1 }), profileRecord({ b: 2 }))
    expect(merged.paths.a.seen).toBe(1)
    expect(merged.paths.b.seen).toBe(1)
    expect(merged.records).toBe(2)
  })

  it('carries the overflow flag forward once either side has overflowed', () => {
    const many = windowOf(80, (i) => ({ id: `id-${i}` }))
    expect(many.paths.id.categoryOverflow).toBe(true)
  })
})

describe('downsample', () => {
  it('leaves a sample under the cap alone', () => {
    expect(downsample([1, 2, 3], 10)).toEqual([1, 2, 3])
  })

  it('takes an even stride rather than the first N', () => {
    // Taking the first N would let the oldest runs in the window decide the
    // distribution — backwards for a check about change over time.
    const out = downsample(Array.from({ length: 100 }, (_, i) => i), 10)
    expect(out).toHaveLength(10)
    expect(out[0]).toBe(0)
    expect(out[9]).toBeGreaterThan(80)
  })

  it('is deterministic', () => {
    const values = Array.from({ length: 77 }, (_, i) => i)
    expect(downsample(values, 20)).toEqual(downsample(values, 20))
  })
})

describe('parentOf', () => {
  it('is the containing object for a nested key', () => {
    expect(parentOf('customer.address.city')).toBe('customer.address')
    expect(parentOf('id')).toBe('')
  })

  it('is null for an array element — presence there is a length, not a rate', () => {
    expect(parentOf('orders[]')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The findings.
// ---------------------------------------------------------------------------

describe('compareProfiles — changes it should find', () => {
  it('finds a field that started coming back null', () => {
    // The motivating case: every run completes, every step succeeds, the
    // durations are unchanged, and 40% of the emails are not being sent.
    const before = windowOf(100, () => ({ email: 'a@b.com' }))
    const after = windowOf(100, (i) => ({ email: i % 10 < 4 ? null : 'a@b.com' }))
    const finding = findingFor(compareProfiles(before, after), 'email', 'null-rate')
    expect(finding).toBeDefined()
    expect(finding.severity).toBe('major')
    expect(finding.summary).toMatch(/null in 40\.0% of records, was 0\.0%/)
  })

  it('finds a field that disappeared', () => {
    const before = windowOf(100, () => ({ id: 1, coupon: 'X' }))
    const after = windowOf(100, () => ({ id: 1 }))
    const finding = findingFor(compareProfiles(before, after), 'coupon')
    expect(finding.kind).toBe('field-missing')
    expect(finding.severity).toBe('major')
  })

  it('finds a field that appeared', () => {
    const before = windowOf(100, () => ({ id: 1 }))
    const after = windowOf(100, () => ({ id: 1, tier: 'gold' }))
    expect(findingFor(compareProfiles(before, after), 'tier').kind).toBe('field-added')
  })

  it('finds a type that changed under it', () => {
    // The classic: an API starts serialising a number as a string.
    const before = windowOf(60, (i) => ({ amount: i }))
    const after = windowOf(60, (i) => ({ amount: String(i) }))
    const finding = findingFor(compareProfiles(before, after), 'amount', 'type-changed')
    expect(finding.severity).toBe('major')
    expect(finding.summary).toBe('amount is now string, was number')
  })

  it('finds a numeric distribution that moved', () => {
    const before = windowOf(120, (i) => ({ total: 100 + (i % 20) }))
    const after = windowOf(120, (i) => ({ total: 900 + (i % 20) }))
    const finding = findingFor(compareProfiles(before, after), 'total', 'distribution')
    expect(finding.severity).toBe('major')
    expect(finding.detail.test).toBe('kolmogorov-smirnov')
  })

  it('finds a shape change that leaves the median alone', () => {
    // Same centre, one window bimodal — a t-test would report nothing.
    const before = windowOf(200, () => ({ score: 50 }))
    const after = windowOf(200, (i) => ({ score: i % 2 ? 0 : 100 }))
    expect(findingFor(compareProfiles(before, after), 'score', 'distribution')).toBeDefined()
  })

  it('finds a category mix that shifted, and names the category', () => {
    const before = windowOf(200, (i) => ({ status: i % 20 === 0 ? 'error' : 'ok' }))
    const after = windowOf(200, (i) => ({ status: i % 2 === 0 ? 'error' : 'ok' }))
    const finding = findingFor(compareProfiles(before, after), 'status', 'categories')
    expect(finding.severity).toBe('major')
    expect(finding.summary).toMatch(/"error"/)
  })

  it('finds drift inside an array’s elements', () => {
    const before = windowOf(30, () => ({ orders: Array.from({ length: 5 }, () => ({ amount: 10 })) }))
    const after = windowOf(30, () => ({ orders: Array.from({ length: 5 }, () => ({ amount: null })) }))
    expect(findingFor(compareProfiles(before, after), 'orders[].amount', 'null-rate')).toBeDefined()
  })

  it('sorts major findings ahead of minor ones', () => {
    const before = windowOf(200, (i) => ({ big: i % 100 === 0 ? null : 1, small: i % 100 === 0 ? null : 2 }))
    const after = windowOf(200, (i) => ({ big: i % 2 === 0 ? null : 1, small: i % 8 === 0 ? null : 2 }))
    const result = compareProfiles(before, after)
    expect(result.findings[0].severity).toBe('major')
  })
})

describe('compareProfiles — what it must not report', () => {
  it('reports nothing at all for two windows of the same data', () => {
    const shape = (i) => ({
      id: `order-${i}`,
      amount: 100 + (i % 50),
      status: i % 5 === 0 ? 'pending' : 'ok',
      customer: { email: 'a@b.com', tier: i % 3 === 0 ? 'gold' : 'silver' },
      items: [{ sku: 'A', qty: (i % 3) + 1 }],
    })
    const before = windowOf(150, shape)
    const after = windowOf(150, (i) => shape(i + 150))
    expect(compareProfiles(before, after).findings).toEqual([])
  })

  it('does not report a tiny but statistically significant shift', () => {
    // 500 records will make a 2% move significant. Reporting it is how the
    // report gets ignored.
    const before = windowOf(500, (i) => ({ flag: i % 100 === 0 ? null : 1 }))
    const after = windowOf(500, (i) => ({ flag: i % 33 === 0 ? null : 1 }))
    expect(findingFor(compareProfiles(before, after), 'flag', 'null-rate')).toBeUndefined()
  })

  it('does not treat an identifier as a category', () => {
    // Order ids are 100% new values in every window; PSI over them is always
    // large and never means anything.
    const before = windowOf(120, (i) => ({ orderId: `ord-${i}` }))
    const after = windowOf(120, (i) => ({ orderId: `ord-${i + 10000}` }))
    const result = compareProfiles(before, after)
    expect(findingFor(result, 'orderId', 'categories')).toBeUndefined()
    expect(result.skipped).toContainEqual({ path: 'orderId', reason: 'identifier-like' })
  })

  it('does not compare a field the engine redacted', () => {
    const before = windowOf(60, () => ({ apiKey: 'sk-live-1234' }))
    const after = windowOf(60, () => ({ apiKey: REDACTION_MASK }))
    const result = compareProfiles(before, after)
    expect(result.findings.filter((f) => f.path === 'apiKey')).toEqual([])
    expect(result.skipped).toContainEqual({ path: 'apiKey', reason: 'redacted' })
  })

  it('does not judge a field with too few observations', () => {
    const before = windowOf(6, () => ({ rare: 1 }))
    const after = windowOf(6, () => ({ rare: null }))
    const result = compareProfiles(before, after)
    expect(result.findings).toEqual([])
    expect(result.skipped).toContainEqual({ path: 'rare', reason: 'too-few-samples' })
  })

  it('does not report a distribution shift too small to matter', () => {
    const before = windowOf(200, (i) => ({ n: i % 100 }))
    const after = windowOf(200, (i) => ({ n: (i % 100) + 1 }))
    expect(findingFor(compareProfiles(before, after), 'n', 'distribution')).toBeUndefined()
  })

  it('reports nothing when either window is empty', () => {
    const populated = windowOf(50, () => ({ a: 1 }))
    expect(compareProfiles(null, populated).findings).toEqual([])
    expect(compareProfiles(populated, { records: 0, paths: {} }).findings).toEqual([])
  })
})

describe('compareProfiles — coverage is reported, not implied', () => {
  it('counts what it compared and what it skipped', () => {
    const before = mergeProfiles(
      windowOf(60, () => ({ solid: 1 })),
      windowOf(3, () => ({ thin: 1 }))
    )
    const after = mergeProfiles(
      windowOf(60, () => ({ solid: 1 })),
      windowOf(3, () => ({ thin: 2 }))
    )
    const result = compareProfiles(before, after)
    expect(result.compared).toBe(1)
    expect(result.skipped.some((s) => s.path === 'thin')).toBe(true)
    expect(result.paths).toBe(2)
  })
})
