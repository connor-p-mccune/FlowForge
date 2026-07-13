// Cron expression engine: parse a standard cron expression and compute the
// wall-clock instants it will next fire. The scheduler (services/scheduler.js)
// leans on node-cron to *validate* an expression and to *fire* it, but node-cron
// can't answer "when does this run next?" — which is exactly what a schedule
// preview needs. This module is that missing piece: a small, dependency-free
// interpreter that turns an expression into its upcoming fire times.
//
// Two correctness details make this more than a toy:
//
//   1. The day-of-month / day-of-week OR-rule. In Vixie cron, when *both* the
//      day-of-month and the day-of-week fields are restricted (neither is `*`),
//      a date fires if it matches *either* — `0 0 13 * FRI` means "the 13th, and
//      also every Friday", not "Friday the 13th". When only one is restricted it
//      ANDs normally. Getting this wrong is the classic cron bug.
//
//   2. Field-stepping, not minute-ticking. Rather than testing every minute
//      until one matches (millions of iterations for a sparse schedule like
//      `0 0 29 2 *`), the search jumps: a disallowed month skips to the first of
//      the next allowed month, a disallowed day skips a whole day, and so on. It
//      settles on the answer in a few hundred steps at worst, and returns null
//      for an impossible schedule (Feb 30) instead of looping forever.
//
// All computation is in UTC and Date arguments are treated as UTC instants, so
// the result is deterministic and independent of the server's timezone; callers
// render the ISO-8601 `Z` timestamps in whatever zone they present.

// Field bounds as [min, max]. Seconds is optional (6-field expressions); the
// standard 5-field form starts at minute.
const FIELDS = {
  second: [0, 59],
  minute: [0, 59],
  hour: [0, 23],
  dom: [1, 31],
  month: [1, 12],
  dow: [0, 7], // 0 and 7 both mean Sunday; normalised to 0 below
}

// Case-insensitive three-letter names accepted in the month and day fields, so
// `JAN` and `MON-FRI` read the way a human writes a schedule.
const MONTH_NAMES = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}
const DAY_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

// Convenience macros (Vixie's `@`-shortcuts). Expanded to a plain 5-field
// expression before parsing so the rest of the engine only ever sees fields.
const MACROS = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
}

// Safety net for the field-stepping search: an impossible schedule (e.g. the
// 30th of February) never matches, so cap the number of advances and report the
// schedule as unreachable rather than spinning. 100k advances is a horizon of
// centuries — even a leap-day schedule that skips a non-leap century year
// (2100) settles in a few thousand day-steps, far inside the budget.
const MAX_STEPS = 100000

function fail(message) {
  throw new Error(`Invalid cron expression: ${message}`)
}

// Expand one field token into the sorted set of integers it allows. Handles
// `*`, `*/step`, `a`, `a-b`, `a-b/step`, `a/step` (an open-ended step from a),
// comma-separated lists of any of those, and named months/days. `restricted`
// (false only for a bare `*` or `*/1`-over-full-range) drives the DOM/DOW rule.
function parseField(token, [min, max], names, fieldName) {
  const values = new Set()
  let restricted = true

  for (const part of String(token).split(',')) {
    const piece = part.trim()
    if (piece === '') fail(`empty value in the ${fieldName} field`)

    // Split an optional /step suffix off the range/wildcard base.
    const [rangeSpec, stepSpec] = piece.split('/')
    let step = 1
    if (stepSpec !== undefined) {
      step = Number(stepSpec)
      if (!Number.isInteger(step) || step <= 0) fail(`"${piece}" has a non-positive step`)
    }

    let lo
    let hi
    if (rangeSpec === '*') {
      lo = min
      hi = max
      // `*` and `*/1` cover the whole range — the field is effectively
      // unrestricted, which the DOM/DOW OR-rule needs to know.
      if (stepSpec === undefined || step === 1) restricted = false
    } else {
      const bounds = rangeSpec.split('-')
      if (bounds.length > 2) fail(`"${piece}" is not a valid range`)
      lo = nameOrNumber(bounds[0], names, fieldName)
      hi = bounds.length === 2 ? nameOrNumber(bounds[1], names, fieldName) : lo
      // A single value with a step (`5/10`) counts from the value to the field
      // max, matching Vixie cron.
      if (bounds.length === 1 && stepSpec !== undefined) hi = max
    }

    if (lo < min || hi > max || lo > hi) {
      fail(`"${piece}" is out of range for the ${fieldName} field (${min}-${max})`)
    }
    for (let v = lo; v <= hi; v += step) values.add(v)
  }

  // Day-of-week accepts 7 as an alias for Sunday; fold it onto 0 so the matcher
  // can compare directly against Date#getUTCDay (0-6).
  if (fieldName === 'day-of-week' && values.has(7)) {
    values.delete(7)
    values.add(0)
  }
  return { values, restricted }
}

function nameOrNumber(token, names, fieldName) {
  const trimmed = token.trim()
  if (trimmed === '') fail(`empty value in the ${fieldName} field`)
  if (names) {
    const named = names[trimmed.toLowerCase()]
    if (named !== undefined) return named
  }
  const n = Number(trimmed)
  if (!Number.isInteger(n)) fail(`"${token}" is not a valid ${fieldName} value`)
  return n
}

// Parse a full expression into per-field allowed-value sets. Accepts the 5-field
// standard form and the 6-field form (seconds first, as node-cron allows), plus
// the `@`-macros. Throws with a readable message on anything malformed.
function parseCron(expression) {
  if (typeof expression !== 'string' || expression.trim() === '') {
    fail('expected a non-empty string')
  }
  const trimmed = expression.trim()
  const expanded = MACROS[trimmed.toLowerCase()] || trimmed
  const parts = expanded.split(/\s+/)
  if (parts.length !== 5 && parts.length !== 6) {
    fail(`expected 5 or 6 fields, got ${parts.length}`)
  }

  const hasSeconds = parts.length === 6
  const [secondTok, minuteTok, hourTok, domTok, monthTok, dowTok] = hasSeconds
    ? parts
    : [null, ...parts]

  const dom = parseField(domTok, FIELDS.dom, null, 'day-of-month')
  const dow = parseField(dowTok, FIELDS.dow, DAY_NAMES, 'day-of-week')

  return {
    hasSeconds,
    second: hasSeconds ? parseField(secondTok, FIELDS.second, null, 'second').values : null,
    minute: parseField(minuteTok, FIELDS.minute, null, 'minute').values,
    hour: parseField(hourTok, FIELDS.hour, null, 'hour').values,
    month: parseField(monthTok, FIELDS.month, MONTH_NAMES, 'month').values,
    dom: dom.values,
    dow: dow.values,
    domRestricted: dom.restricted,
    dowRestricted: dow.restricted,
  }
}

// The DOM/DOW OR-rule (see the file header). When both day fields are
// restricted, a date fires if either matches; when only one is, that one ANDs
// with the rest of the fields; when neither is, every day is a candidate.
function dayMatches(fields, date) {
  const domOk = fields.dom.has(date.getUTCDate())
  const dowOk = fields.dow.has(date.getUTCDay())
  if (fields.domRestricted && fields.dowRestricted) return domOk || dowOk
  if (fields.domRestricted) return domOk
  if (fields.dowRestricted) return dowOk
  return true
}

// The next instant strictly after `from` that the parsed schedule fires, or null
// if none is reachable within the step budget (an impossible calendar date).
function nextFrom(fields, from) {
  // Start at the next whole second/minute boundary strictly after `from`, so a
  // fire time exactly equal to `from` is not re-reported.
  let t = new Date(from.getTime())
  if (fields.hasSeconds) {
    t.setUTCMilliseconds(0)
    t = new Date(t.getTime() + 1000)
  } else {
    t.setUTCSeconds(0, 0)
    t = new Date(t.getTime() + 60000)
  }

  for (let steps = 0; steps < MAX_STEPS; steps++) {
    if (!fields.month.has(t.getUTCMonth() + 1)) {
      // Jump to 00:00:00 on the first of the next month.
      t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 1, 0, 0, 0))
      continue
    }
    if (!dayMatches(fields, t)) {
      // Jump to 00:00:00 of the next day.
      t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1, 0, 0, 0))
      continue
    }
    if (!fields.hour.has(t.getUTCHours())) {
      t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), t.getUTCHours() + 1, 0, 0))
      continue
    }
    if (!fields.minute.has(t.getUTCMinutes())) {
      t = new Date(t.getTime() + 60000)
      continue
    }
    if (fields.hasSeconds && !fields.second.has(t.getUTCSeconds())) {
      t = new Date(t.getTime() + 1000)
      continue
    }
    return t
  }
  return null
}

// The next `count` fire times strictly after `from` (default: now), as Date
// objects, oldest first. Stops early (returning fewer) if the schedule becomes
// unreachable — so an impossible expression yields [] rather than throwing.
function nextRuns(expression, count = 5, from = new Date()) {
  const fields = parseCron(expression)
  const n = Math.max(0, Math.min(Number(count) || 0, 100))
  const runs = []
  let cursor = from
  for (let i = 0; i < n; i++) {
    const next = nextFrom(fields, cursor)
    if (!next) break
    runs.push(next)
    cursor = next
  }
  return runs
}

// The single next fire time after `from`, or null if unreachable.
function nextRun(expression, from = new Date()) {
  return nextFrom(parseCron(expression), from)
}

// True if the expression parses. Mirrors node-cron's validate for the fields the
// scheduler uses, but is the same parser that computes the preview — so a
// schedule that previews is a schedule that runs.
function isValid(expression) {
  try {
    parseCron(expression)
    return true
  } catch {
    return false
  }
}

module.exports = { parseCron, nextRun, nextRuns, isValid }
