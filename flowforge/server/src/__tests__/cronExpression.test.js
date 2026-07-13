// Unit tests for the cron engine (services/cronExpression.js). Pure functions of
// (expression, from) with no I/O, so every case pins an exact UTC instant.

const { parseCron, nextRun, nextRuns, isValid } = require('../services/cronExpression')

// A fixed UTC starting point for deterministic "next fire" assertions:
// Wednesday, 2026-01-14T09:23:30Z.
const FROM = new Date('2026-01-14T09:23:30.000Z')

// Shorthand: the ISO string of the next fire after `from` (default FROM).
const next = (expr, from = FROM) => nextRun(expr, from)?.toISOString() ?? null

describe('parseCron', () => {
  it('parses a 5-field expression into per-field value sets', () => {
    const f = parseCron('30 9 * * *')
    expect([...f.minute]).toEqual([30])
    expect([...f.hour]).toEqual([9])
    expect(f.hasSeconds).toBe(false)
    expect(f.domRestricted).toBe(false)
    expect(f.dowRestricted).toBe(false)
  })

  it('accepts a 6-field expression with a leading seconds field', () => {
    const f = parseCron('15 30 9 * * *')
    expect(f.hasSeconds).toBe(true)
    expect([...f.second]).toEqual([15])
    expect([...f.minute]).toEqual([30])
  })

  it('expands ranges, steps, and lists', () => {
    expect([...parseCron('0 9-11 * * *').hour]).toEqual([9, 10, 11])
    expect([...parseCron('*/15 * * * *').minute]).toEqual([0, 15, 30, 45])
    expect([...parseCron('0 0 1,15 * *').dom]).toEqual([1, 15])
    // A stepped range: every other hour from 0 to 6.
    expect([...parseCron('0 0-6/2 * * *').hour]).toEqual([0, 2, 4, 6])
    // A single value with a step counts to the field max (Vixie semantics).
    expect([...parseCron('0 5/6 * * *').hour]).toEqual([5, 11, 17, 23])
  })

  it('resolves month and day names case-insensitively', () => {
    expect([...parseCron('0 0 1 JAN *').month]).toEqual([1])
    expect([...parseCron('0 0 * * mon-fri').dow]).toEqual([1, 2, 3, 4, 5])
  })

  it('folds day-of-week 7 onto 0 (both are Sunday)', () => {
    expect([...parseCron('0 0 * * 7').dow]).toEqual([0])
  })

  it('expands @macros', () => {
    expect([...parseCron('@hourly').minute]).toEqual([0])
    expect([...parseCron('@daily').hour]).toEqual([0])
    const weekly = parseCron('@weekly')
    expect([...weekly.dow]).toEqual([0])
    expect(weekly.dowRestricted).toBe(true)
  })

  it('marks a field restricted only when it is not a full-range wildcard', () => {
    expect(parseCron('0 0 5 * *').domRestricted).toBe(true)
    expect(parseCron('0 0 * * *').domRestricted).toBe(false)
    // `*/1` covers the whole range, so it stays unrestricted.
    expect(parseCron('0 0 */1 * *').domRestricted).toBe(false)
  })

  it.each([
    ['', 'empty'],
    ['* * *', 'too few fields'],
    ['* * * * * * *', 'too many fields'],
    ['60 * * * *', 'minute out of range'],
    ['* 24 * * *', 'hour out of range'],
    ['* * 0 * *', 'day-of-month below 1'],
    ['* * * 13 *', 'month above 12'],
    ['* * * * 8', 'day-of-week above 7'],
    ['*/0 * * * *', 'zero step'],
    ['5-1 * * * *', 'inverted range'],
    ['abc * * * *', 'non-numeric'],
  ])('rejects %p (%s)', (expr) => {
    expect(() => parseCron(expr)).toThrow(/Invalid cron expression/)
  })
})

describe('nextRun', () => {
  it('advances to the next matching minute within the hour', () => {
    // 09:23:30 → the :30 minute of the same hour.
    expect(next('30 * * * *')).toBe('2026-01-14T09:30:00.000Z')
  })

  it('rolls into the next hour when the minute has passed', () => {
    // :15 already passed at :23, so the next is 10:15.
    expect(next('15 * * * *')).toBe('2026-01-14T10:15:00.000Z')
  })

  it('rolls into the next day for a daily schedule already past today', () => {
    // 09:00 has passed; next is tomorrow at 09:00.
    expect(next('0 9 * * *')).toBe('2026-01-15T09:00:00.000Z')
  })

  it('handles a specific later time today', () => {
    expect(next('0 17 * * *')).toBe('2026-01-14T17:00:00.000Z')
  })

  it('rolls across a month boundary', () => {
    // The 1st at midnight, from mid-January → Feb 1.
    expect(next('0 0 1 * *')).toBe('2026-02-01T00:00:00.000Z')
  })

  it('rolls across a year boundary', () => {
    // 23:59 on New Year's Eve, every 30 minutes → 00:00 on Jan 1 next year.
    const dec = new Date('2026-12-31T23:59:00.000Z')
    expect(next('*/30 * * * *', dec)).toBe('2027-01-01T00:00:00.000Z')
  })

  it('honours a seconds field', () => {
    // 6-field: at second 45 of every minute. 09:23:30 → 09:23:45.
    expect(next('45 * * * * *')).toBe('2026-01-14T09:23:45.000Z')
  })

  it('respects weekday names (next weekday run)', () => {
    // FROM is a Wednesday; 09:00 already passed, so next MON-FRI 09:00 is
    // Thursday the 15th.
    expect(next('0 9 * * MON-FRI')).toBe('2026-01-15T09:00:00.000Z')
  })

  it('skips the weekend for a weekday schedule', () => {
    // Friday 2026-01-16 18:00 → next MON-FRI 09:00 is Monday the 19th.
    const friEvening = new Date('2026-01-16T18:00:00.000Z')
    expect(next('0 9 * * 1-5', friEvening)).toBe('2026-01-19T09:00:00.000Z')
  })

  it('applies the day-of-month OR day-of-week rule when both are restricted', () => {
    // "0 0 13 * FRI" = midnight on the 13th OR any Friday. From Jan 14 the next
    // Friday is Jan 16 — sooner than the 13th of next month.
    expect(next('0 0 13 * FRI')).toBe('2026-01-16T00:00:00.000Z')
  })

  it('ANDs the day-of-month with other fields when day-of-week is a wildcard', () => {
    // Only the 20th qualifies (dow is *), at 00:00.
    expect(next('0 0 20 * *')).toBe('2026-01-20T00:00:00.000Z')
  })

  it('finds a sparse yearly date (the 29th of February)', () => {
    // 2026 and 2027 have no Feb 29; the next is 2028 (a leap year).
    expect(next('0 0 29 2 *')).toBe('2028-02-29T00:00:00.000Z')
  })

  it('returns null for an impossible calendar date', () => {
    // The 30th of February never occurs.
    expect(nextRun('0 0 30 2 *', FROM)).toBeNull()
  })

  it('never reports a fire time equal to `from`', () => {
    const onTheMinute = new Date('2026-01-14T09:00:00.000Z')
    // 09:00 exactly — the next daily 09:00 is tomorrow, not this instant.
    expect(next('0 9 * * *', onTheMinute)).toBe('2026-01-15T09:00:00.000Z')
  })
})

describe('nextRuns', () => {
  it('returns the requested number of upcoming fire times, oldest first', () => {
    const runs = nextRuns('0 9 * * *', 3, FROM).map((d) => d.toISOString())
    expect(runs).toEqual([
      '2026-01-15T09:00:00.000Z',
      '2026-01-16T09:00:00.000Z',
      '2026-01-17T09:00:00.000Z',
    ])
  })

  it('steps every 15 minutes correctly across the hour', () => {
    const runs = nextRuns('*/15 * * * *', 4, FROM).map((d) => d.toISOString())
    expect(runs).toEqual([
      '2026-01-14T09:30:00.000Z',
      '2026-01-14T09:45:00.000Z',
      '2026-01-14T10:00:00.000Z',
      '2026-01-14T10:15:00.000Z',
    ])
  })

  it('stops early (fewer results) for an impossible schedule', () => {
    expect(nextRuns('0 0 30 2 *', 5, FROM)).toEqual([])
  })

  it('caps the count and coerces a bad count to zero', () => {
    expect(nextRuns('* * * * *', 1000, FROM)).toHaveLength(100)
    expect(nextRuns('* * * * *', -1, FROM)).toEqual([])
  })
})

describe('isValid', () => {
  it('accepts valid expressions and macros', () => {
    expect(isValid('*/5 * * * *')).toBe(true)
    expect(isValid('0 9 * * MON-FRI')).toBe(true)
    expect(isValid('@daily')).toBe(true)
    expect(isValid('30 0 1 1 *')).toBe(true)
  })

  it('rejects malformed expressions', () => {
    expect(isValid('nonsense')).toBe(false)
    expect(isValid('* * *')).toBe(false)
    expect(isValid('99 * * * *')).toBe(false)
  })
})
