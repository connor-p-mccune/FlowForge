// The merge endpoint: base resolution, the preview/apply split, and the two
// things it must never do — write a conflicted graph, or write one at all
// without being asked.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: jest.fn() }) }))
jest.mock('../config/redis', () => ({ publish: jest.fn().mockResolvedValue(1) }))

const { app } = require('../index')
const db = require('../config/database')

const node = (id, type, config = {}, label = id) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label, config },
})
const edge = (source, target) => ({ id: `${source}-${target}`, source, target })

const http = (id, config = {}) =>
  node(id, 'action-http', { method: 'GET', url: 'https://api.acme.com/x', headers: '{}', ...config })

const BASE = {
  nodes: [node('t1', 'trigger-manual'), http('h1')],
  edges: [edge('t1', 'h1')],
}

describe('merge API', () => {
  let jwt
  let workspaceId
  let workflowId
  let apiToken

  const authed = (req) => req.set('Authorization', `Bearer ${jwt}`)
  const asToken = (req) => req.set('Authorization', `Bearer ${apiToken}`)

  const liveGraph = () => JSON.parse(
    db.prepare('SELECT graph_json FROM workflows WHERE id = ?').get(workflowId).graph_json
  )
  const setLive = (graph) =>
    db.prepare('UPDATE workflows SET graph_json = ? WHERE id = ?')
      .run(JSON.stringify(graph), workflowId)

  const merge = (body) =>
    asToken(request(app).post(`/api/v1/workflows/${workflowId}/merge`)).send(body)

  beforeAll(async () => {
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ email: 'merge@example.com', password: 'password123', displayName: 'Merger' })
    jwt = reg.body.token
    const ws = await authed(request(app).get('/api/workspaces'))
    workspaceId = ws.body.workspaces[0].id
    const wf = await authed(request(app).post(`/api/workspaces/${workspaceId}/workflows`))
      .send({ name: 'Sync' })
    workflowId = wf.body.workflow.id
    await authed(request(app).put(`/api/workflows/${workflowId}/graph`)).send(BASE)
    // Deploying snapshots the graph — that snapshot is the merge base, because
    // a deploy is where the exported document came from.
    await authed(request(app).post(`/api/workflows/${workflowId}/deploy`)).send({})

    const minted = await authed(request(app).post('/api/tokens'))
      .send({ name: 'merge-suite', scopes: ['manage', 'read'] })
    apiToken = minted.body.token
  })

  beforeEach(() => setLive(BASE))

  it('combines edits to different fields without conflicting', async () => {
    setLive({ ...BASE, nodes: [BASE.nodes[0], http('h1', { url: 'https://api.acme.com/live' })] })
    const theirs = { ...BASE, nodes: [BASE.nodes[0], http('h1', { method: 'POST' })] }

    const res = await merge({ graph_data: theirs, apply: true })
    expect(res.status).toBe(200)
    expect(res.body.clean).toBe(true)
    expect(res.body.applied).toBe(true)
    expect(res.body.base.version).toBe(1)

    const h1 = liveGraph().nodes.find((n) => n.id === 'h1')
    expect(h1.data.config).toMatchObject({ url: 'https://api.acme.com/live', method: 'POST' })
  })

  it('previews by default and changes nothing', async () => {
    const theirs = { ...BASE, nodes: [BASE.nodes[0], http('h1', { method: 'PUT' })] }
    const res = await merge({ graph_data: theirs })

    expect(res.body.clean).toBe(true)
    expect(res.body.applied).toBe(false)
    expect(liveGraph().nodes.find((n) => n.id === 'h1').data.config.method).toBe('GET')
  })

  it('reports a conflict, produces no graph, and writes nothing even with apply', async () => {
    setLive({ ...BASE, nodes: [BASE.nodes[0], http('h1', { url: 'https://live/x' })] })
    const theirs = { ...BASE, nodes: [BASE.nodes[0], http('h1', { url: 'https://git/x' })] }

    const res = await merge({ graph_data: theirs, apply: true })
    expect(res.body.clean).toBe(false)
    expect(res.body.applied).toBe(false)
    expect(res.body.conflicts[0]).toMatchObject({ kind: 'field', field: 'config.url' })
    expect(res.body.conflicts[0].description).toMatch(/live "https:\/\/live\/x"/)
    // The live workflow is untouched.
    expect(liveGraph().nodes.find((n) => n.id === 'h1').data.config.url).toBe('https://live/x')
  })

  it('resolves a conflict when told which side wins', async () => {
    setLive({ ...BASE, nodes: [BASE.nodes[0], http('h1', { url: 'https://live/x' })] })
    const theirs = { ...BASE, nodes: [BASE.nodes[0], http('h1', { url: 'https://git/x' })] }

    const res = await merge({ graph_data: theirs, strategy: 'theirs', apply: true })
    expect(res.body.clean).toBe(true)
    expect(liveGraph().nodes.find((n) => n.id === 'h1').data.config.url).toBe('https://git/x')
  })

  it('lints the merged graph, not the inputs', async () => {
    // They deleted h1; we still reference it from a log node we added. Both
    // sides are individually fine; the merge is not.
    setLive({
      nodes: [...BASE.nodes, node('l1', 'output-log', { message: '{{h1.status}}' })],
      edges: [...BASE.edges, edge('h1', 'l1')],
    })
    const theirs = { nodes: [node('t1', 'trigger-manual')], edges: [] }

    const res = await merge({ graph_data: theirs })
    expect(res.body.clean).toBe(true)
    expect(res.body.lint.errors).toBeGreaterThan(0)
    expect(res.body.lint.issues.map((i) => i.code)).toContain('unknown-node-ref')
    // The dangling connection is dropped rather than written, and said so.
    expect(res.body.droppedEdges.length).toBeGreaterThan(0)
  })

  it('rejects an unknown strategy and an unknown base version', async () => {
    const bad = await merge({ graph_data: BASE, strategy: 'whatever' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/strategy/)

    const noBase = await merge({ graph_data: BASE, baseVersion: 99 })
    expect(noBase.status).toBe(400)
    expect(noBase.body.error).toMatch(/No version "99"/)
  })

  it('requires graph_data', async () => {
    const res = await merge({})
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/graph_data/)
  })

  it('audits an applied merge', async () => {
    const theirs = { ...BASE, nodes: [BASE.nodes[0], http('h1', { method: 'PATCH' })] }
    await merge({ graph_data: theirs, apply: true })

    const entries = db.prepare(
      "SELECT * FROM audit_log WHERE workspace_id = ? AND action = 'workflow.merged'"
    ).all(workspaceId)
    expect(entries.length).toBeGreaterThan(0)
    expect(JSON.parse(entries.at(-1).metadata)).toMatchObject({ baseVersion: 1, strategy: 'manual' })
  })

  it('refuses a read-only token — merging writes a definition', async () => {
    const readOnly = await authed(request(app).post('/api/tokens'))
      .send({ name: 'reader', scopes: ['read'] })
    const res = await request(app)
      .post(`/api/v1/workflows/${workflowId}/merge`)
      .set('Authorization', `Bearer ${readOnly.body.token}`)
      .send({ graph_data: BASE })
    expect(res.status).toBe(403)
  })
})
