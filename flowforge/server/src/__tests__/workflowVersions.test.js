const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const { app } = require('../index')

// A single trigger node — the "version 1" graph.
const graphA = {
  nodes: [
    { id: 'n1', type: 'trigger-manual', position: { x: 0, y: 0 }, data: { label: 'Start' } },
  ],
  edges: [],
}

// Trigger + log node, wired together — the modified "version 2" graph.
const graphB = {
  nodes: [
    { id: 'n1', type: 'trigger-manual', position: { x: 0, y: 0 }, data: { label: 'Start' } },
    { id: 'n2', type: 'output-log', position: { x: 0, y: 120 }, data: { label: 'Log' } },
  ],
  edges: [{ id: 'e1', source: 'n1', target: 'n2', sourceHandle: null, targetHandle: null }],
}

describe('workflow version history & rollback', () => {
  let token
  let workspaceId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'versioner@example.com', password: 'password123', displayName: 'Versioner' })
    token = res.body.token

    const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`)
    workspaceId = ws.body.workspaces[0].id
  })

  const authed = (req) => req.set('Authorization', `Bearer ${token}`)

  async function createWorkflow(name = 'Versioned Flow') {
    const res = await authed(
      request(app).post(`/api/workspaces/${workspaceId}/workflows`).send({ name })
    )
    return res.body.workflow
  }

  function saveGraph(id, graph) {
    return authed(request(app).put(`/api/workflows/${id}/graph`).send(graph))
  }

  it('runs the full cycle: deploy → modify → deploy again → restore to v1', async () => {
    const wf = await createWorkflow()

    // Build + deploy version 1
    await saveGraph(wf.id, graphA)
    const deploy1 = await authed(request(app).post(`/api/workflows/${wf.id}/deploy`))
    expect(deploy1.status).toBe(201)
    expect(deploy1.body.version.version).toBe(1)
    expect(deploy1.body.version.created_by_name).toBe('Versioner')
    const v1Id = deploy1.body.version.id

    // Modify + deploy version 2
    await saveGraph(wf.id, graphB)
    const deploy2 = await authed(request(app).post(`/api/workflows/${wf.id}/deploy`))
    expect(deploy2.status).toBe(201)
    expect(deploy2.body.version.version).toBe(2)

    // List shows both, newest first, with deployer attribution
    const list = await authed(request(app).get(`/api/workflows/${wf.id}/versions`))
    expect(list.status).toBe(200)
    expect(list.body.versions.map((v) => v.version)).toEqual([2, 1])
    expect(list.body.versions[0]).toHaveProperty('id')
    expect(list.body.versions[0]).toHaveProperty('created_at')
    expect(list.body.versions[0]).toHaveProperty('created_by')
    expect(list.body.versions[0].created_by_name).toBe('Versioner')

    // Fetching a single version returns its full graph
    const v1 = await authed(request(app).get(`/api/workflows/${wf.id}/versions/${v1Id}`))
    expect(v1.status).toBe(200)
    expect(v1.body.version).toBe(1)
    expect(v1.body.graph_data).toEqual(graphA)

    // Restore to version 1
    const restore = await authed(
      request(app).post(`/api/workflows/${wf.id}/versions/${v1Id}/restore`)
    )
    expect(restore.status).toBe(200)
    // The live workflow now matches version 1
    expect(JSON.parse(restore.body.workflow.graph_json)).toEqual(graphA)

    // ...confirmed by re-fetching the workflow
    const reload = await authed(request(app).get(`/api/workflows/${wf.id}`))
    expect(JSON.parse(reload.body.workflow.graph_json)).toEqual(graphA)

    // Restore was reversible: a new version (3) captured the pre-restore state (graphB)
    const afterList = await authed(request(app).get(`/api/workflows/${wf.id}/versions`))
    expect(afterList.body.versions.map((v) => v.version)).toEqual([3, 2, 1])
    const v3Id = afterList.body.versions[0].id
    const v3 = await authed(request(app).get(`/api/workflows/${wf.id}/versions/${v3Id}`))
    expect(v3.body.graph_data).toEqual(graphB)
  })

  it('deploys an empty graph as version 1', async () => {
    const wf = await createWorkflow('Empty Deploy')
    const deploy = await authed(request(app).post(`/api/workflows/${wf.id}/deploy`))
    expect(deploy.status).toBe(201)
    expect(deploy.body.version.version).toBe(1)

    const v = await authed(
      request(app).get(`/api/workflows/${wf.id}/versions/${deploy.body.version.id}`)
    )
    expect(v.body.graph_data).toEqual({ nodes: [], edges: [] })
  })

  it('404s on an unknown version id', async () => {
    const wf = await createWorkflow('Unknown Version')
    const res = await authed(request(app).get(`/api/workflows/${wf.id}/versions/does-not-exist`))
    expect(res.status).toBe(404)

    const restore = await authed(
      request(app).post(`/api/workflows/${wf.id}/versions/does-not-exist/restore`)
    )
    expect(restore.status).toBe(404)
  })

  it("does not leak another workflow's version through a mismatched id", async () => {
    const a = await createWorkflow('Flow A')
    const b = await createWorkflow('Flow B')
    await saveGraph(a.id, graphA)
    const deploy = await authed(request(app).post(`/api/workflows/${a.id}/deploy`))
    const versionId = deploy.body.version.id

    // The version belongs to A, so requesting it under B's id must 404
    const res = await authed(request(app).get(`/api/workflows/${b.id}/versions/${versionId}`))
    expect(res.status).toBe(404)
  })

  it('hides version history and blocks deploy/restore for non-members', async () => {
    const other = await request(app)
      .post('/api/auth/register')
      .send({ email: 'ver-other@example.com', password: 'password123', displayName: 'Other' })
    const otherToken = other.body.token
    const wf = await createWorkflow('Private Versions')
    const deploy = await authed(request(app).post(`/api/workflows/${wf.id}/deploy`))
    const versionId = deploy.body.version.id

    const list = await request(app)
      .get(`/api/workflows/${wf.id}/versions`)
      .set('Authorization', `Bearer ${otherToken}`)
    expect(list.status).toBe(404)

    const deployAsOther = await request(app)
      .post(`/api/workflows/${wf.id}/deploy`)
      .set('Authorization', `Bearer ${otherToken}`)
    expect(deployAsOther.status).toBe(404)

    const restoreAsOther = await request(app)
      .post(`/api/workflows/${wf.id}/versions/${versionId}/restore`)
      .set('Authorization', `Bearer ${otherToken}`)
    expect(restoreAsOther.status).toBe(404)
  })

  it('requires auth', async () => {
    const wf = await createWorkflow('Needs Auth')
    const res = await request(app).get(`/api/workflows/${wf.id}/versions`)
    expect(res.status).toBe(401)
  })
})
