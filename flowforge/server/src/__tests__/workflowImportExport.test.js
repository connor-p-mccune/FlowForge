const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const { app } = require('../index')

// A small but non-trivial graph: a branch with true/false handles, node positions,
// and config — the kind of detail an export must preserve byte-for-byte.
const complexGraph = {
  nodes: [
    { id: 'n1', type: 'trigger-webhook', position: { x: 0, y: 0 }, data: { label: 'Webhook', config: { path: '/hook' } } },
    { id: 'n2', type: 'condition', position: { x: 0, y: 120 }, data: { label: 'Check', config: { field: 'x', op: 'gt', value: 5 } } },
    { id: 'n3', type: 'action-email', position: { x: -120, y: 240 }, data: { label: 'Email', config: { to: 'a@b.c' } } },
    { id: 'n4', type: 'output-log', position: { x: 120, y: 240 }, data: { label: 'Log' } },
  ],
  edges: [
    { id: 'e1', source: 'n1', target: 'n2', sourceHandle: null, targetHandle: null },
    { id: 'e2', source: 'n2', target: 'n3', sourceHandle: 'true', targetHandle: null },
    { id: 'e3', source: 'n2', target: 'n4', sourceHandle: 'false', targetHandle: null },
  ],
}

describe('workflow import & export', () => {
  let token
  let workspaceId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'porter@example.com', password: 'password123', displayName: 'Porter' })
    token = res.body.token

    const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`)
    workspaceId = ws.body.workspaces[0].id
  })

  const authed = (req) => req.set('Authorization', `Bearer ${token}`)

  async function createWorkflow(name = 'Exportable Flow') {
    const res = await authed(request(app).post(`/api/workspaces/${workspaceId}/workflows`).send({ name }))
    return res.body.workflow
  }
  function saveGraph(id, graph) {
    return authed(request(app).put(`/api/workflows/${id}/graph`).send(graph))
  }

  describe('GET /api/workflows/:id/export', () => {
    it('returns a clean export envelope and strips internal fields', async () => {
      const wf = await createWorkflow('My Export')
      await saveGraph(wf.id, complexGraph)

      const res = await authed(request(app).get(`/api/workflows/${wf.id}/export`))
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({
        exportVersion: '1.0',
        name: 'My Export',
        graph_data: complexGraph,
      })
      expect(typeof res.body.exportedAt).toBe('string')
      // No internal / ownership fields leak into the file.
      expect(res.body.id).toBeUndefined()
      expect(res.body.workspace_id).toBeUndefined()
      expect(res.body.created_by).toBeUndefined()
      expect(res.body.graph_json).toBeUndefined()
    })

    it('requires auth and hides workflows from non-members (404)', async () => {
      const wf = await createWorkflow()

      const anon = await request(app).get(`/api/workflows/${wf.id}/export`)
      expect(anon.status).toBe(401)

      const other = await request(app)
        .post('/api/auth/register')
        .send({ email: 'porter-other@example.com', password: 'password123', displayName: 'Other' })
      const res = await request(app)
        .get(`/api/workflows/${wf.id}/export`)
        .set('Authorization', `Bearer ${other.body.token}`)
      expect(res.status).toBe(404)
    })

    it('404s for an unknown workflow', async () => {
      const res = await authed(request(app).get('/api/workflows/does-not-exist/export'))
      expect(res.status).toBe(404)
    })
  })

  describe('POST /api/workspaces/:wsId/workflows/import', () => {
    it('creates a new draft workflow from an export', async () => {
      const res = await authed(
        request(app)
          .post(`/api/workspaces/${workspaceId}/workflows/import`)
          .send({ name: 'Imported Flow', graph_data: complexGraph })
      )
      expect(res.status).toBe(201)
      expect(res.body.workflow.name).toBe('Imported Flow')
      expect(res.body.workflow.workspace_id).toBe(workspaceId)
      expect(res.body.workflow.status).toBe('draft')
      expect(JSON.parse(res.body.workflow.graph_json)).toEqual(complexGraph)
    })

    it('round-trips: export then import reproduces an identical graph', async () => {
      const wf = await createWorkflow('Round Trip')
      await saveGraph(wf.id, complexGraph)
      const exported = await authed(request(app).get(`/api/workflows/${wf.id}/export`))

      const imported = await authed(
        request(app)
          .post(`/api/workspaces/${workspaceId}/workflows/import`)
          .send({ name: exported.body.name, graph_data: exported.body.graph_data })
      )
      expect(imported.status).toBe(201)

      // Load it back the way the canvas would and confirm the graph is identical.
      const loaded = await authed(request(app).get(`/api/workflows/${imported.body.workflow.id}`))
      expect(JSON.parse(loaded.body.workflow.graph_json)).toEqual(complexGraph)
    })

    it('persists only nodes/edges, dropping other top-level keys', async () => {
      const res = await authed(
        request(app)
          .post(`/api/workspaces/${workspaceId}/workflows/import`)
          .send({ name: 'Sneaky', graph_data: { nodes: [], edges: [], evil: 'x', viewport: { x: 1 } } })
      )
      expect(res.status).toBe(201)
      expect(JSON.parse(res.body.workflow.graph_json)).toEqual({ nodes: [], edges: [] })
    })

    it('rejects a missing name', async () => {
      const res = await authed(
        request(app)
          .post(`/api/workspaces/${workspaceId}/workflows/import`)
          .send({ graph_data: { nodes: [], edges: [] } })
      )
      expect(res.status).toBe(400)
    })

    it('rejects a missing graph_data', async () => {
      const res = await authed(
        request(app).post(`/api/workspaces/${workspaceId}/workflows/import`).send({ name: 'No graph' })
      )
      expect(res.status).toBe(400)
    })

    it('rejects graph_data without nodes/edges arrays', async () => {
      const res = await authed(
        request(app)
          .post(`/api/workspaces/${workspaceId}/workflows/import`)
          .send({ name: 'Bad shape', graph_data: { nodes: {}, edges: [] } })
      )
      expect(res.status).toBe(400)
    })

    it('rejects a graph larger than 500KB', async () => {
      // Build a graph whose serialized form comfortably exceeds 500KB but stays
      // under the global 2mb body cap.
      const nodes = []
      for (let i = 0; i < 4000; i++) {
        nodes.push({ id: `n${i}`, type: 'output-log', position: { x: i, y: i }, data: { label: 'x'.repeat(120) } })
      }
      const res = await authed(
        request(app)
          .post(`/api/workspaces/${workspaceId}/workflows/import`)
          .send({ name: 'Too big', graph_data: { nodes, edges: [] } })
      )
      expect(res.status).toBe(413)
    })

    it('requires auth and blocks non-members', async () => {
      const anon = await request(app)
        .post(`/api/workspaces/${workspaceId}/workflows/import`)
        .send({ name: 'x', graph_data: { nodes: [], edges: [] } })
      expect(anon.status).toBe(401)

      const other = await request(app)
        .post('/api/auth/register')
        .send({ email: 'porter-nonmember@example.com', password: 'password123', displayName: 'NM' })
      const res = await request(app)
        .post(`/api/workspaces/${workspaceId}/workflows/import`)
        .set('Authorization', `Bearer ${other.body.token}`)
        .send({ name: 'x', graph_data: { nodes: [], edges: [] } })
      expect(res.status).toBe(404)
    })
  })
})
