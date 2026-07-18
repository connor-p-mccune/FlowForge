// POST /api/v1/workflows/:id/diff — drift detection on the public API: is the
// live workflow still what an exported document says it is?

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))

const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')

const LIVE_GRAPH = {
  nodes: [
    { id: 't1', type: 'trigger-manual', position: { x: 0, y: 0 }, data: { label: 'Start', config: {} } },
    { id: 'h1', type: 'action-http', position: { x: 0, y: 120 }, data: { label: 'Fetch', config: { url: 'https://api.example.com/v2' } } },
  ],
  edges: [{ id: 'e1', source: 't1', target: 'h1', sourceHandle: null }],
}

describe('POST /api/v1/workflows/:id/diff', () => {
  let jwt
  let readToken
  let triggerToken
  let workflowId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'pubdiff@example.com', password: 'password123', displayName: 'Diff' })
    jwt = res.body.token
    const userId = db.prepare('SELECT id FROM users WHERE email = ?').get('pubdiff@example.com').id
    const workspaceId = (
      await request(app).get('/api/workspaces').set('Authorization', `Bearer ${jwt}`)
    ).body.workspaces[0].id

    workflowId = uuidv4()
    db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by)
       VALUES (?, ?, 'Nightly sync', ?, 'deployed', ?)`
    ).run(workflowId, workspaceId, JSON.stringify(LIVE_GRAPH), userId)

    const minted = await request(app)
      .post('/api/tokens')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ name: 'differ', scopes: ['read'] })
    readToken = minted.body.token

    const noRead = await request(app)
      .post('/api/tokens')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ name: 'trigger-only', scopes: ['trigger'] })
    triggerToken = noRead.body.token
  })

  const diff = (token, body) =>
    request(app)
      .post(`/api/v1/workflows/${workflowId}/diff`)
      .set('Authorization', `Bearer ${token}`)
      .send(body)

  it('reports identical when the document matches the live graph', async () => {
    const res = await diff(readToken, { graph_data: LIVE_GRAPH })
    expect(res.status).toBe(200)
    expect(res.body.identical).toBe(true)
    expect(res.body.summary).toEqual({
      addedNodes: 0, removedNodes: 0, changedNodes: 0, addedEdges: 0, removedEdges: 0,
    })
  })

  it('canvas position moves are not drift', async () => {
    const moved = {
      ...LIVE_GRAPH,
      nodes: LIVE_GRAPH.nodes.map((n) => ({ ...n, position: { x: 999, y: 999 } })),
    }
    const res = await diff(readToken, { graph_data: moved })
    expect(res.body.identical).toBe(true)
  })

  it('reads the drift from the document\'s perspective', async () => {
    // The document holds the old URL and an extra node the live graph dropped.
    const document = {
      nodes: [
        LIVE_GRAPH.nodes[0],
        { ...LIVE_GRAPH.nodes[1], data: { label: 'Fetch', config: { url: 'https://api.example.com/v1' } } },
        { id: 'o1', type: 'output-log', position: { x: 0, y: 240 }, data: { label: 'Log', config: {} } },
      ],
      edges: [...LIVE_GRAPH.edges, { id: 'e2', source: 'h1', target: 'o1', sourceHandle: null }],
    }
    const res = await diff(readToken, { graph_data: document })
    expect(res.status).toBe(200)
    expect(res.body.identical).toBe(false)
    // o1 is in the document but not live: removed. h1's URL changed live.
    expect(res.body.removedNodes.map((n) => n.id)).toEqual(['o1'])
    expect(res.body.changedNodes).toEqual([
      { id: 'h1', type: 'action-http', label: 'Fetch', changes: ['config.url'] },
    ])
    expect(res.body.removedEdges).toHaveLength(1)
    expect(res.body.removedEdges[0].description).toBe('Fetch → Log')
  })

  it('rejects a malformed document with 400', async () => {
    expect((await diff(readToken, {})).status).toBe(400)
    expect((await diff(readToken, { graph_data: { nodes: 'x' } })).status).toBe(400)
  })

  it('requires the read scope and hides foreign workflows', async () => {
    const forbidden = await diff(triggerToken, { graph_data: LIVE_GRAPH })
    expect(forbidden.status).toBe(403)

    const outsider = await request(app)
      .post('/api/auth/register')
      .send({ email: 'pubdiff-out@example.com', password: 'password123', displayName: 'Out' })
    const outsiderToken = (
      await request(app)
        .post('/api/tokens')
        .set('Authorization', `Bearer ${outsider.body.token}`)
        .send({ name: 'outsider', scopes: ['read'] })
    ).body.token
    const hidden = await diff(outsiderToken, { graph_data: LIVE_GRAPH })
    expect(hidden.status).toBe(404)
  })
})
