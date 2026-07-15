// The write half of workflows-as-code on the public API:
// GET /api/v1/workspaces (read) names the targets, and
// POST /api/v1/workspaces/:id/workflows/import (manage) creates a draft
// workflow from a portable export document.

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
  ],
  edges: [],
}

describe('public workspaces + import', () => {
  let jwt
  let manageToken
  let readToken
  let workspaceId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'pubimport@example.com', password: 'password123', displayName: 'Imp' })
    jwt = res.body.token
    workspaceId = (
      await request(app).get('/api/workspaces').set('Authorization', `Bearer ${jwt}`)
    ).body.workspaces[0].id

    const mint = async (scopes) =>
      (
        await request(app)
          .post('/api/tokens')
          .set('Authorization', `Bearer ${jwt}`)
          .send({ name: `t-${scopes.join('-')}`, scopes })
      ).body.token
    manageToken = await mint(['manage', 'read'])
    readToken = await mint(['read'])
  })

  it('lists the owner workspaces for a read token', async () => {
    const res = await request(app)
      .get('/api/v1/workspaces')
      .set('Authorization', `Bearer ${readToken}`)
    expect(res.status).toBe(200)
    expect(res.body.workspaces.some((w) => w.id === workspaceId)).toBe(true)
    // Just ids and names — no membership or ownership internals.
    expect(Object.keys(res.body.workspaces[0]).sort()).toEqual(['id', 'name'])
  })

  it('imports a portable document as a draft workflow under the manage scope', async () => {
    const res = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/workflows/import`)
      .set('Authorization', `Bearer ${manageToken}`)
      .send({ name: 'Promoted sync', graph_data: GRAPH })
    expect(res.status).toBe(201)
    expect(res.body.workflow).toMatchObject({
      name: 'Promoted sync',
      status: 'draft',
      workspace_id: workspaceId,
    })

    const row = db.prepare('SELECT graph_json FROM workflows WHERE id = ?').get(res.body.workflow.id)
    expect(JSON.parse(row.graph_json)).toEqual(GRAPH)
  })

  it('a read-only token cannot import', async () => {
    const res = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/workflows/import`)
      .set('Authorization', `Bearer ${readToken}`)
      .send({ name: 'Nope', graph_data: GRAPH })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/manage/)
  })

  it('404s a workspace the owner is not a member of', async () => {
    const res = await request(app)
      .post(`/api/v1/workspaces/${uuidv4()}/workflows/import`)
      .set('Authorization', `Bearer ${manageToken}`)
      .send({ name: 'Nope', graph_data: GRAPH })
    expect(res.status).toBe(404)
  })

  it('rejects malformed documents', async () => {
    const missingGraph = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/workflows/import`)
      .set('Authorization', `Bearer ${manageToken}`)
      .send({ name: 'Broken' })
    expect(missingGraph.status).toBe(400)

    const badShape = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/workflows/import`)
      .set('Authorization', `Bearer ${manageToken}`)
      .send({ name: 'Broken', graph_data: { nodes: 'nope' } })
    expect(badShape.status).toBe(400)

    const noName = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/workflows/import`)
      .set('Authorization', `Bearer ${manageToken}`)
      .send({ graph_data: GRAPH })
    expect(noName.status).toBe(400)
  })

  it('round-trips a public export straight back through the public import', async () => {
    const source = (
      await request(app)
        .post(`/api/v1/workspaces/${workspaceId}/workflows/import`)
        .set('Authorization', `Bearer ${manageToken}`)
        .send({ name: 'Round trip', graph_data: GRAPH })
    ).body.workflow

    const exported = (
      await request(app)
        .get(`/api/v1/workflows/${source.id}/export`)
        .set('Authorization', `Bearer ${manageToken}`)
    ).body

    const back = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/workflows/import`)
      .set('Authorization', `Bearer ${manageToken}`)
      .send({ name: exported.name, graph_data: exported.graph_data })
    expect(back.status).toBe(201)
    const row = db.prepare('SELECT graph_json FROM workflows WHERE id = ?').get(back.body.workflow.id)
    expect(JSON.parse(row.graph_json)).toEqual(GRAPH)
  })
})
