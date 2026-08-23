// The `.flow` format across the public API: exporting a workflow as text, and
// importing text back. The claim worth testing end to end is that the loop is
// lossless — export, review, import, and the graph in the target workspace is
// the graph that left the source one.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: jest.fn().mockResolvedValue(undefined) }) }))
jest.mock('../config/redis', () => ({ publish: jest.fn().mockResolvedValue(1) }))

const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')
const { signDocument, generateKeyPair, fingerprint } = require('../services/artifactSigning')

const GRAPH = {
  nodes: [
    {
      id: 'hook',
      type: 'trigger-webhook',
      position: { x: 100, y: 200 },
      data: { label: 'Order webhook', config: {} },
    },
    {
      id: 'charge',
      type: 'action-http',
      position: { x: 480, y: 160 },
      data: {
        label: 'Charge card',
        config: {
          method: 'POST',
          url: 'https://api.acme.com/v1/charges/{{hook.orderId}}',
          headers: { 'Content-Type': 'application/json' },
        },
      },
    },
  ],
  edges: [{ id: 'e1', source: 'hook', target: 'charge', sourceHandle: null }],
}

describe('the .flow format over the API', () => {
  let jwt
  let userId
  let workspaceId
  let readToken
  let manageToken
  let workflowId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'dsl@example.com', password: 'password123', displayName: 'Dsl' })
    jwt = res.body.token
    userId = db.prepare('SELECT id FROM users WHERE email = ?').get('dsl@example.com').id
    workspaceId = (await request(app).get('/api/workspaces').set('Authorization', `Bearer ${jwt}`))
      .body.workspaces[0].id

    workflowId = uuidv4()
    db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, description, graph_json, guarantees_json, status, created_by)
       VALUES (?, ?, 'Order pipeline', 'Handles orders', ?, ?, 'deployed', ?)`
    ).run(
      workflowId, workspaceId, JSON.stringify(GRAPH),
      JSON.stringify([{ kind: 'requires', node: 'charge', other: 'hook', note: 'PCI' }]), userId
    )

    readToken = (
      await request(app).post('/api/tokens').set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'reader', scopes: ['read'] })
    ).body.token
    manageToken = (
      await request(app).post('/api/tokens').set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'promoter', scopes: ['manage'] })
    ).body.token
  })

  const exportFlow = () =>
    request(app)
      .get(`/api/v1/workflows/${workflowId}/export?format=flow`)
      .set('Authorization', `Bearer ${readToken}`)
      .buffer(true)
      .parse((res, cb) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => cb(null, text))
      })

  it('serves the text form as text, not wrapped in JSON', async () => {
    const res = await exportFlow()
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/plain/)
    // `flowforge export <id> --flow > sync.flow` should produce the file, not
    // something that needs unwrapping first.
    expect(res.body).toMatch(/^workflow "Order pipeline"/)
    expect(res.body).toMatch(/node charge: action-http @ 480,160/)
    expect(res.body).toMatch(/hook -> charge/)
    expect(res.body).toMatch(/guarantee requires charge hook/)
  })

  it('leaves out the timestamp that makes an unchanged export diff', async () => {
    const first = await exportFlow()
    const second = await exportFlow()
    expect(first.body).toBe(second.body)
    // Whereas the JSON export differs on every call, which is the problem.
    expect(first.body).not.toMatch(/exportedAt/)
  })

  it('still serves the JSON form by default', async () => {
    const res = await request(app)
      .get(`/api/v1/workflows/${workflowId}/export`)
      .set('Authorization', `Bearer ${readToken}`)
    expect(res.body.exportVersion).toBe('1.0')
    expect(res.body.graph_data.nodes).toHaveLength(2)
  })

  it('imports the text back into a graph that matches what left', async () => {
    const exported = await exportFlow()
    const res = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/workflows/import`)
      .set('Authorization', `Bearer ${manageToken}`)
      .send({ flow: exported.body })

    expect(res.status).toBe(201)
    const created = db.prepare('SELECT * FROM workflows WHERE id = ?').get(res.body.workflow.id)
    expect(created.name).toBe('Order pipeline')

    const graph = JSON.parse(created.graph_json)
    const charge = graph.nodes.find((n) => n.id === 'charge')
    expect(charge.type).toBe('action-http')
    expect(charge.position).toEqual({ x: 480, y: 160 })
    expect(charge.data.config).toEqual(GRAPH.nodes[1].data.config)
    expect(graph.edges).toEqual([
      { id: 'hook-charge', source: 'hook', target: 'charge', sourceHandle: null },
    ])
    // The declared invariants travel with the text, exactly as they do with
    // the JSON — a promotion that dropped them would ship the workflow without
    // the checks that were the reason it passed review.
    expect(JSON.parse(created.guarantees_json)).toEqual([
      { kind: 'requires', node: 'charge', other: 'hook', note: 'PCI' },
    ])
  })

  it('reports a syntax error with the line, rather than a generic 400', async () => {
    const res = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/workflows/import`)
      .set('Authorization', `Bearer ${manageToken}`)
      .send({ flow: 'workflow "Broken"\nnode n: action-http\n  method: POST\n' })

    expect(res.status).toBe(400)
    expect(res.body.line).toBe(3)
    expect(res.body.error).toMatch(/Line 3/)
    expect(res.body.error).toMatch(/strings need quotes/)
  })

  it('verifies a signature made over the JSON against the text that was reviewed', async () => {
    // The whole promise of the emit order: sign the JSON export, hand a
    // reviewer the `.flow`, and importing the text still verifies — because the
    // format's canonical order is the signing canonical order.
    const { publicKey, privateKey } = generateKeyPair()
    db.prepare(
      `INSERT INTO workspace_signing_keys (id, workspace_id, name, public_key, fingerprint, added_by, created_at)
       VALUES (?, ?, 'release', ?, ?, ?, ?)`
    ).run(uuidv4(), workspaceId, publicKey, fingerprint(publicKey), userId, new Date().toISOString())
    db.prepare('UPDATE workspaces SET require_signed_imports = 1 WHERE id = ?').run(workspaceId)

    const json = (
      await request(app)
        .get(`/api/v1/workflows/${workflowId}/export`)
        .set('Authorization', `Bearer ${readToken}`)
    ).body
    const signature = signDocument(json, privateKey)
    const flow = (await exportFlow()).body

    const res = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/workflows/import`)
      .set('Authorization', `Bearer ${manageToken}`)
      .send({ flow, signature })

    expect(res.status).toBe(201)
    db.prepare('UPDATE workspaces SET require_signed_imports = 0 WHERE id = ?').run(workspaceId)
  })
})

// PUT /api/workflows/:id/flow — editing a workflow as text.
//
// The canvas is for drawing and text is for surgery: renaming twelve nodes or
// repointing five HTTP nodes is one find-and-replace here and twelve dialogs
// there. What matters is that it writes the *whole* document, and that a
// mistake comes back with a position a cursor can be put on.
describe('PUT /api/workflows/:id/flow', () => {
  let jwt
  let userId
  let workspaceId
  let editableId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'flowedit@example.com', password: 'password123', displayName: 'Editor' })
    jwt = res.body.token
    userId = db.prepare('SELECT id FROM users WHERE email = ?').get('flowedit@example.com').id
    workspaceId = (await request(app).get('/api/workspaces').set('Authorization', `Bearer ${jwt}`))
      .body.workspaces[0].id
  })

  beforeEach(() => {
    editableId = uuidv4()
    db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, description, graph_json, status, created_by)
       VALUES (?, ?, 'Before', 'old', ?, 'draft', ?)`
    ).run(editableId, workspaceId, JSON.stringify(GRAPH), userId)
  })

  const put = (flow, token = jwt) =>
    request(app)
      .put(`/api/workflows/${editableId}/flow`)
      .set('Authorization', `Bearer ${token}`)
      .send({ flow })

  it('replaces the graph, the name, and the description together', async () => {
    const res = await put(`workflow "After"
  description: "rewritten"

node only: output-log @ 10,20
  label: "Just this"
  message: "hi"
`)
    expect(res.status).toBe(200)
    expect(res.body.workflow.name).toBe('After')
    expect(res.body.workflow.description).toBe('rewritten')

    const graph = JSON.parse(res.body.workflow.graph_json)
    expect(graph.nodes).toHaveLength(1)
    expect(graph.nodes[0]).toEqual({
      id: 'only',
      type: 'output-log',
      position: { x: 10, y: 20 },
      data: { label: 'Just this', config: { message: 'hi' } },
    })
  })

  it('writes the declared guarantees, because they are lines in the file too', async () => {
    const res = await put(`workflow "Gated"

guarantee requires b a
  note: "why"

node a: trigger-manual
node b: output-log

a -> b
`)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body.workflow.guarantees_json)).toEqual([
      { kind: 'requires', node: 'b', other: 'a', note: 'why' },
    ])
  })

  it('clears guarantees that were removed from the text', async () => {
    db.prepare('UPDATE workflows SET guarantees_json = ? WHERE id = ?')
      .run(JSON.stringify([{ kind: 'requires', node: 'b', other: 'a' }]), editableId)
    const res = await put('workflow "Plain"\nnode a: trigger-manual\n')
    expect(res.body.workflow.guarantees_json).toBeNull()
  })

  it('returns the position of a syntax error, so a cursor can be put on it', async () => {
    const res = await put('workflow "W"\nnode n: action-http\n  method: POST\n')
    expect(res.status).toBe(400)
    expect(res.body.line).toBe(3)
    expect(res.body.column).toBeGreaterThan(1)
    expect(res.body.frame).toContain('method: POST')
    expect(res.body.frame).toContain('^')
  })

  it('leaves the workflow untouched when the text does not parse', async () => {
    await put('workflow "W"\nnonsense\n')
    const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(editableId)
    expect(row.name).toBe('Before')
    expect(JSON.parse(row.graph_json).nodes).toHaveLength(2)
  })

  it('refuses a document with no name', async () => {
    const res = await put('workflow ""\nnode a: trigger-manual\n')
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/needs a name/)
  })

  it('refuses a body that is not a string', async () => {
    const res = await request(app)
      .put(`/api/workflows/${editableId}/flow`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ flow: { nodes: [] } })
    expect(res.status).toBe(400)
  })

  it('refuses a viewer', async () => {
    const viewer = await request(app)
      .post('/api/auth/register')
      .send({ email: 'flowviewer@example.com', password: 'password123', displayName: 'Viewer' })
    const viewerId = db.prepare('SELECT id FROM users WHERE email = ?').get('flowviewer@example.com').id
    db.prepare(
      "INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'viewer', ?)"
    ).run(workspaceId, viewerId, new Date().toISOString())

    const res = await put('workflow "Nope"\n', viewer.body.token)
    expect(res.status).toBe(403)
  })

  it('404s for a workflow the caller cannot see', async () => {
    const other = await request(app)
      .post('/api/auth/register')
      .send({ email: 'flowother@example.com', password: 'password123', displayName: 'Other' })
    const res = await put('workflow "Nope"\n', other.body.token)
    expect(res.status).toBe(404)
  })

  it('round-trips: export the text, put it straight back, nothing changes', async () => {
    const before = db.prepare('SELECT graph_json FROM workflows WHERE id = ?').get(editableId)
    const text = await request(app)
      .get(`/api/workflows/${editableId}/export?format=flow`)
      .set('Authorization', `Bearer ${jwt}`)
      .buffer(true)
      .parse((res, cb) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => {
          body += c
        })
        res.on('end', () => cb(null, body))
      })

    await put(text.body)
    const after = db.prepare('SELECT graph_json FROM workflows WHERE id = ?').get(editableId)

    // Nodes are preserved exactly — but *reordered*, and that is the point
    // rather than a loss: the format sorts by id so two exports of one workflow
    // are byte-identical whatever order each canvas stored them in.
    const byId = (json) => [...JSON.parse(json).nodes].sort((a, b) => (a.id < b.id ? -1 : 1))
    expect(byId(after.graph_json)).toEqual(byId(before.graph_json))
    // Edges by endpoints and handle, not by id. An edge id is a canvas
    // artefact — React Flow mints a new one for a redrawn connection — which is
    // why the signature excludes it and why the format does not carry it.
    const wires = (json) =>
      JSON.parse(json).edges.map((e) => ({ source: e.source, target: e.target, handle: e.sourceHandle ?? null }))
    expect(wires(after.graph_json)).toEqual(wires(before.graph_json))
  })
})
