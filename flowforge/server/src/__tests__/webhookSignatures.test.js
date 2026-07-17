// Webhook HMAC signing (SECURITY.md T3): signed webhooks reject unsigned,
// tampered, and replayed deliveries; unsigned webhooks are unchanged; and the
// signing secret is returned exactly once.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))

const { app } = require('../index')
const { computeSignature, verifyWebhookSignature } = require('../services/webhookSignature')

const oneNodeGraph = {
  nodes: [{ id: 't1', type: 'trigger-webhook', position: { x: 0, y: 0 }, data: { label: 'Hook', config: {} } }],
  edges: [],
}

function signedHeaders(secret, body, timestamp = Math.floor(Date.now() / 1000)) {
  const ts = String(timestamp)
  return {
    'X-FlowForge-Timestamp': ts,
    'X-FlowForge-Signature': `v1=${computeSignature(secret, ts, Buffer.from(body, 'utf8'))}`,
  }
}

describe('webhook signatures', () => {
  let token
  let workspaceId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'hmac-user@example.com', password: 'password123', displayName: 'Signer' })
    token = res.body.token
    const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`)
    workspaceId = ws.body.workspaces[0].id
  })

  beforeEach(() => mockAdd.mockClear())

  async function createWebhook({ signed }) {
    const wf = await request(app)
      .post(`/api/workspaces/${workspaceId}/workflows`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Hooked' })
    await request(app)
      .put(`/api/workflows/${wf.body.workflow.id}/graph`)
      .set('Authorization', `Bearer ${token}`)
      .send(oneNodeGraph)
    const res = await request(app)
      .post(`/api/workflows/${wf.body.workflow.id}/webhooks`)
      .set('Authorization', `Bearer ${token}`)
      .send({ signed })
    return { workflowId: wf.body.workflow.id, ...res.body }
  }

  it('returns the signing secret exactly once and never in lists', async () => {
    const { workflowId, webhook, signingSecret } = await createWebhook({ signed: true })
    expect(signingSecret).toMatch(/^whsec_[0-9a-f]{48}$/)
    expect(webhook.signed).toBe(true)
    expect(webhook).not.toHaveProperty('signing_secret')

    const list = await request(app)
      .get(`/api/workflows/${workflowId}/webhooks`)
      .set('Authorization', `Bearer ${token}`)
    expect(list.body.webhooks[0].signed).toBe(true)
    expect(JSON.stringify(list.body)).not.toContain(signingSecret)
  })

  it('accepts a correctly signed delivery', async () => {
    const { webhook, signingSecret } = await createWebhook({ signed: true })
    const body = '{"orderId":42}'
    const res = await request(app)
      .post(`/api/webhooks/${webhook.webhook_key}`)
      .set(signedHeaders(signingSecret, body))
      .set('Content-Type', 'application/json')
      .send(body)
    expect(res.status).toBe(202)
    expect(mockAdd).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { orderId: 42 } }),
      { priority: 5 }
    )
  })

  it('rejects missing headers, tampered bodies, and wrong secrets', async () => {
    const { webhook, signingSecret } = await createWebhook({ signed: true })
    const body = '{"orderId":42}'

    const unsigned = await request(app)
      .post(`/api/webhooks/${webhook.webhook_key}`)
      .set('Content-Type', 'application/json')
      .send(body)
    expect(unsigned.status).toBe(401)
    expect(unsigned.body.error).toMatch(/headers/i)

    // Signed over a different body than what is delivered.
    const tampered = await request(app)
      .post(`/api/webhooks/${webhook.webhook_key}`)
      .set(signedHeaders(signingSecret, '{"orderId":999}'))
      .set('Content-Type', 'application/json')
      .send(body)
    expect(tampered.status).toBe(401)
    expect(tampered.body.error).toMatch(/invalid signature/i)

    const wrongSecret = await request(app)
      .post(`/api/webhooks/${webhook.webhook_key}`)
      .set(signedHeaders('whsec_' + '0'.repeat(48), body))
      .set('Content-Type', 'application/json')
      .send(body)
    expect(wrongSecret.status).toBe(401)
    expect(mockAdd).not.toHaveBeenCalled()
  })

  it('rejects replays outside the timestamp tolerance', async () => {
    const { webhook, signingSecret } = await createWebhook({ signed: true })
    const body = '{"orderId":42}'
    const staleTs = Math.floor(Date.now() / 1000) - 600 // 10 minutes old

    const res = await request(app)
      .post(`/api/webhooks/${webhook.webhook_key}`)
      .set(signedHeaders(signingSecret, body, staleTs))
      .set('Content-Type', 'application/json')
      .send(body)
    expect(res.status).toBe(401)
    expect(res.body.error).toMatch(/tolerance/i)
  })

  it('leaves unsigned webhooks working without any headers', async () => {
    const { webhook } = await createWebhook({ signed: false })
    expect(webhook.signed).toBe(false)
    const res = await request(app)
      .post(`/api/webhooks/${webhook.webhook_key}`)
      .send({ hello: 'world' })
    expect(res.status).toBe(202)
  })
})

describe('verifyWebhookSignature (unit)', () => {
  const secret = 'whsec_test'
  const body = Buffer.from('{"a":1}', 'utf8')

  it('accepts a valid signature and rejects malformed headers', () => {
    const ts = String(Math.floor(Date.now() / 1000))
    const good = verifyWebhookSignature({
      secret,
      timestampHeader: ts,
      signatureHeader: `v1=${computeSignature(secret, ts, body)}`,
      rawBody: body,
    })
    expect(good.ok).toBe(true)

    const malformed = verifyWebhookSignature({
      secret,
      timestampHeader: ts,
      signatureHeader: 'sha256=deadbeef',
      rawBody: body,
    })
    expect(malformed.ok).toBe(false)
    expect(malformed.error).toMatch(/malformed/i)
  })

  it('treats a missing body as empty bytes', () => {
    const ts = String(Math.floor(Date.now() / 1000))
    const sig = `v1=${computeSignature(secret, ts, null)}`
    expect(
      verifyWebhookSignature({ secret, timestampHeader: ts, signatureHeader: sig, rawBody: undefined }).ok
    ).toBe(true)
  })
})
