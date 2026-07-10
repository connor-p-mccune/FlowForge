// Outbound webhook subscription routes: CRUD with owner-only writes, the
// show-once signing secret, URL/pattern validation (including the SSRF guard
// opt-in), the delivery log, manual redelivery, and the test ping.

const http = require('http')
const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'
process.env.WEBHOOK_MAX_ATTEMPTS = '2'

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))
jest.mock('../config/redis', () => ({ publish: jest.fn().mockResolvedValue(1) }))

const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')
const activityService = require('../services/activityService')

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

describe('event subscription routes', () => {
  let ownerToken
  let memberToken
  let outsiderToken
  let workspaceId

  beforeAll(async () => {
    const owner = await request(app)
      .post('/api/auth/register')
      .send({ email: 'sub-owner@example.com', password: 'password123', displayName: 'Owner' })
    ownerToken = owner.body.token
    const member = await request(app)
      .post('/api/auth/register')
      .send({ email: 'sub-member@example.com', password: 'password123', displayName: 'Member' })
    memberToken = member.body.token
    const outsider = await request(app)
      .post('/api/auth/register')
      .send({ email: 'sub-outsider@example.com', password: 'password123', displayName: 'Outsider' })
    outsiderToken = outsider.body.token

    const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${ownerToken}`)
    workspaceId = ws.body.workspaces[0].id
    await request(app)
      .post(`/api/workspaces/${workspaceId}/members`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'sub-member@example.com' })
  })

  afterEach(() => {
    db.prepare('DELETE FROM event_deliveries').run()
    db.prepare('DELETE FROM event_subscriptions').run()
  })

  function create(body = {}, token = ownerToken) {
    return request(app)
      .post(`/api/workspaces/${workspaceId}/subscriptions`)
      .set('Authorization', `Bearer ${token}`)
      .send({ url: 'https://example.com/hooks', events: ['execution.*'], ...body })
  }

  it('creates a subscription, showing the signing secret exactly once', async () => {
    const res = await create({ description: 'CI notifications' })
    expect(res.status).toBe(201)
    expect(res.body.subscription.secret).toMatch(/^whsec_[0-9a-f]{48}$/)
    expect(res.body.subscription.events).toEqual(['execution.*'])
    expect(res.body.subscription.isActive).toBe(true)

    const list = await request(app)
      .get(`/api/workspaces/${workspaceId}/subscriptions`)
      .set('Authorization', `Bearer ${memberToken}`)
    expect(list.status).toBe(200)
    expect(list.body.subscriptions).toHaveLength(1)
    const listed = list.body.subscriptions[0]
    expect(listed.secret).toBeUndefined()
    expect(listed.deliveredCount).toBe(0)
    expect(listed.failedCount).toBe(0)
    expect(listed.createdByName).toBe('Owner')
  })

  it('validates url and event patterns', async () => {
    expect((await create({ url: '' })).status).toBe(400)
    expect((await create({ url: 'ftp://example.com/x' })).status).toBe(400)
    expect((await create({ events: [] })).status).toBe(400)
    expect((await create({ events: ['not a pattern!'] })).status).toBe(400)
    expect((await create({ events: ['workflow.deployed', '*'] })).status).toBe(201)
  })

  it('rejects private-network URLs when the SSRF guard is enforced', async () => {
    process.env.ENABLE_SSRF_GUARD = 'true'
    try {
      const res = await create({ url: 'http://169.254.169.254/latest/meta-data' })
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/SSRF protection/)
    } finally {
      delete process.env.ENABLE_SSRF_GUARD
    }
  })

  it('gates writes to owners: members 403, outsiders 404', async () => {
    expect((await create({}, memberToken)).status).toBe(403)
    expect((await create({}, outsiderToken)).status).toBe(404)

    const created = await create()
    const id = created.body.subscription.id
    const patch = await request(app)
      .patch(`/api/workspaces/${workspaceId}/subscriptions/${id}`)
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ isActive: false })
    expect(patch.status).toBe(403)
  })

  it('pauses, edits, and deletes a subscription', async () => {
    const created = await create()
    const id = created.body.subscription.id

    const paused = await request(app)
      .patch(`/api/workspaces/${workspaceId}/subscriptions/${id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ isActive: false, events: ['workflow.*'], description: 'paused for now' })
    expect(paused.status).toBe(200)
    expect(paused.body.subscription.isActive).toBe(false)
    expect(paused.body.subscription.events).toEqual(['workflow.*'])

    const empty = await request(app)
      .patch(`/api/workspaces/${workspaceId}/subscriptions/${id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({})
    expect(empty.status).toBe(400)

    const del = await request(app)
      .delete(`/api/workspaces/${workspaceId}/subscriptions/${id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
    expect(del.status).toBe(200)
    const list = await request(app)
      .get(`/api/workspaces/${workspaceId}/subscriptions`)
      .set('Authorization', `Bearer ${ownerToken}`)
    expect(list.body.subscriptions).toHaveLength(0)
  })

  it('lists the delivery log for members', async () => {
    const created = await create()
    activityService.logEvent(workspaceId, null, 'execution.failed', {
      type: 'execution',
      id: 'exec-1',
      name: 'Nightly sync',
    })

    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/subscriptions/${created.body.subscription.id}/deliveries`)
      .set('Authorization', `Bearer ${memberToken}`)
    expect(res.status).toBe(200)
    expect(res.body.deliveries).toHaveLength(1)
    expect(res.body.deliveries[0]).toMatchObject({
      event_type: 'execution.failed',
      status: 'pending',
      attempts: 0,
    })
  })

  it('redelivers a failed delivery on demand', async () => {
    const receiver = await listen(200)
    const created = await create({ url: receiver.url })
    const subId = created.body.subscription.id

    // A delivery that already burned its attempts against a dead endpoint.
    const deliveryId = uuidv4()
    db.prepare(
      `INSERT INTO event_deliveries
         (id, subscription_id, event_type, payload_json, status, attempts, error, created_at)
       VALUES (?, ?, 'execution.failed', '{"n":1}', 'failed', 2, 'HTTP 500', ?)`
    ).run(deliveryId, subId, new Date().toISOString())

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/subscriptions/${subId}/deliveries/${deliveryId}/redeliver`)
      .set('Authorization', `Bearer ${ownerToken}`)
    await receiver.close()

    expect(res.status).toBe(200)
    expect(res.body.delivery.status).toBe('delivered')
    // Same delivery id on the wire, so receivers can deduplicate.
    expect(receiver.requests).toHaveLength(1)
    expect(JSON.parse(receiver.requests[0].body.toString()).id).toBe(deliveryId)
  })

  it('sends a test ping and reports the outcome', async () => {
    const good = await listen(200)
    const created = await create({ url: good.url })
    const ok = await request(app)
      .post(`/api/workspaces/${workspaceId}/subscriptions/${created.body.subscription.id}/test`)
      .set('Authorization', `Bearer ${ownerToken}`)
    await good.close()
    expect(ok.status).toBe(200)
    expect(ok.body.delivery.event_type).toBe('ping')
    expect(ok.body.delivery.status).toBe('delivered')
    expect(good.requests).toHaveLength(1)

    const bad = await listen(500)
    const created2 = await create({ url: bad.url })
    const failed = await request(app)
      .post(`/api/workspaces/${workspaceId}/subscriptions/${created2.body.subscription.id}/test`)
      .set('Authorization', `Bearer ${ownerToken}`)
    await bad.close()
    expect(failed.status).toBe(502)
    expect(failed.body.delivery.status).not.toBe('delivered')
  })
})
