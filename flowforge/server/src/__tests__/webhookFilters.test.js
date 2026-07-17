// Webhook gate expressions: an FXL predicate over the delivery body decides
// whether a delivery fires. Validation happens at save (same static checks
// as any FXL field); at delivery time a non-match is acknowledged without a
// run, and a runtime filter error also doesn't fire — deterministically.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))

const { app } = require('../index')
const db = require('../config/database')

describe('webhook gate expressions', () => {
  let jwt
  let workflowId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'gate@example.com', password: 'password123', displayName: 'Gater' })
    jwt = res.body.token
    const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${jwt}`)
    const workspaceId = ws.body.workspaces[0].id
    const wf = await request(app)
      .post(`/api/workspaces/${workspaceId}/workflows`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ name: 'Gated' })
    workflowId = wf.body.workflow.id
    await request(app)
      .put(`/api/workflows/${workflowId}/graph`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({
        nodes: [{ id: 't1', type: 'trigger-webhook', position: { x: 0, y: 0 }, data: { label: 'Hook' } }],
        edges: [],
      })
  })

  beforeEach(() => mockAdd.mockClear())

  async function createWebhook(body = {}) {
    const res = await request(app)
      .post(`/api/workflows/${workflowId}/webhooks`)
      .set('Authorization', `Bearer ${jwt}`)
      .send(body)
    return res
  }

  it('rejects an unparseable or unknown-function filter at save time', async () => {
    const bad = await createWebhook({ filterExpression: 'event == ' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/syntax error/)

    const unknown = await createWebhook({ filterExpression: 'summon(event)' })
    expect(unknown.status).toBe(400)
    expect(unknown.body.error).toMatch(/unknown function "summon\(\)"/)
  })

  it('fires matching deliveries and acknowledges non-matching ones without a run', async () => {
    const { body } = await createWebhook({
      name: 'Pushes only',
      filterExpression: 'event == "push" && ref == "main"',
    })
    const key = body.webhook.webhook_key

    const filtered = await request(app)
      .post(`/api/webhooks/${key}`)
      .send({ event: 'pull_request', ref: 'main' })
    expect(filtered.status).toBe(202)
    expect(filtered.body).toEqual({ accepted: false, reason: 'filtered' })
    expect(mockAdd).not.toHaveBeenCalled()
    // A filtered delivery is not a firing — last_triggered_at stays unset.
    expect(db.prepare('SELECT last_triggered_at FROM webhooks WHERE id = ?').get(body.webhook.id).last_triggered_at).toBeNull()

    const fired = await request(app)
      .post(`/api/webhooks/${key}`)
      .send({ event: 'push', ref: 'main' })
    expect(fired.status).toBe(202)
    expect(fired.body.executionId).toBeTruthy()
    expect(mockAdd).toHaveBeenCalledTimes(1)
  })

  it('a filter that errors at delivery time does not fire, with the reason', async () => {
    const { body } = await createWebhook({ filterExpression: 'total * 2 > 10' })
    const res = await request(app)
      .post(`/api/webhooks/${body.webhook.webhook_key}`)
      .send({ total: 'not-a-number' }) // arithmetic on a string is a runtime type error
    expect(res.status).toBe(202)
    expect(res.body.accepted).toBe(false)
    expect(res.body.reason).toMatch(/filter error/)
    expect(mockAdd).not.toHaveBeenCalled()
  })

  it('PUT edits the filter without rotating the key', async () => {
    const { body } = await createWebhook({ filterExpression: 'event == "a"' })
    const key = body.webhook.webhook_key

    const updated = await request(app)
      .put(`/api/webhooks/${body.webhook.id}`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ filterExpression: 'event == "b"' })
    expect(updated.status).toBe(200)
    expect(updated.body.webhook.webhook_key).toBe(key) // the URL senders hold survives
    expect(updated.body.webhook.filter_expression).toBe('event == "b"')

    // Clearing restores fire-on-everything.
    await request(app)
      .put(`/api/webhooks/${body.webhook.id}`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ filterExpression: null })
    const fired = await request(app).post(`/api/webhooks/${key}`).send({ anything: true })
    expect(fired.body.executionId).toBeTruthy()

    // Validation applies to edits too.
    const bad = await request(app)
      .put(`/api/webhooks/${body.webhook.id}`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ filterExpression: 'nope(' })
    expect(bad.status).toBe(400)
  })

  it('hides foreign webhooks from the update route', async () => {
    const { body } = await createWebhook({})
    const other = await request(app)
      .post('/api/auth/register')
      .send({ email: 'gate-other@example.com', password: 'password123', displayName: 'Other' })
    const res = await request(app)
      .put(`/api/webhooks/${body.webhook.id}`)
      .set('Authorization', `Bearer ${other.body.token}`)
      .send({ filterExpression: 'true' })
    expect(res.status).toBe(404)
  })
})
