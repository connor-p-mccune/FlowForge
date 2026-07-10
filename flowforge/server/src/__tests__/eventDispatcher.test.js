// Outbound webhooks: pattern matching, the durable delivery queue, HMAC
// signing over the wire payload, retry/backoff scheduling, and the hook that
// fans activity events out to subscriptions. The subscription management
// routes have their own suite (eventSubscriptions.test.js).

const http = require('http')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'
process.env.WEBHOOK_MAX_ATTEMPTS = '2'
process.env.WEBHOOK_RETRY_BASE_MS = '60000'

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const dispatcher = require('../services/eventDispatcher')
const { verifyWebhookSignature } = require('../services/webhookSignature')
const activityService = require('../services/activityService')

// Minimal rows to satisfy foreign keys — these tests exercise the dispatcher
// directly, not the HTTP surface.
const userId = uuidv4()
const workspaceId = uuidv4()
db.prepare(
  "INSERT INTO users (id, email, password_hash, display_name) VALUES (?, 'dispatch@example.com', 'x', 'Dispatcher')"
).run(userId)
db.prepare('INSERT INTO workspaces (id, name, created_by) VALUES (?, ?, ?)').run(
  workspaceId, 'Dispatch WS', userId
)

function createSubscription({ events = ['*'], active = 1, url = 'http://127.0.0.1:1/unused', secret = 'whsec_testsecret' } = {}) {
  const id = uuidv4()
  db.prepare(
    `INSERT INTO event_subscriptions (id, workspace_id, url, events, secret, is_active, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, workspaceId, url, JSON.stringify(events), secret, active, userId)
  return id
}

const deliveriesFor = (subscriptionId) =>
  db.prepare('SELECT * FROM event_deliveries WHERE subscription_id = ? ORDER BY created_at').all(subscriptionId)

afterEach(() => {
  db.prepare('DELETE FROM event_deliveries').run()
  db.prepare('DELETE FROM event_subscriptions').run()
})

// One-shot local receiver: records the request, answers with `status`.
function listen(status = 200) {
  return new Promise((resolve) => {
    const requests = []
    const server = http.createServer((req, res) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        requests.push({ headers: req.headers, body: Buffer.concat(chunks) })
        res.writeHead(status).end()
      })
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/hook`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

describe('matchesPattern', () => {
  it.each([
    ['*', 'execution.failed', true],
    ['execution.*', 'execution.failed', true],
    ['execution.*', 'workflow.deployed', false],
    ['execution.failed', 'execution.failed', true],
    ['execution.failed', 'execution.completed', false],
  ])('%s vs %s → %s', (pattern, type, expected) => {
    expect(dispatcher.matchesPattern(pattern, type)).toBe(expected)
  })
})

describe('enqueueEvent', () => {
  it('queues one delivery per matching active subscription', () => {
    const matching = createSubscription({ events: ['execution.*'] })
    const exact = createSubscription({ events: ['execution.failed'] })
    const other = createSubscription({ events: ['workflow.*'] })
    const disabled = createSubscription({ events: ['*'], active: 0 })

    dispatcher.enqueueEvent(workspaceId, 'execution.failed', { hello: 'world' })

    expect(deliveriesFor(matching)).toHaveLength(1)
    expect(deliveriesFor(exact)).toHaveLength(1)
    expect(deliveriesFor(other)).toHaveLength(0)
    expect(deliveriesFor(disabled)).toHaveLength(0)

    const row = deliveriesFor(matching)[0]
    expect(row.status).toBe('pending')
    expect(JSON.parse(row.payload_json)).toEqual({ hello: 'world' })
  })

  it('is fed by activityService.logEvent', () => {
    const sub = createSubscription({ events: ['workflow.*'] })
    activityService.logEvent(workspaceId, userId, 'workflow.deployed', {
      type: 'workflow',
      id: 'wf-1',
      name: 'Release',
    })
    const rows = deliveriesFor(sub)
    expect(rows).toHaveLength(1)
    const payload = JSON.parse(rows[0].payload_json)
    expect(payload.event_type).toBe('workflow.deployed')
    expect(payload.entity_name).toBe('Release')
    expect(payload.actor_display_name).toBe('Dispatcher')
  })
})

describe('attemptDelivery', () => {
  it('POSTs a signed envelope and marks the row delivered', async () => {
    const receiver = await listen(200)
    const secret = 'whsec_signing'
    const sub = createSubscription({ url: receiver.url, secret })
    dispatcher.enqueueEvent(workspaceId, 'execution.completed', { runId: 'r1' })

    const [delivery] = deliveriesFor(sub)
    await dispatcher.attemptDelivery(delivery)
    await receiver.close()

    expect(receiver.requests).toHaveLength(1)
    const { headers, body } = receiver.requests[0]
    const envelope = JSON.parse(body.toString())
    expect(envelope).toMatchObject({
      id: delivery.id,
      type: 'execution.completed',
      data: { runId: 'r1' },
    })
    expect(headers['x-flowforge-event']).toBe('execution.completed')
    expect(headers['x-flowforge-delivery']).toBe(delivery.id)

    // The signature verifies with the same helper inbound webhooks use.
    expect(
      verifyWebhookSignature({
        secret,
        timestampHeader: headers['x-flowforge-timestamp'],
        signatureHeader: headers['x-flowforge-signature'],
        rawBody: body,
      })
    ).toEqual({ ok: true })

    const settled = deliveriesFor(sub)[0]
    expect(settled.status).toBe('delivered')
    expect(settled.response_status).toBe(200)
    expect(settled.attempts).toBe(1)
    expect(settled.delivered_at).toBeTruthy()
  })

  it('schedules a backoff retry on failure, then gives up at the attempt cap', async () => {
    const receiver = await listen(500)
    const sub = createSubscription({ url: receiver.url })
    dispatcher.enqueueEvent(workspaceId, 'execution.failed', {})

    await dispatcher.attemptDelivery(deliveriesFor(sub)[0])
    let row = deliveriesFor(sub)[0]
    expect(row.status).toBe('pending')
    expect(row.attempts).toBe(1)
    expect(row.error).toBe('HTTP 500')
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now())

    // WEBHOOK_MAX_ATTEMPTS=2 — the next failure is terminal.
    await dispatcher.attemptDelivery(row)
    await receiver.close()
    row = deliveriesFor(sub)[0]
    expect(row.status).toBe('failed')
    expect(row.attempts).toBe(2)
    expect(row.next_attempt_at).toBeNull()
  })

  it('fails cleanly when the subscription was removed or disabled', async () => {
    const sub = createSubscription()
    dispatcher.enqueueEvent(workspaceId, 'execution.failed', {})
    db.prepare('UPDATE event_subscriptions SET is_active = 0 WHERE id = ?').run(sub)

    await dispatcher.attemptDelivery(deliveriesFor(sub)[0])
    const row = deliveriesFor(sub)[0]
    expect(row.status).toBe('failed')
    expect(row.error).toMatch(/removed or disabled/)
  })
})

describe('delivery metrics', () => {
  it('counts delivered, retried, and terminally failed attempts by outcome', async () => {
    const { renderPrometheus } = require('../services/metrics')
    const receiver = await listen(200)
    const good = createSubscription({ url: receiver.url })
    dispatcher.enqueueEvent(workspaceId, 'execution.completed', {})
    await dispatcher.attemptDelivery(deliveriesFor(good)[0])
    await receiver.close()

    const dead = await listen(500)
    const failing = createSubscription({ url: dead.url })
    dispatcher.enqueueEvent(workspaceId, 'execution.failed', {})
    await dispatcher.attemptDelivery(deliveriesFor(failing)[0]) // retry scheduled
    await dispatcher.attemptDelivery(deliveriesFor(failing)[0]) // attempt cap (2) → failed
    await dead.close()

    const text = await renderPrometheus()
    expect(text).toMatch(/flowforge_webhook_deliveries_total\{outcome="delivered"\} \d+/)
    expect(text).toMatch(/flowforge_webhook_deliveries_total\{outcome="retried"\} \d+/)
    expect(text).toMatch(/flowforge_webhook_deliveries_total\{outcome="failed"\} \d+/)
  })
})

describe('processDueDeliveries', () => {
  it('attempts only rows whose next_attempt_at has arrived', async () => {
    const receiver = await listen(200)
    const sub = createSubscription({ url: receiver.url })
    dispatcher.enqueueEvent(workspaceId, 'execution.completed', { n: 1 })
    dispatcher.enqueueEvent(workspaceId, 'execution.completed', { n: 2 })

    // Push the second one into the future.
    const rows = deliveriesFor(sub)
    db.prepare('UPDATE event_deliveries SET next_attempt_at = ? WHERE id = ?').run(
      new Date(Date.now() + 60_000).toISOString(), rows[1].id
    )

    const attempted = await dispatcher.processDueDeliveries()
    await receiver.close()
    expect(attempted).toBe(1)
    const after = deliveriesFor(sub)
    expect(after[0].status).toBe('delivered')
    expect(after[1].status).toBe('pending')
  })
})
