// POST /api/v1/workflows/:id/lint — the linter as a CI gate: same rules as
// the canvas's Issues panel, with real workspace context, over either the
// stored graph or a posted document.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))

const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')

const node = (id, type, config = {}) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label: id, config },
})
const edge = (source, target) => ({ id: `${source}-${target}`, source, target, sourceHandle: null })

const CLEAN_GRAPH = {
  nodes: [node('t1', 'trigger-manual'), node('o1', 'output-log', { message: 'hi' })],
  edges: [edge('t1', 'o1')],
}

describe('POST /api/v1/workflows/:id/lint', () => {
  let jwt
  let readToken
  let workspaceId
  let workflowId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'publint@example.com', password: 'password123', displayName: 'Lint' })
    jwt = res.body.token
    const userId = db.prepare('SELECT id FROM users WHERE email = ?').get('publint@example.com').id
    workspaceId = (
      await request(app).get('/api/workspaces').set('Authorization', `Bearer ${jwt}`)
    ).body.workspaces[0].id

    workflowId = uuidv4()
    db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by)
       VALUES (?, ?, 'Lintable', ?, 'deployed', ?)`
    ).run(workflowId, workspaceId, JSON.stringify(CLEAN_GRAPH), userId)

    await request(app)
      .put(`/api/workspaces/${workspaceId}/secrets/API_KEY`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ value: 'shh-value' })
    await request(app)
      .put(`/api/workspaces/${workspaceId}/variables/BASE_URL`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ value: 'https://api.example.com' })

    const minted = await request(app)
      .post('/api/tokens')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ name: 'linter', scopes: ['read'] })
    readToken = minted.body.token
  })

  const lint = (body) =>
    request(app)
      .post(`/api/v1/workflows/${workflowId}/lint`)
      .set('Authorization', `Bearer ${readToken}`)
      .send(body)

  it('lints the stored graph with an empty body — ok when clean', async () => {
    const res = await lint({})
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.issues).toEqual([])
    expect(res.body.summary).toEqual({ errors: 0, warnings: 0 })
  })

  it('lints a posted document against the workspace\'s real context', async () => {
    const document = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('h1', 'action-http', {
          url: '{{vars.TYPO_URL}}/x',
          headers: '{"Authorization": "Bearer {{secrets.NOPE}}"}',
        }),
      ],
      edges: [edge('t1', 'h1')],
    }
    const res = await lint({ graph_data: document })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    const codes = res.body.issues.map((i) => i.code)
    expect(codes).toContain('unknown-secret')
    expect(codes).toContain('unknown-variable')
    expect(res.body.summary.errors).toBe(2)

    // The same document with known names passes.
    const fixed = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('h1', 'action-http', {
          url: '{{vars.BASE_URL}}/x',
          headers: '{"Authorization": "Bearer {{secrets.API_KEY}}"}',
        }),
      ],
      edges: [edge('t1', 'h1')],
    }
    expect((await lint({ graph_data: fixed })).body.ok).toBe(true)
  })

  it('warnings do not flip the gate', async () => {
    const document = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('o1', 'output-log', {}),
        node('island', 'output-log', {}), // unreachable — warning only
      ],
      edges: [edge('t1', 'o1')],
    }
    const res = await lint({ graph_data: document })
    expect(res.body.ok).toBe(true)
    expect(res.body.summary.warnings).toBeGreaterThan(0)
  })

  it('rejects malformed graph_data with 400 — absent graph_data means the stored graph', async () => {
    expect((await lint({ graph_data: { nodes: 'x' } })).status).toBe(400)
    // Explicitly null is a malformed document, not "use the stored graph".
    expect((await lint({ graph_data: null })).status).toBe(400)
  })

  it('requires the read scope and rejects session JWTs', async () => {
    const asJwt = await request(app)
      .post(`/api/v1/workflows/${workflowId}/lint`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({})
    expect(asJwt.status).toBe(401)
  })
})
