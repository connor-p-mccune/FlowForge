// Zero-dependency structured logger. One JSON line per event on stdout —
// machine-parseable by any log shipper — with a human 'pretty' mode for local
// dev (LOG_FORMAT=pretty). The app needs leveled, field-structured lines with
// child loggers, not a logging framework; like metrics.js, that's ~80 lines.
//
// LOG_LEVEL: debug | info | warn | error | silent. Defaults to info, except
// under NODE_ENV=test where it defaults to silent so suites stay readable
// (set LOG_LEVEL explicitly to see logs in a test). Read per call, so tests
// and operators can flip it without re-requiring the module.
//
// Logging must never break the request it describes: serialization failures
// degrade to a stub line instead of throwing, Error values flatten to their
// message, and circular references are dropped.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 }

function activeLevel() {
  const raw = (process.env.LOG_LEVEL || '').toLowerCase()
  if (raw in LEVELS) return LEVELS[raw]
  return process.env.NODE_ENV === 'test' ? LEVELS.silent : LEVELS.info
}

// Injectable for tests; defaults to stdout.
let sink = (line) => process.stdout.write(line + '\n')

// JSON.stringify replacer: flatten Errors, drop circular references.
function makeReplacer() {
  const seen = new WeakSet()
  return (_key, value) => {
    if (value instanceof Error) return { message: value.message }
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[circular]'
      seen.add(value)
    }
    return value
  }
}

function serialize(level, msg, fields) {
  if (process.env.LOG_FORMAT === 'pretty') {
    const kv = Object.entries(fields)
      .map(([k, v]) => `${k}=${typeof v === 'object' && v !== null ? JSON.stringify(v, makeReplacer()) : v}`)
      .join(' ')
    return `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${kv ? ' ' + kv : ''}`
  }
  return JSON.stringify({ level, time: new Date().toISOString(), msg, ...fields }, makeReplacer())
}

function makeLogger(bound = {}) {
  const emit = (level) => (msg, fields = {}) => {
    if (LEVELS[level] < activeLevel()) return
    let line
    try {
      line = serialize(level, msg, { ...bound, ...fields })
    } catch {
      line = serialize(level, msg, { ...bound, unserializableFields: true })
    }
    sink(line)
  }
  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    // A logger with extra fields bound to every line (e.g. a request id).
    child(fields) {
      return makeLogger({ ...bound, ...fields })
    },
  }
}

const logger = makeLogger()

// Test hook: capture lines instead of writing them. Returns the old sink so a
// test can restore it.
logger._setSink = (fn) => {
  const prev = sink
  sink = fn
  return prev
}

module.exports = logger
