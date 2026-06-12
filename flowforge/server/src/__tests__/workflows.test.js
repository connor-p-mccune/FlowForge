const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const { app } = require('../index')

describe('workflow CRUD', () => {
  let token
  let workspaceId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'wf-user@example.com', password: 'password123', displayName: 'Flow' })
    token = res.body.token

    const ws = await request(app)
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${token}`)
    workspaceId = ws.body.workspaces[0].id
  })

  async function createWorkflow(name = 'Test Workflow') {
    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/workflows`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name })
    return res.body.workflow
  }

  it('creates a workflow with an empty graph', async () => {
    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/workflows`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'My Flow', description: 'demo' })
    expect(res.status).toBe(201)
    expect(res.body.workflow.name).toBe('My Flow')
    expect(JSON.parse(res.body.workflow.graph_json)).toEqual({ nodes: [], edges: [] })
  })

  it('lists workflows in a workspace', async () => {
    await createWorkflow('Listed Flow')
    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/workflows`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.workflows.length).toBeGreaterThanOrEqual(1)
  })

  it('saves and reloads graph data', async () => {
    const workflow = await createWorkflow('Graph Flow')
    const nodes = [
      { id: 'n1', type: 'trigger-manual', position: { x: 0, y: 0 }, data: { label: 'Start' } },
      { id: 'n2', type: 'output-log', position: { x: 0, y: 120 }, data: { label: 'Log' } },
    ]
    const edges = [{ id: 'e1', source: 'n1', target: 'n2' }]

    const save = await request(app)
      .put(`/api/workflows/${workflow.id}/graph`)
      .set('Authorization', `Bearer ${token}`)
      .send({ nodes, edges })
    expect(save.status).toBe(200)

    const load = await request(app)
      .get(`/api/workflows/${workflow.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(load.status).toBe(200)
    const graph = JSON.parse(load.body.workflow.graph_json)
    expect(graph.nodes).toEqual(nodes)
    expect(graph.edges).toEqual(edges)
  })

  it('rejects a graph save without arrays', async () => {
    const workflow = await createWorkflow('Bad Graph')
    const res = await request(app)
      .put(`/api/workflows/${workflow.id}/graph`)
      .set('Authorization', `Bearer ${token}`)
      .send({ nodes: 'nope' })
    expect(res.status).toBe(400)
  })

  it('renames a workflow', async () => {
    const workflow = await createWorkflow('Before')
    const res = await request(app)
      .put(`/api/workflows/${workflow.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'After' })
    expect(res.status).toBe(200)
    expect(res.body.workflow.name).toBe('After')
  })

  it('deletes a workflow', async () => {
    const workflow = await createWorkflow('Doomed')
    const del = await request(app)
      .delete(`/api/workflows/${workflow.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(del.status).toBe(204)

    const get = await request(app)
      .get(`/api/workflows/${workflow.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(get.status).toBe(404)
  })

  it('hides workflows from non-members', async () => {
    const other = await request(app)
      .post('/api/auth/register')
      .send({ email: 'wf-other@example.com', password: 'password123', displayName: 'Other' })
    const workflow = await createWorkflow('Private Flow')

    const res = await request(app)
      .get(`/api/workflows/${workflow.id}`)
      .set('Authorization', `Bearer ${other.body.token}`)
    expect(res.status).toBe(404)
  })
})
