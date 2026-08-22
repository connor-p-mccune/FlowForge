// Per-host retry budget: a cap on how much of a struggling host's load is
// FlowForge retrying it.
//
// The circuit breaker next door handles a host that is **down** — N consecutive
// failures and calls fast-fail until a probe says otherwise. It is the right
// control for that, and it is no help at all for the failure mode that actually
// takes services out, because that one never produces N consecutive failures.
//
// A host under strain fails *some* requests. Every failure is retried. Retries
// are additional load on the thing that is already struggling. More load means a
// higher failure rate, which means more retries, and the system that was at 90%
// success and recoverable is at 40% and not — while the breaker sits closed the
// whole time, because the host kept answering. Retries turned a brownout into an
// outage.
//
// The standard control (Google's SRE book, ch. 22) is a **retry budget**: cap
// retries as a fraction of the requests going to that host, so retrying can add
// at most a bounded percentage of extra load no matter how badly things are
// going. Ten percent, by default.
//
// Three properties are what make it different from the breaker rather than a
// second copy of it:
//
//   * It is a **ratio, not a count.** Ten retries against a thousand requests is
//     nothing; ten against forty is a problem. Only the ratio distinguishes
//     them, and only the ratio stays meaningful as traffic grows.
//   * The denominator is **shared across every caller.** An HTTP node's retries,
//     a Slack node's, and the outbound webhook dispatcher's all count against
//     one budget per host, because the host experiences one total load. A budget
//     each would be three budgets and no bound.
//   * It **suppresses the retry, never the request.** The first attempt always
//     goes out. Nothing is ever refused work it was asked to do; the run still
//     fails with the real error, and it fails a little sooner.
//
// A rolling window of fixed buckets, in memory, per process — the same
// engineering as the metrics registry and the circuit breaker. A budget that
// needed coordination between workers to be correct would be a distributed
// consensus problem attached to an optimisation.

const { counter } = require('./metrics')

// Bound memory: hosts come from user config, so the tracked set is capped and
// the oldest entry evicted. Losing a stale host's counts is harmless.
const MAX_TRACKED_HOSTS = 500

// The window is split into buckets so expiry is a pointer move rather than a
// scan of individual events.
const BUCKETS = 6

const hosts = new Map() // host -> { buckets: [{ requests, retries }], index, startedAt }

const retriesSuppressed = counter(
  'flowforge_retries_suppressed_total',
  'Retries not attempted because the target host was over its retry budget.'
)

// Enforcement mirrors the circuit breaker's switch, and for the same reason:
// suites deliberately hammer failing local servers, and a budget that engaged
// there would make every retry test depend on the order it ran in.
function enabled() {
  if (process.env.DISABLE_RETRY_BUDGET === 'true') return false
  if (process.env.NODE_ENV === 'test') return process.env.ENABLE_RETRY_BUDGET === 'true'
  return true
}

const windowMs = () => {
  const n = parseInt(process.env.RETRY_BUDGET_WINDOW_MS || '60000', 10)
  return Number.isFinite(n) && n >= 1000 ? n : 60000
}

// The fraction of a host's requests that may be retries.
const ratio = () => {
  const n = Number(process.env.RETRY_BUDGET_RATIO || '0.1')
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.1
}

// The floor under the budget, and the reason a low-traffic host is not
// permanently barred from retrying: 10% of three requests is 0.3 retries, i.e.
// none, forever. A workflow that fires once an hour would never retry anything,
// which is not a bound on cascading failure — it is a broken retry policy. The
// floor keeps the budget meaningful only where there is enough traffic for a
// ratio to mean anything.
const minRetries = () => {
  const n = parseInt(process.env.RETRY_BUDGET_MIN || '10', 10)
  return Number.isFinite(n) && n >= 0 ? n : 10
}

// hostname:port (port only when non-default), lowercased. Null for anything
// unparseable — a call with no identifiable host is simply not budgeted.
function hostKeyOf(rawUrl) {
  try {
    return new URL(rawUrl).host.toLowerCase() || null
  } catch {
    return null
  }
}

// The URL a node will call, for node types whose whole purpose is to call one.
//
// Deliberately narrow. A Transform node's retry costs nobody anything but a
// millisecond of CPU, and a sub-workflow's retry is bounded by its own nodes'
// budgets — so neither is budgeted here, and pretending otherwise would put a
// cascading-failure control in front of work that cannot cascade.
function egressUrlOf(node, config = {}) {
  const type = node?.type
  if (type === 'action-http') return config.url || null
  if (type === 'action-slack') return config.webhookUrl || null
  return null
}

function bucketsFor(key, now) {
  let entry = hosts.get(key)
  const span = windowMs() / BUCKETS
  if (!entry) {
    if (hosts.size >= MAX_TRACKED_HOSTS) hosts.delete(hosts.keys().next().value)
    entry = {
      buckets: Array.from({ length: BUCKETS }, () => ({ requests: 0, retries: 0 })),
      index: 0,
      startedAt: now,
    }
    hosts.set(key, entry)
    return entry
  }

  // Advance the ring by however many bucket spans have elapsed, clearing what
  // it passes. More than a full window means every bucket is stale, so the
  // history is simply dropped rather than walked.
  const elapsed = now - entry.startedAt
  const steps = Math.floor(elapsed / span)
  if (steps <= 0) return entry
  if (steps >= BUCKETS) {
    for (const bucket of entry.buckets) {
      bucket.requests = 0
      bucket.retries = 0
    }
    entry.index = 0
  } else {
    for (let i = 0; i < steps; i++) {
      entry.index = (entry.index + 1) % BUCKETS
      entry.buckets[entry.index].requests = 0
      entry.buckets[entry.index].retries = 0
    }
  }
  entry.startedAt += steps * span
  return entry
}

function totals(entry) {
  let requests = 0
  let retries = 0
  for (const bucket of entry.buckets) {
    requests += bucket.requests
    retries += bucket.retries
  }
  return { requests, retries }
}

// Called by the shared egress path for every outbound request, whoever made it.
// This is the denominator, and it has to come from one place or the ratio is
// measuring one caller's opinion of the host's load rather than the host's.
function recordRequest(rawUrl) {
  if (!enabled()) return
  const key = hostKeyOf(rawUrl)
  if (!key) return
  const entry = bucketsFor(key, Date.now())
  entry.buckets[entry.index].requests += 1
}

// Called when a retry is actually attempted. Separate from recordRequest
// because the retry *also* goes through the egress path and counts as a
// request there — a retry is both.
function recordRetry(rawUrl) {
  if (!enabled()) return
  const key = hostKeyOf(rawUrl)
  if (!key) return
  const entry = bucketsFor(key, Date.now())
  entry.buckets[entry.index].retries += 1
}

// May a retry against this host be attempted?
//
// Returns `{ allowed, requests, retries, budget }` — always allowed when the
// budget is disabled or the URL has no host, so a caller can consult it
// unconditionally.
function allowRetry(rawUrl) {
  if (!enabled()) return { allowed: true, requests: 0, retries: 0, budget: Infinity }
  const key = hostKeyOf(rawUrl)
  if (!key) return { allowed: true, requests: 0, retries: 0, budget: Infinity }

  const entry = bucketsFor(key, Date.now())
  const { requests, retries } = totals(entry)
  const budget = Math.max(minRetries(), Math.floor(ratio() * requests))
  const allowed = retries < budget
  if (!allowed) retriesSuppressed.inc({})
  return { allowed, requests, retries, budget, host: key }
}

// A sentence for the error the run will fail with. The underlying failure is
// the real cause and is never replaced — this is appended, so the message says
// both what broke and why it was not tried again.
function suppressionNote(state) {
  return (
    `retries suppressed: ${state.host} is over its retry budget ` +
    `(${state.retries} retries against ${state.requests} requests in the last ` +
    `${Math.round(windowMs() / 1000)}s, budget ${state.budget})`
  )
}

// Test hook: forget every host, so suites cannot leak state into each other.
function reset() {
  hosts.clear()
}

module.exports = {
  enabled,
  hostKeyOf,
  egressUrlOf,
  recordRequest,
  recordRetry,
  allowRetry,
  suppressionNote,
  reset,
  BUCKETS,
}
