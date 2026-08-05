// Unit tests for services/timezone.js and the zoned mode of the cron engine.
//
// Every assertion pins an exact UTC instant against a real DST transition, so
// these are the tests that would catch a regression in the one part of
// scheduling that is genuinely hard: a wall clock that either never happens
// (spring forward) or happens twice (fall back).
//
// The transitions used, all real:
//   America/New_York  2024-03-10 02:00 EST → 03:00 EDT   (gap)
//                     2024-11-03 02:00 EDT → 01:00 EST   (overlap)
//   Europe/London     2024-03-31 01:00 GMT → 02:00 BST   (gap)
//   Australia/Sydney  2024-04-07 03:00 AEDT → 02:00 AEST (overlap, southern)
//   Asia/Kolkata      no DST, half-hour offset

const {
  isValidTimeZone,
  offsetMinutes,
  zonedTimeToUtc,
  zonedParts,
  formatInZone,
  formatOffset,
} = require('../services/timezone')
const { nextRun, nextRuns } = require('../services/cronExpression')

const NY = 'America/New_York'
const LONDON = 'Europe/London'
const SYDNEY = 'Australia/Sydney'
const KOLKATA = 'Asia/Kolkata'

// Shorthand: ISO string of the next fire in a zone.
const nextIn = (expr, from, timeZone) =>
  nextRun(expr, new Date(from), { timeZone })?.toISOString() ?? null

const runsIn = (expr, count, from, timeZone) =>
  nextRuns(expr, count, new Date(from), { timeZone }).map((d) => d.toISOString())

describe('isValidTimeZone', () => {
  it('accepts IANA names the runtime knows', () => {
    expect(isValidTimeZone(NY)).toBe(true)
    expect(isValidTimeZone('UTC')).toBe(true)
    expect(isValidTimeZone(KOLKATA)).toBe(true)
  })

  it('rejects unknown names, empties, and non-strings', () => {
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
    expect(isValidTimeZone('   ')).toBe(false)
    expect(isValidTimeZone(null)).toBe(false)
    expect(isValidTimeZone(42)).toBe(false)
  })
})

describe('offsetMinutes', () => {
  it('tracks a zone across its own DST change', () => {
    expect(offsetMinutes(NY, new Date('2024-01-15T12:00:00Z'))).toBe(-300) // EST
    expect(offsetMinutes(NY, new Date('2024-07-15T12:00:00Z'))).toBe(-240) // EDT
  })

  it('handles a half-hour offset', () => {
    expect(offsetMinutes(KOLKATA, new Date('2024-01-15T12:00:00Z'))).toBe(330)
  })

  it('reports zero for UTC', () => {
    expect(offsetMinutes('UTC', new Date('2024-06-01T00:00:00Z'))).toBe(0)
  })

  it('flips at the exact transition instant, not before it', () => {
    // The New York spring-forward transition is 2024-03-10T07:00:00Z.
    expect(offsetMinutes(NY, new Date('2024-03-10T06:59:59Z'))).toBe(-300)
    expect(offsetMinutes(NY, new Date('2024-03-10T07:00:00Z'))).toBe(-240)
  })
})

describe('zonedTimeToUtc', () => {
  const fields = (year, month, day, hour, minute) => ({ year, month, day, hour, minute, second: 0 })

  it('converts an ordinary wall clock', () => {
    const { utc, exists, ambiguous } = zonedTimeToUtc(NY, fields(2024, 1, 15, 9, 0))
    expect(utc.toISOString()).toBe('2024-01-15T14:00:00.000Z')
    expect(exists).toBe(true)
    expect(ambiguous).toBe(false)
  })

  it('resolves a skipped wall clock to the transition instant', () => {
    // 02:30 on 2024-03-10 never happens in New York — the clock jumps 02:00→03:00.
    const { utc, exists } = zonedTimeToUtc(NY, fields(2024, 3, 10, 2, 30))
    expect(exists).toBe(false)
    expect(utc.toISOString()).toBe('2024-03-10T07:00:00.000Z')
    // Which reads back as 03:00 local — the moment the clock jumped to.
    expect(zonedParts(NY, utc)).toMatchObject({ hour: 3, minute: 0 })
  })

  it('resolves an ambiguous wall clock to the first occurrence', () => {
    // 01:30 on 2024-11-03 happens twice: 05:30Z (EDT) and 06:30Z (EST).
    const { utc, exists, ambiguous } = zonedTimeToUtc(NY, fields(2024, 11, 3, 1, 30))
    expect(exists).toBe(true)
    expect(ambiguous).toBe(true)
    expect(utc.toISOString()).toBe('2024-11-03T05:30:00.000Z')
  })

  it('handles a southern-hemisphere overlap (Sydney falls back in April)', () => {
    const { utc, ambiguous } = zonedTimeToUtc(SYDNEY, fields(2024, 4, 7, 2, 30))
    expect(ambiguous).toBe(true)
    expect(utc.toISOString()).toBe('2024-04-06T15:30:00.000Z') // AEDT, +11
  })

  it('handles a London gap at midnight-adjacent local time', () => {
    // London jumps 01:00 GMT → 02:00 BST on 2024-03-31, so 01:30 is skipped.
    const { utc, exists } = zonedTimeToUtc(LONDON, fields(2024, 3, 31, 1, 30))
    expect(exists).toBe(false)
    expect(utc.toISOString()).toBe('2024-03-31T01:00:00.000Z')
  })

  it('round-trips a half-hour-offset zone', () => {
    const { utc } = zonedTimeToUtc(KOLKATA, fields(2024, 6, 1, 9, 15))
    expect(utc.toISOString()).toBe('2024-06-01T03:45:00.000Z')
  })
})

describe('cron in a named zone', () => {
  it('fires at the local wall clock, not the UTC one', () => {
    // 09:00 New York is 14:00Z in winter and 13:00Z in summer — the whole point.
    expect(nextIn('0 9 * * *', '2024-01-15T00:00:00Z', NY)).toBe('2024-01-15T14:00:00.000Z')
    expect(nextIn('0 9 * * *', '2024-07-15T00:00:00Z', NY)).toBe('2024-07-15T13:00:00.000Z')
  })

  it('keeps the local hour stable across a DST change', () => {
    // A daily 09:00 job must stay at 09:00 local on both sides of the change,
    // which means its UTC instant moves by an hour.
    const runs = runsIn('0 9 * * *', 2, '2024-03-08T20:00:00Z', NY)
    expect(runs).toEqual(['2024-03-09T14:00:00.000Z', '2024-03-10T13:00:00.000Z'])
  })

  it('still runs once on the day a spring-forward skips its hour', () => {
    // 02:30 does not exist on 2024-03-10; the run lands on the transition
    // instant rather than being silently dropped for the day.
    const runs = runsIn('30 2 * * *', 3, '2024-03-09T00:00:00Z', NY)
    expect(runs).toEqual([
      '2024-03-09T07:30:00.000Z', // 02:30 EST
      '2024-03-10T07:00:00.000Z', // skipped → fires at the 03:00 EDT jump
      '2024-03-11T06:30:00.000Z', // 02:30 EDT
    ])
  })

  it('does not fire twice when the clocks go back', () => {
    // 01:30 exists twice on 2024-11-03. Exactly one run lands that day.
    const runs = runsIn('30 1 * * *', 3, '2024-11-02T00:00:00Z', NY)
    expect(runs).toEqual([
      '2024-11-02T05:30:00.000Z',
      '2024-11-03T05:30:00.000Z', // the first (EDT) occurrence only
      '2024-11-04T06:30:00.000Z',
    ])
  })

  it('does not replay the repeated hour when asked mid-overlap', () => {
    // Asked from 01:45 EDT (inside the repeat), the next 01:30 is tomorrow's —
    // never the 01:30 that is about to happen again on the other side.
    expect(nextIn('30 1 * * *', '2024-11-03T05:45:00Z', NY)).toBe('2024-11-04T06:30:00.000Z')
  })

  it('advances an hourly schedule cleanly through both transitions', () => {
    const spring = runsIn('0 * * * *', 4, '2024-03-10T06:00:00Z', NY)
    // 01:00 EST, then the 02:00 hour is skipped entirely, then 03:00/04:00 EDT.
    expect(spring).toEqual([
      '2024-03-10T07:00:00.000Z',
      '2024-03-10T08:00:00.000Z',
      '2024-03-10T09:00:00.000Z',
      '2024-03-10T10:00:00.000Z',
    ])
    // Every instant is distinct and increasing — no duplicate at the fall back.
    const autumn = runsIn('0 * * * *', 6, '2024-11-03T04:30:00Z', NY)
    expect(new Set(autumn).size).toBe(autumn.length)
    for (let i = 1; i < autumn.length; i++) {
      expect(new Date(autumn[i]).getTime()).toBeGreaterThan(new Date(autumn[i - 1]).getTime())
    }
  })

  it('respects local weekday boundaries', () => {
    // 23:00 Sunday in Sydney is Sunday 12:00Z — a UTC-based matcher would place
    // this run on the wrong day of the week.
    expect(nextIn('0 23 * * 0', '2024-06-01T00:00:00Z', SYDNEY)).toBe('2024-06-02T13:00:00.000Z')
  })

  it('is unaffected for a zone without DST', () => {
    const runs = runsIn('0 9 * * *', 2, '2024-03-09T00:00:00Z', KOLKATA)
    expect(runs).toEqual(['2024-03-09T03:30:00.000Z', '2024-03-10T03:30:00.000Z'])
  })

  it('matches UTC exactly when no zone (or UTC) is given', () => {
    const bare = nextRun('0 9 * * *', new Date('2024-01-15T00:00:00Z'))
    const utc = nextRun('0 9 * * *', new Date('2024-01-15T00:00:00Z'), { timeZone: 'UTC' })
    expect(bare.toISOString()).toBe('2024-01-15T09:00:00.000Z')
    expect(utc.toISOString()).toBe(bare.toISOString())
  })

  it('throws on an unknown zone rather than reporting an unreachable schedule', () => {
    expect(() => nextRun('0 9 * * *', new Date(), { timeZone: 'Mars/Olympus_Mons' })).toThrow(
      /Unknown time zone/
    )
  })

  it('keeps the strictly-after contract at an exact fire time', () => {
    // Asking from precisely 09:00 local returns tomorrow, never the same instant.
    expect(nextIn('0 9 * * *', '2024-01-15T14:00:00Z', NY)).toBe('2024-01-16T14:00:00.000Z')
  })

  it('reports an impossible calendar date as unreachable in a zone too', () => {
    expect(nextRun('0 0 30 2 *', new Date('2024-01-01T00:00:00Z'), { timeZone: NY })).toBeNull()
  })
})

describe('display helpers', () => {
  it('formats the wall clock in the zone', () => {
    expect(formatInZone(NY, new Date('2024-01-15T14:00:00Z'))).toBe('2024-01-15 09:00')
    expect(formatInZone(NY, new Date('2024-07-15T13:00:00Z'))).toBe('2024-07-15 09:00')
  })

  it('formats the offset in effect, including a half-hour zone', () => {
    expect(formatOffset(NY, new Date('2024-01-15T14:00:00Z'))).toBe('UTC-05:00')
    expect(formatOffset(NY, new Date('2024-07-15T13:00:00Z'))).toBe('UTC-04:00')
    expect(formatOffset(KOLKATA, new Date('2024-01-15T00:00:00Z'))).toBe('UTC+05:30')
    expect(formatOffset('UTC', new Date())).toBe('UTC+00:00')
  })
})
