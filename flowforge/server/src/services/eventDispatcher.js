// Outbound webhooks: deliver workspace activity events to subscribed external
// URLs, Stripe-style. activityService.logEvent calls enqueueEvent for every
// fresh event; matching subscriptions each get a durable event_deliveries row,
// and a background poller (startDispatcher) drains due rows with retries.
//
// Design constraints:
// - **Durable, not in-memory.** The queue is the event_deliveries table, so a
//   restart never loses a delivery and the retry schedule survives the
//   process. Delivery is at-least-once; the delivery id is stable across
//   retries and redeliveries so consumers can deduplicate.
// - **Signed like inbound webhooks.** Every delivery carries the same
//   timestamped HMAC scheme webhook triggers verify (webhookSignature.js), so
//   the docs for verifying one apply to both directions.
// - **SSRF-guarded.** Subscription URLs are user input pointed at the server's
//   own network position: delivery goes through safeFetch (scheme +
//   private-range checks, re-applied per redirect hop), and the routes reject
//   blocked URLs at subscription time for a friendlier failure.

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const { computeSignature } = require('./webhookSignature')
const { safeFetch } = require('./ssrfGuard')

// All read live so tests (and deployments) can tune without re-requiring.
const maxAttempts = () => Math.max(1, parseInt(process.env.WEBHOOK_MAX_ATTEMPTS || '5', 10) || 5)
const retryBaseMs = () => Math.max(1, parseInt(process.env.WEBHOOK_RETRY_BASE_MS || '30000', 10) || 30000)
const deliveryTimeoutMs = () =>
  Math.max(100, parseInt(process.env.WEBHOOK_DELIVERY_TIMEOUT_MS || '10000', 10) || 10000)
const dispatchIntervalMs = () =>
  Math.max(250, parseInt(process.env.WEBHOOK_DISPATCH_INTERVAL_MS || '5000', 10) || 5000)

// Does a subscription pattern cover this event type? Three forms, mirroring
// the activity feed's category prefixes: exact ('execution.failed'), family
// ('execution.*'), and everything ('*').
function matchesPattern(pattern, eventType) {
  if (pattern === '*') return true
  if (typeof pattern !== 'string') return false
  if (pattern.endsWith('.*')) return eventType.startsWith(pattern.slice(0, -1))
  return pattern === eventType
}

// Queue a workspace event for every active subscription whose patterns match.
// Best-effort and self-contained (like logEvent itself): a dispatch problem
// must never break the action that produced the event.
function enqueueEvent(workspaceId, eventType, payload) {
  try {
    const subscriptions = db
      .prepare('SELECT id, events FROM event_subscriptions WHERE workspace_id = ? AND is_active = 1')
      .all(workspaceId)
    if (subscriptions.length === 0) return

    const now = new Date().toISOString()
    const insert = db.prepare(
      `INSERT INTO event_deliveries
         (id, subscription_id, event_type, payload_json, status, attempts, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`
    )
    for (const sub of subscriptions) {
      let patterns
      try {
        patterns = JSON.parse(sub.events)
      } catch {
        continue
      }
      if (!Array.isArray(patterns) || !patterns.some((p) => matchesPattern(p, eventType))) continue
      insert.run(uuidv4(), sub.id, eventType, JSON.stringify(payload ?? {}), now, now)
    }
  } catch (err) {
    console.error('eventDispatcher.enqueueEvent failed:', err.message)
  }
}

// POST one delivery to its subscription's URL and settle the row: 2xx marks it
// delivered; anything else schedules a retry with exponential backoff until
// the attempt budget runs out. Exported for tests and the redeliver route.
async function attemptDelivery(delivery) {
  const sub = db
    .prepare('SELECT * FROM event_subscriptions WHERE id = ?')
    .get(delivery.subscription_id)
  if (!sub || !sub.is_active) {
    // The subscription vanished (or was switched off) after this row was
    // queued — nothing sensible to retry against.
    db.prepare(
      "UPDATE event_deliveries SET status = 'failed', error = ? WHERE id = ?"
    ).run('Subscription removed or disabled', delivery.id)
    return
  }

  // The envelope consumers receive. The delivery id is stable across retries
  // and manual redeliveries — receivers deduplicate on it.
  const body = JSON.stringify({
    id: delivery.id,
    type: delivery.event_type,
    createdAt: delivery.created_at,
    data: JSON.parse(delivery.payload_json),
  })
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = `v1=${computeSignature(sub.secret, timestamp, Buffer.from(body))}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deliveryTimeoutMs())
  let outcome
  try {
    const res = await safeFetch(sub.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'FlowForge-Webhooks/1.0',
        'X-FlowForge-Event': delivery.event_type,
        'X-FlowForge-Delivery': delivery.id,
        'X-FlowForge-Timestamp': timestamp,
        'X-FlowForge-Signature': signature,
      },
      body,
      signal: controller.signal,
    })
    outcome = res.ok
      ? { ok: true, status: res.status }
      : { ok: false, status: res.status, error: `HTTP ${res.status}` }
  } catch (err) {
    outcome = { ok: false, status: null, error: err.name === 'AbortError' ? 'Delivery timed out' : err.message }
  } finally {
    clearTimeout(timer)
  }

  const now = new Date().toISOString()
  if (outcome.ok) {
    db.prepare(
      `UPDATE event_deliveries
          SET status = 'delivered', attempts = attempts + 1, response_status = ?,
              error = NULL, delivered_at = ?, next_attempt_at = NULL
        WHERE id = ?`
    ).run(outcome.status, now, delivery.id)
    return
  }

  const attempts = delivery.attempts + 1
  if (attempts >= maxAttempts()) {
    db.prepare(
      `UPDATE event_deliveries
          SET status = 'failed', attempts = ?, response_status = ?, error = ?, next_attempt_at = NULL
        WHERE id = ?`
    ).run(attempts, outcome.status, outcome.error, delivery.id)
    return
  }
  // 30s, 2m, 8m, 32m… — generous enough to ride out a receiver deploy without
  // holding a failed endpoint in the hot loop.
  const backoff = retryBaseMs() * 4 ** (attempts - 1)
  db.prepare(
    `UPDATE event_deliveries
        SET attempts = ?, response_status = ?, error = ?, next_attempt_at = ?
      WHERE id = ?`
  ).run(attempts, outcome.status, outcome.error, new Date(Date.now() + backoff).toISOString(), delivery.id)
}

// Drain due deliveries (oldest first). Returns how many were attempted so the
// tests — and the interval below — can tell whether there was work.
async function processDueDeliveries(limit = 20) {
  const due = db
    .prepare(
      `SELECT * FROM event_deliveries
        WHERE status = 'pending' AND next_attempt_at <= ?
        ORDER BY next_attempt_at LIMIT ?`
    )
    .all(new Date().toISOString(), limit)
  for (const delivery of due) {
    await attemptDelivery(delivery)
  }
  return due.length
}

// Background poller. Ticks never overlap (a slow receiver can outlast the
// interval) and the timer is unref'd so it never holds the process open.
let timer = null
let draining = false

function startDispatcher() {
  if (timer) return timer
  timer = setInterval(async () => {
    if (draining) return
    draining = true
    try {
      await processDueDeliveries()
    } catch (err) {
      console.error('eventDispatcher tick failed:', err.message)
    } finally {
      draining = false
    }
  }, dispatchIntervalMs())
  timer.unref()
  console.log('Outbound webhook dispatcher started')
  return timer
}

module.exports = {
  enqueueEvent,
  attemptDelivery,
  processDueDeliveries,
  startDispatcher,
  matchesPattern,
}
