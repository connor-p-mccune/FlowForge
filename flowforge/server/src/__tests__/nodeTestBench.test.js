// The node test bench: run a single node with sample input/context, dry-run
// by default, secrets resolved but scrubbed from the response, engine-only
// node types refused, and a timeout so a bench run can't hang its request.

const http = require('http')
const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))

const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')

const node = (type, config = {}) => ({
  id: 'bench-node',
  type,
  data: { label: 'bench', config },
})

describe('node test bench', () => {
  let token
  let workflowId

  let server
  let baseUrl
  const hits = []

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push({ path: req.url, auth: req.headers.authorization || null })
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${server.address().port}`

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'bench-user@example.com', password: 'password123', displayName: 'Bencher' })
    token = res.body.token
    const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`)
    const workspaceId = ws.body.workspaces[0].id

    const wf = await request(app)
      .post(`/api/workspaces/${workspaceId}/workflows`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Bench workflow' })
    workflowId = wf.body.workflow.id

    await request(app)
      .put(`/api/workspaces/${workspaceId}/secrets/API_KEY`)
      .set('Authorization', `Bearer ${token}`)
      .send({ value: 'shh-topsecret-9000' })
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  function bench(body) {
    return request(app)
      .post(`/api/workflows/${workflowId}/test-node`)
      .set('Authorization', `Bearer ${token}`)
      .send(body)
  }

  it('runs a transform node, resolving templates from the provided context', async () => {
    const res = await bench({
      node: node('transform', { template: '{"greeting": "hi {{upstream.name}}"}' }),
      context: { upstream: { name: 'Ada' } },
    })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('succeeded')
    expect(res.body.dryRun).toBe(true)
    expect(res.body.output).toEqual({ greeting: 'hi Ada' })
    expect(res.body.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('dry-runs side-effecting nodes by default: reports, never fires', async () => {
    hits.length = 0
    const res = await bench({
      node: node('action-http', { method: 'POST', url: `${baseUrl}/never`, headers: '{}', body: '{"x":1}' }),
    })
    expect(res.body.status).toBe('succeeded')
    expect(res.body.output.dryRun).toBe(true)
    expect(res.body.output.wouldHaveSent.url).toBe(`${baseUrl}/never`)
    expect(hits).toHaveLength(0)
  })

  it('fires the real call with live: true', async () => {
    hits.length = 0
    const res = await bench({
      node: node('action-http', { method: 'GET', url: `${baseUrl}/live`, headers: '{}' }),
      live: true,
    })
    expect(res.body.status).toBe('succeeded')
    expect(res.body.dryRun).toBe(false)
    expect(res.body.output.status).toBe(200)
    expect(hits).toHaveLength(1)
  })

  it('resolves {{secrets.*}} for the run but scrubs the value from the response', async () => {
    hits.length = 0
    const res = await bench({
      node: node('action-http', {
        method: 'GET',
        url: `${baseUrl}/secret`,
        headers: '{"Authorization": "Bearer {{secrets.API_KEY}}"}',
      }),
      live: true,
    })
    expect(res.body.status).toBe('succeeded')
    // The real value reached the wire…
    expect(hits[0].auth).toBe('Bearer shh-topsecret-9000')
    // …but never the response.
    expect(JSON.stringify(res.body)).not.toContain('shh-topsecret-9000')
  })

  it('reports a failing node as a failed verdict, not an HTTP error', async () => {
    const res = await bench({ node: node('action-http', {}) }) // url missing
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('failed')
    expect(res.body.error).toMatch(/url is required/)
  })

  it('times out a node that outlives NODE_TEST_TIMEOUT_MS', async () => {
    process.env.NODE_TEST_TIMEOUT_MS = '100'
    try {
      const res = await bench({ node: node('action-delay', { durationMs: 800 }) })
      expect(res.body.status).toBe('failed')
      expect(res.body.error).toMatch(/timed out after 100ms/)
    } finally {
      delete process.env.NODE_TEST_TIMEOUT_MS
    }
  })

  it('refuses engine-only node types and unknown types', async () => {
    for (const type of ['approval', 'sub-workflow', 'for-each']) {
      const res = await bench({ node: node(type) })
      expect(res.status).toBe(400)
    }
    const unknown = await bench({ node: node('made-up-type') })
    expect(unknown.status).toBe(400)
    expect(unknown.body.error).toMatch(/Unknown node type/)

    const missing = await bench({})
    expect(missing.status).toBe(400)
  })

  it('404s for non-members', async () => {
    const other = await request(app)
      .post('/api/auth/register')
      .send({ email: 'bench-outsider@example.com', password: 'password123', displayName: 'Out' })
    const res = await request(app)
      .post(`/api/workflows/${workflowId}/test-node`)
      .set('Authorization', `Bearer ${other.body.token}`)
      .send({ node: node('transform', {}) })
    expect(res.status).toBe(404)

    const unknownWf = await request(app)
      .post(`/api/workflows/${uuidv4()}/test-node`)
      .set('Authorization', `Bearer ${token}`)
      .send({ node: node('transform', {}) })
    expect(unknownWf.status).toBe(404)
  })
})
