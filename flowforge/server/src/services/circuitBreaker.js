// Per-host circuit breaker for outbound HTTP. When a host keeps failing,
// continuing to call it makes everything worse: node retries stack connect
// timeouts, run slots sit occupied waiting on a dead API, and the webhook
// dispatcher burns its attempt budget against a receiver that is down. The
// breaker turns that into a fast, honest failure: after N consecutive
// failures to one host the circuit *opens* and calls fail immediately; after
// a cooldown a single probe request is let through (half-open) — its success
// closes the circuit, its failure re-opens it for another cooldown.
//
// Wrapped around safeFetch (ssrfGuard.js), which is the one egress path the
// HTTP node, the Slack node, and outbound webhook deliveries all share — so
// one integration point protects every server-side fetch of a user-supplied
// URL. Scoped per host (hostname:port): one flaky API can't fast-fail calls
// to a healthy one, and a redirect chain attributes its outcome to the host
// the caller asked for.
//
// What counts as a failure: the fetch rejecting (connect refused, reset,
// DNS, timeout) or a 5xx response — the signals that say "this host is
// unhealthy". 4xx is the caller's problem and says nothing about host
// health, so it counts as a success here (the caller still sees the real
// response either way; the breaker only observes).
//
// Enforcement mirrors the SSRF guard's switch: on in dev and production,
// skipped under NODE_ENV=test by default (suites deliberately hammer failing
// local servers) unless a suite opts in with ENABLE_CIRCUIT_BREAKER=true;
// DISABLE_CIRCUIT_BREAKER=true turns it off anywhere. Read live per call.

const { counter, gauge, registerCollector } = require('./metrics')

// Bound memory: hosts are user-supplied, so the tracked set is capped and the
// oldest entry is evicted — losing a stale host's count is harmless.
const MAX_TRACKED_HOSTS = 500
const circuits = new Map() // host -> { state, failures, openedAt, probing }

const circuitTrips = counter(
  'flowforge_circuit_trips_total',
  'Outbound circuits tripped open (a host crossed the consecutive-failure threshold).'
)

const circuitsOpen = gauge(
  'flowforge_circuits_open',
  'Hosts whose outbound circuit is currently open, sampled at scrape time.'
)

registerCollector(() => {
  let open = 0
  for (const entry of circuits.values()) if (entry.state === 'open') open++
  circuitsOpen.set({}, open)
})

function enabled() {
  if (process.env.DISABLE_CIRCUIT_BREAKER === 'true') return false
  if (process.env.NODE_ENV === 'test') return process.env.ENABLE_CIRCUIT_BREAKER === 'true'
  return true
}

function threshold() {
  const n = parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD || '5', 10)
  return Number.isFinite(n) && n >= 1 ? n : 5
}

function cooldownMs() {
  const n = parseInt(process.env.CIRCUIT_BREAKER_COOLDOWN_MS || '30000', 10)
  return Number.isFinite(n) && n >= 0 ? n : 30000
}

// hostname:port (port only when non-default), lowercased. Null for an
// unparseable URL — the wrapped call will produce the real error itself.
function hostKeyOf(rawUrl) {
  try {
    return new URL(rawUrl).host.toLowerCase() || null
  } catch {
    return null
  }
}

function entryFor(key) {
  let entry = circuits.get(key)
  if (!entry) {
    if (circuits.size >= MAX_TRACKED_HOSTS) circuits.delete(circuits.keys().next().value)
    entry = { state: 'closed', failures: 0, openedAt: 0, probing: false }
    circuits.set(key, entry)
  }
  return entry
}

function recordSuccess(entry) {
  entry.failures = 0
  entry.state = 'closed'
}

function recordFailure(entry) {
  entry.failures++
  if (entry.state === 'open') {
    // A failed half-open probe: stay open for a fresh cooldown.
    entry.openedAt = Date.now()
  } else if (entry.failures >= threshold()) {
    entry.state = 'open'
    entry.openedAt = Date.now()
    circuitTrips.inc({})
  }
}

// Run fn() under the host's circuit. Fast-fails with a descriptive error when
// the circuit is open; otherwise observes the outcome (a rejection or a 5xx
// response counts as a failure) without altering what the caller receives.
async function withCircuit(rawUrl, fn) {
  if (!enabled()) return fn()
  const key = hostKeyOf(rawUrl)
  if (!key) return fn()
  const entry = entryFor(key)

  if (entry.state === 'open') {
    const remainingMs = entry.openedAt + cooldownMs() - Date.now()
    if (remainingMs > 0 || entry.probing) {
      const why = entry.probing
        ? 'a probe is already in flight'
        : `retrying in ${Math.max(1, Math.ceil(remainingMs / 1000))}s`
      throw new Error(
        `Circuit breaker: "${key}" is unavailable after ${entry.failures} consecutive failures — ${why}`
      )
    }
    // Cooldown elapsed: this call becomes the half-open probe. Concurrent
    // callers keep fast-failing until it settles.
    entry.probing = true
  }

  try {
    const result = await fn()
    if (result && typeof result.status === 'number' && result.status >= 500) {
      recordFailure(entry)
    } else {
      recordSuccess(entry)
    }
    return result
  } catch (err) {
    recordFailure(entry)
    throw err
  } finally {
    entry.probing = false
  }
}

// Test hook: forget every circuit so suites can't leak state into each other.
function resetCircuits() {
  circuits.clear()
}

module.exports = { withCircuit, resetCircuits, enabled }
