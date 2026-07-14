// The FXL standard library: a curated set of pure, first-order helper functions
// callable from an expression (`upper(name)`, `len(items)`, `round(x, 2)`).
//
// Two deliberate constraints keep the surface safe and predictable:
//   1. Every function is a plain, side-effect-free JS function defined here — an
//      expression can only reach names in this table, never a method on a value
//      or anything on the host. There is no `map`/`filter` taking a callback,
//      because FXL has no lambdas; higher-order iteration would need closures
//      and an escape hatch this language intentionally doesn't have.
//   2. Each function validates its own arity/arguments and throws an
//      ExpressionError with a readable message, so a misused function fails the
//      same friendly way a syntax error does.
//
// The registry is exported both as callable implementations (for the evaluator)
// and as lightweight signatures (for docs and the editor's autocomplete).

const { ExpressionError } = require('./errors')

function fail(message) {
  throw new ExpressionError(message)
}

function num(value, fnName) {
  const n = typeof value === 'boolean' ? Number(value) : Number(value)
  if (typeof value === 'string' && value.trim() === '') fail(`${fnName}: expected a number`)
  if (!Number.isFinite(n)) fail(`${fnName}: expected a number`)
  return n
}

function str(value) {
  if (value == null) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function requireArray(value, fnName) {
  if (!Array.isArray(value)) fail(`${fnName}: expected an array`)
  return value
}

// isEmpty / truthiness treat null, '', [], and {} as empty — the intuition a
// rules author has for "is this field filled in".
function isEmpty(value) {
  if (value == null) return true
  if (typeof value === 'string') return value.length === 0
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value).length === 0
  return false
}

// Walk a dotted path (`a.b.c`) through nested objects/arrays, guarding the same
// dangerous keys the evaluator's member access blocks.
const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
function getPath(target, path) {
  if (target == null) return undefined
  const parts = String(path).split('.')
  let current = target
  for (const part of parts) {
    if (current == null || BLOCKED_KEYS.has(part)) return undefined
    current = current[part]
  }
  return current
}

// { name: [minArgs, maxArgs, implementation] }. maxArgs Infinity = variadic.
const registry = {
  // — type + coalescing —
  type: [1, 1, (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)],
  string: [1, 1, (v) => str(v)],
  number: [1, 1, (v) => num(v, 'number')],
  bool: [1, 1, (v) => toBool(v)],
  isEmpty: [1, 1, (v) => isEmpty(v)],
  // default(value, fallback): fallback when value is null/undefined only.
  default: [2, 2, (v, d) => (v == null ? d : v)],
  // coalesce(...values): first non-null, non-empty value.
  coalesce: [1, Infinity, (...vals) => vals.find((v) => !isEmpty(v)) ?? null],
  json: [1, 1, (v) => JSON.stringify(v)],
  parseJson: [1, 1, (v) => {
    try { return JSON.parse(str(v)) } catch { fail('parseJson: invalid JSON') }
  }],

  // — length works across strings, arrays, and objects —
  len: [1, 1, (v) => {
    if (v == null) return 0
    if (typeof v === 'string' || Array.isArray(v)) return v.length
    if (typeof v === 'object') return Object.keys(v).length
    return 0
  }],

  // — strings —
  upper: [1, 1, (v) => str(v).toUpperCase()],
  lower: [1, 1, (v) => str(v).toLowerCase()],
  trim: [1, 1, (v) => str(v).trim()],
  contains: [2, 2, (v, sub) => {
    if (Array.isArray(v)) return v.includes(sub)
    return str(v).includes(str(sub))
  }],
  startsWith: [2, 2, (v, p) => str(v).startsWith(str(p))],
  endsWith: [2, 2, (v, s) => str(v).endsWith(str(s))],
  replace: [3, 3, (v, a, b) => str(v).split(str(a)).join(str(b))],
  split: [2, 2, (v, sep) => str(v).split(str(sep))],
  substr: [2, 3, (v, start, end) => str(v).slice(num(start, 'substr'), end === undefined ? undefined : num(end, 'substr'))],
  padStart: [2, 3, (v, width, pad) => str(v).padStart(num(width, 'padStart'), pad === undefined ? ' ' : str(pad))],
  padEnd: [2, 3, (v, width, pad) => str(v).padEnd(num(width, 'padEnd'), pad === undefined ? ' ' : str(pad))],
  indexOf: [2, 2, (v, sub) => (Array.isArray(v) ? v.indexOf(sub) : str(v).indexOf(str(sub)))],

  // — numbers / math —
  abs: [1, 1, (v) => Math.abs(num(v, 'abs'))],
  round: [1, 2, (v, digits) => {
    const d = digits === undefined ? 0 : num(digits, 'round')
    const f = 10 ** d
    return Math.round(num(v, 'round') * f) / f
  }],
  floor: [1, 1, (v) => Math.floor(num(v, 'floor'))],
  ceil: [1, 1, (v) => Math.ceil(num(v, 'ceil'))],
  sqrt: [1, 1, (v) => Math.sqrt(num(v, 'sqrt'))],
  pow: [2, 2, (v, e) => num(v, 'pow') ** num(e, 'pow')],
  min: [1, Infinity, (...vals) => Math.min(...flattenNums(vals, 'min'))],
  max: [1, Infinity, (...vals) => Math.max(...flattenNums(vals, 'max'))],
  clamp: [3, 3, (v, lo, hi) => Math.min(Math.max(num(v, 'clamp'), num(lo, 'clamp')), num(hi, 'clamp'))],
  sum: [1, 1, (arr) => requireArray(arr, 'sum').reduce((a, b) => a + num(b, 'sum'), 0)],
  avg: [1, 1, (arr) => {
    const a = requireArray(arr, 'avg')
    if (a.length === 0) return 0
    return a.reduce((s, b) => s + num(b, 'avg'), 0) / a.length
  }],

  // — arrays —
  first: [1, 1, (arr) => requireArray(arr, 'first')[0]],
  last: [1, 1, (arr) => { const a = requireArray(arr, 'last'); return a[a.length - 1] }],
  join: [2, 2, (arr, sep) => requireArray(arr, 'join').map(str).join(str(sep))],
  reverse: [1, 1, (arr) => [...requireArray(arr, 'reverse')].reverse()],
  sort: [1, 1, (arr) => [...requireArray(arr, 'sort')].sort((a, b) => {
    if (typeof a === 'number' && typeof b === 'number') return a - b
    return str(a) < str(b) ? -1 : str(a) > str(b) ? 1 : 0
  })],
  unique: [1, 1, (arr) => [...new Set(requireArray(arr, 'unique'))]],
  slice: [2, 3, (arr, start, end) => {
    if (typeof arr === 'string') return arr.slice(num(start, 'slice'), end === undefined ? undefined : num(end, 'slice'))
    return requireArray(arr, 'slice').slice(num(start, 'slice'), end === undefined ? undefined : num(end, 'slice'))
  }],

  // — objects —
  keys: [1, 1, (obj) => (obj && typeof obj === 'object' ? Object.keys(obj) : [])],
  values: [1, 1, (obj) => (obj && typeof obj === 'object' ? Object.values(obj) : [])],
  has: [2, 2, (obj, key) => (obj && typeof obj === 'object'
    ? Object.prototype.hasOwnProperty.call(obj, str(key))
    : false)],
  get: [2, 3, (obj, path, fallback) => {
    const found = getPath(obj, path)
    return found === undefined ? (fallback ?? null) : found
  }],

  // — time — a run's "now", so a rule can compare against the clock —
  now: [0, 0, () => new Date().toISOString()],
  nowMs: [0, 0, () => Date.now()],

  // — dates — pure, deterministic helpers over ISO-8601 / epoch-ms timestamps,
  // so a rule can reason about ages and windows ("older than 7 days", "due this
  // hour") without pulling a date library into the sandbox. All component
  // accessors read UTC, matching the cron engine, so a rule behaves the same
  // regardless of the server's timezone.
  parseDate: [1, 1, (v) => toDate(v, 'parseDate').toISOString()],
  year: [1, 1, (v) => toDate(v, 'year').getUTCFullYear()],
  // month is 1-12 (not JS's 0-11), matching how a human writes a date.
  month: [1, 1, (v) => toDate(v, 'month').getUTCMonth() + 1],
  day: [1, 1, (v) => toDate(v, 'day').getUTCDate()],
  hour: [1, 1, (v) => toDate(v, 'hour').getUTCHours()],
  minute: [1, 1, (v) => toDate(v, 'minute').getUTCMinutes()],
  // weekday is 0-6 with Sunday = 0, matching Date#getUTCDay and cron's dow.
  weekday: [1, 1, (v) => toDate(v, 'weekday').getUTCDay()],
  // dateAdd(when, amount, unit) → ISO string. unit ∈ seconds|minutes|hours|days.
  dateAdd: [3, 3, (v, amount, unit) => {
    const base = toDate(v, 'dateAdd').getTime()
    return new Date(base + num(amount, 'dateAdd') * unitMs(unit, 'dateAdd')).toISOString()
  }],
  // dateDiff(a, b, unit) → (b − a) expressed in unit (may be fractional).
  dateDiff: [3, 3, (a, b, unit) => {
    const ms = toDate(b, 'dateDiff').getTime() - toDate(a, 'dateDiff').getTime()
    return ms / unitMs(unit, 'dateDiff')
  }],
  isBefore: [2, 2, (a, b) => toDate(a, 'isBefore').getTime() < toDate(b, 'isBefore').getTime()],
  isAfter: [2, 2, (a, b) => toDate(a, 'isAfter').getTime() > toDate(b, 'isAfter').getTime()],
}

// Coerce an FXL value to a Date. Accepts an ISO-8601 string or epoch
// milliseconds (number). Throws a readable error on anything unparseable, so a
// bad timestamp fails the same friendly way a misused function does.
function toDate(value, fnName) {
  if (typeof value === 'number') {
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) fail(`${fnName}: invalid timestamp`)
    return d
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const ms = Date.parse(value)
    if (Number.isNaN(ms)) fail(`${fnName}: "${value}" is not a valid date`)
    return new Date(ms)
  }
  fail(`${fnName}: expected an ISO date string or epoch milliseconds`)
}

// Milliseconds per supported unit for dateAdd/dateDiff.
const UNIT_MS = { seconds: 1000, minutes: 60000, hours: 3600000, days: 86400000 }
function unitMs(unit, fnName) {
  const ms = UNIT_MS[String(unit)]
  if (!ms) fail(`${fnName}: unit must be one of ${Object.keys(UNIT_MS).join(', ')}`)
  return ms
}

// Shared truthiness used by the evaluator's logical operators and bool().
// Falsy: false, null/undefined, 0, NaN, '' — everything else is truthy.
function toBool(value) {
  if (typeof value === 'string') return value.length > 0
  return Boolean(value)
}

// min/max accept either loose args (min(1,2,3)) or a single array (min([1,2,3])).
function flattenNums(vals, fnName) {
  const source = vals.length === 1 && Array.isArray(vals[0]) ? vals[0] : vals
  return source.map((v) => num(v, fnName))
}

// Look up and arity-check a function by name, returning the raw implementation.
function resolveFunction(name) {
  if (!Object.prototype.hasOwnProperty.call(registry, name)) {
    throw new ExpressionError(`Unknown function "${name}"`)
  }
  return registry[name]
}

function callFunction(name, args) {
  const [minArgs, maxArgs, impl] = resolveFunction(name)
  if (args.length < minArgs || args.length > maxArgs) {
    const range = minArgs === maxArgs
      ? `${minArgs}`
      : maxArgs === Infinity
        ? `at least ${minArgs}`
        : `${minArgs}–${maxArgs}`
    throw new ExpressionError(`${name}() expects ${range} argument(s), got ${args.length}`)
  }
  return impl(...args)
}

// Names only, for the linter / editor. (Signatures live in docs/EXPRESSIONS.md.)
const FUNCTION_NAMES = Object.keys(registry).sort()

module.exports = { callFunction, toBool, isEmpty, getPath, FUNCTION_NAMES }
