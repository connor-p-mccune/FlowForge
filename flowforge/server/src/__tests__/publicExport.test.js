// GET /api/v1/workflows/:id/export — the portable workflow document on the
// public API, so `flowforge export` can check workflow definitions into git.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))

const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')

const GRAPH = {
  nodes: [
    { id: 't1', type: 'trigger-manual', position: { x: 0, y: 0 }, data: { label: 'Start', config: {} } },
    { id: 'o1', type: 'output-log', position: { x: 0, y: 120 }, data: { label: 'Log', config: { message: 'hi' } } },
  ],
  edges: [{ id: 'e1', source: 't1', target: 'o1', sourceHandle: null }],
}

describe('GET /api/v1/workflows/:id/export', () => {
  let jwt
  let readToken
  let workflowId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'pubexport@example.com', password: 'password123', displayName: 'Exp' })
    jwt = res.body.token
    const userId = db.prepare('SELECT id FROM users WHERE email = ?').get('pubexport@example.com').id
    const workspaceId = (
      await request(app).get('/api/workspaces').set('Authorization', `Bearer ${jwt}`)
    ).body.workspaces[0].id

    workflowId = uuidv4()
    db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, description, graph_json, status, created_by)
       VALUES (?, ?, 'Nightly sync', 'syncs things', ?, 'deployed', ?)`
    ).run(workflowId, workspaceId, JSON.stringify(GRAPH), userId)

    const minted = await request(app)
      .post('/api/tokens')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ name: 'exporter', scopes: ['read'] })
    readToken = minted.body.token
  })

  it('returns the portable document for a read token', async () => {
    const res = await request(app)
      .get(`/api/v1/workflows/${workflowId}/export`)
      .set('Authorization', `Bearer ${readToken}`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      exportVersion: '1.0',
      name: 'Nightly sync',
      description: 'syncs things',
      graph_data: GRAPH,
    })
    // Portable means self-contained: no internal ids or ownership leak out.
    expect(res.body).not.toHaveProperty('id')
    expect(res.body).not.toHaveProperty('workspace_id')
    expect(res.body).not.toHaveProperty('created_by')
  })

  it('round-trips through the session import', async () => {
    const exported = (
      await request(app)
        .get(`/api/v1/workflows/${workflowId}/export`)
        .set('Authorization', `Bearer ${readToken}`)
    ).body
    const workspaceId = (
      await request(app).get('/api/workspaces').set('Authorization', `Bearer ${jwt}`)
    ).body.workspaces[0].id

    const imported = await request(app)
      .post(`/api/workspaces/${workspaceId}/workflows/import`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ name: exported.name, graph_data: exported.graph_data })
    expect(imported.status).toBe(201)
    expect(JSON.parse(imported.body.workflow.graph_json)).toEqual(GRAPH)
  })

  it('404s for unknown workflows and rejects session JWTs', async () => {
    const unknown = await request(app)
      .get(`/api/v1/workflows/${uuidv4()}/export`)
      .set('Authorization', `Bearer ${readToken}`)
    expect(unknown.status).toBe(404)

    const asJwt = await request(app)
      .get(`/api/v1/workflows/${workflowId}/export`)
      .set('Authorization', `Bearer ${jwt}`)
    expect(asJwt.status).toBe(401)
  })
})
