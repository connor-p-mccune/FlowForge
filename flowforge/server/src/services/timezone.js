// IANA time zone support, built on Intl — no dependency, no tz database of our
// own. The cron engine (services/cronExpression.js) computes fire times in UTC;
// this module is what lets it compute them in a *named zone* instead, which is
// what a schedule actually means to the person who wrote it ("weekdays at 9am"
// is 9am in an office, not 9am in Greenwich).
//
// Everything here exists to answer two questions the platform's own Date can't:
//
//   1. What is the zone's UTC offset at a given instant? (`offsetMinutes`)
//   2. Which instant does a given *wall clock* in that zone correspond to?
//      (`zonedTimeToUtc`)
//
// The second question is the hard one, because twice a year it has no single
// answer:
//
//   - **Spring forward** leaves a gap. On 2024-03-10 America/New_York jumps
//     02:00 EST → 03:00 EDT, so 02:30 that day *never happens*. A daily 02:30
//     job still has to run, so a gap resolves to the transition instant itself
//     — the moment the clock jumps — and the job fires once, at 03:00 local.
//     Skipping the day instead would silently drop a run once a year.
//
//   - **Fall back** leaves an overlap. On 2024-11-03 the same zone repeats
//     01:00–02:00, so 01:30 happens *twice*. An ambiguous wall clock resolves
//     to the **first** (pre-transition) occurrence, and the cron search's
//     strictly-after-in-UTC contract stops the second occurrence from firing a
//     duplicate.
//
// The offsets are read from the runtime's own tz data via
// Intl.DateTimeFormat#formatToParts — the same source `Date` uses — so this
// stays correct across zone-rule changes without shipping a database.

// Intl.DateTimeFormat construction is expensive relative to how often the
// scheduler asks; formatters are immutable, so one per zone is cached forever.
// The set of zones in play is bounded by the workflows a workspace deploys.
const formatters = new Map()

const DAY_MS = 86400000

function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    // hourCycle 'h23' matters: with hour12:false some runtimes render midnight
    // as hour "24", which would push every midnight schedule a day forward.
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

// True when the runtime recognises the zone name. Intl throws a RangeError for
// an unknown zone, which is exactly the check — no allow-list to maintain, and
// it accepts everything the deployment's tz database knows about.
function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') return false
  try {
    formatterFor(timeZone.trim())
    return true
  } catch {
    return false
  }
}

// The wall-clock fields an instant reads as in the zone.
function zonedParts(timeZone, date) {
  const parts = formatterFor(timeZone).formatToParts(date)
  const out = {}
  for (const part of parts) {
    if (part.type !== 'literal') out[part.type] = Number(part.value)
  }
  // Defensive: a runtime that ignores hourCycle would report 24 for midnight.
  if (out.hour === 24) out.hour = 0
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour,
    minute: out.minute,
    second: out.second,
  }
}

// Wall-clock fields packed into the UTC instant with those same numbers — the
// "pseudo-UTC" representation the cron search steps through. Reading a local
// time as if it were UTC is what lets the existing field-stepping matcher work
// unchanged in local space; the result is converted back by zonedTimeToUtc.
function partsToUtcMs({ year, month, day, hour, minute, second }) {
  return Date.UTC(year, month - 1, day, hour, minute, second)
}

// The zone's offset from UTC at an instant, in minutes east (New York in
// winter is -300). Derived by diffing the zone's wall clock against the
// instant itself — the standard trick, and the only one available without a tz
// database. Both sides are floored to the second because formatToParts has no
// millisecond field.
function offsetMinutes(timeZone, date) {
  const asUtc = partsToUtcMs(zonedParts(timeZone, date))
  const flooredMs = Math.floor(date.getTime() / 1000) * 1000
  return (asUtc - flooredMs) / 60000
}

// Binary-search the instant at which the zone's offset changes, given two
// instants known to sit on opposite sides of the change. Returns the first
// instant on the *new* offset — i.e. the exact moment the clock jumps.
//
// The search runs to millisecond precision rather than stopping a second short:
// the result is a fire time that gets persisted and compared, so "07:00:00.000Z"
// and "07:00:00.039Z" are not interchangeable. A two-day bracket settles in ~38
// iterations, and only a skipped wall clock ever pays for them.
//
// The invariant maintained throughout — offset(lo) is the old value, offset(hi)
// is not — makes `hi` the transition by construction once they are adjacent.
function findTransition(timeZone, beforeMs, afterMs) {
  const beforeOffset = offsetMinutes(timeZone, new Date(beforeMs))
  let lo = beforeMs
  let hi = afterMs
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2)
    if (offsetMinutes(timeZone, new Date(mid)) === beforeOffset) lo = mid
    else hi = mid
  }
  return hi
}

// Convert a wall clock in `timeZone` to the UTC instant it names.
//
// Returns { utc, exists, ambiguous } so callers can tell an ordinary
// conversion from a DST edge:
//
//   exists:false     the wall clock was skipped by a spring-forward gap; `utc`
//                    is the transition instant (the time the clock jumped to).
//   ambiguous:true   the wall clock happens twice in a fall-back overlap;
//                    `utc` is the first (earlier) of the two.
//
// The search is offset-driven rather than iterative: only two offsets can
// plausibly apply to a wall clock — the one a day before it and the one a day
// after — so each is tried and kept when it round-trips (the instant it
// implies really does read back as the requested wall clock). Zero valid
// candidates means a gap; two means an overlap.
function zonedTimeToUtc(timeZone, fields) {
  const naive = partsToUtcMs(fields)
  const beforeOffset = offsetMinutes(timeZone, new Date(naive - DAY_MS))
  const afterOffset = offsetMinutes(timeZone, new Date(naive + DAY_MS))

  const valid = []
  for (const offset of new Set([beforeOffset, afterOffset])) {
    const candidate = naive - offset * 60000
    if (offsetMinutes(timeZone, new Date(candidate)) === offset) valid.push(candidate)
  }

  if (valid.length > 0) {
    valid.sort((a, b) => a - b)
    return { utc: new Date(valid[0]), exists: true, ambiguous: valid.length > 1 }
  }

  // Gap: neither offset round-trips, so the wall clock was skipped. Bracket the
  // transition with the two candidate instants (one sits before it, one after,
  // in either order) padded by a day, and resolve to the jump itself.
  const candidates = [naive - beforeOffset * 60000, naive - afterOffset * 60000]
  const lo = Math.min(...candidates) - DAY_MS
  const hi = Math.max(...candidates) + DAY_MS
  return { utc: new Date(findTransition(timeZone, lo, hi)), exists: false, ambiguous: false }
}

// The instant re-read as a pseudo-UTC Date carrying the zone's wall-clock
// fields. The inverse direction of zonedTimeToUtc, used to seed the cron
// search from a real instant.
function utcToZonedPseudo(timeZone, date) {
  return new Date(partsToUtcMs(zonedParts(timeZone, date)))
}

// "2024-03-10 03:00" — the zone's wall clock, for display beside the UTC
// instant the API returns. Deliberately not localised: a schedule preview is
// read by operators, and an unambiguous fixed format beats a locale guess.
function formatInZone(timeZone, date) {
  const p = zonedParts(timeZone, date)
  const pad = (n, width = 2) => String(n).padStart(width, '0')
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`
}

// "UTC-05:00" — the offset in effect at an instant, rendered for the same
// preview surfaces. Shows *which side* of a DST change a fire time sits on,
// which is the whole reason a zone-aware preview is worth showing.
function formatOffset(timeZone, date) {
  const minutes = offsetMinutes(timeZone, date)
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  const pad = (n) => String(n).padStart(2, '0')
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

module.exports = {
  isValidTimeZone,
  zonedParts,
  offsetMinutes,
  zonedTimeToUtc,
  utcToZonedPseudo,
  formatInZone,
  formatOffset,
}
