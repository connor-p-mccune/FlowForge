// Cross-workflow dependency / impact analysis: what a workflow calls
// (sub-workflow / for-each nodes, error handler), what calls it, and stale
// cross-workflow reference cycles.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))

const { app } = require('../index')
const db = require('../config/database')
const { referencesOf, findCycleThrough } = require('../services/workflowDependencies')

describe('workflowDependencies (unit)', () => {
  it('extracts sub-workflow, for-each, and error-handler references, dropping self', () => {
    const wf = {
      id: 'a',
      error_workflow_id: 'b',
      graph_json: JSON.stringify({
        nodes: [
          { id: 'n1', type: 'sub-workflow', data: { config: { workflowId: 'b' } } },
          { id: 'n2', type: 'for-each', data: { config: { workflowId: 'c' } } },
          { id: 'n3', type: 'sub-workflow', data: { config: { workflowId: 'a' } } }, // self — ignored
          { id: 'n4', type: 'action-http', data: { config: {} } },
        ],
      }),
    }
    const refs = referencesOf(wf)
    expect([...refs.get('b')].sort()).toEqual(['error-handler', 'sub-workflow'])
    expect([...refs.get('c')]).toEqual(['for-each'])
    expect(refs.has('a')).toBe(false)
  })

  it('tolerates an unparseable graph', () => {
    const refs = referencesOf({ id: 'a', graph_json: 'not json', error_workflow_id: null })
    expect(refs.size).toBe(0)
  })

  it('finds a cycle a workflow participates in, or returns null', () => {
    const edges = new Map([
      ['a', new Map([['b', new Set(['sub-workflow'])]])],
      ['b', new Map([['a', new Set(['sub-workflow'])]])],
      ['c', new Map()],
    ])
    expect(findCycleThrough('a', edges)).toEqual(['a', 'b', 'a'])
    expect(findCycleThrough('c', edges)).toBeNull()
  })
})

describe('GET /api/workflows/:id/dependencies', () => {
  let jwt
  let workspaceId
  let a
  let b
  let c

  const authed = (req) => req.set('Authorization', `Bearer ${jwt}`)

  const setGraph = (id, nodes) =>
    authed(request(app).put(`/api/workflows/${id}/graph`)).send({ nodes, edges: [] })

  const create = async (name) =>
    (await authed(request(app).post(`/api/workspaces/${workspaceId}/workflows`)).send({ name })).body
      .workflow.id

  beforeAll(async () => {
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ email: 'deps@example.com', password: 'password123', displayName: 'Deps' })
    jwt = reg.body.token
    workspaceId = (await authed(request(app).get('/api/workspaces'))).body.workspaces[0].id
    a = await create('Orchestrator')
    b = await create('Send alert')
    c = await create('Per item')

    // A calls B (sub-workflow) and C (for-each), and escalates to B on failure.
    await setGraph(a, [
      { id: 'n1', type: 'sub-workflow', position: { x: 0, y: 0 }, data: { config: { workflowId: b } } },
      { id: 'n2', type: 'for-each', position: { x: 0, y: 0 }, data: { config: { workflowId: c } } },
    ])
    db.prepare('UPDATE workflows SET error_workflow_id = ? WHERE id = ?').run(b, a)
  })

  it('reports what a workflow depends on, aggregating the relationship kinds', async () => {
    const res = await authed(request(app).get(`/api/workflows/${a}/dependencies`))
    expect(res.status).toBe(200)
    expect(res.body.workflowId).toBe(a)

    const dep = Object.fromEntries(res.body.dependsOn.map((d) => [d.name, d]))
    expect(dep['Send alert'].via).toEqual(['error-handler', 'sub-workflow'])
    expect(dep['Per item'].via).toEqual(['for-each'])
    expect(res.body.dependedOnBy).toEqual([])
    expect(res.body.cycle).toBeNull()
  })

  it('reports what depends on a workflow (impact of changing it)', async () => {
    const res = await authed(request(app).get(`/api/workflows/${b}/dependencies`))
    expect(res.status).toBe(200)
    expect(res.body.dependsOn).toEqual([])
    const callers = res.body.dependedOnBy.map((d) => d.name)
    expect(callers).toEqual(['Orchestrator'])
  })

  it('ignores a reference to a workflow outside the workspace (dangling)', async () => {
    await setGraph(c, [
      { id: 'n1', type: 'sub-workflow', position: { x: 0, y: 0 }, data: { config: { workflowId: 'ghost-id' } } },
    ])
    const res = await authed(request(app).get(`/api/workflows/${c}/dependencies`))
    expect(res.body.dependsOn).toEqual([])
  })

  it('detects a stale cross-workflow cycle', async () => {
    // Make B call A back — A→B→A, a cycle that would fail at run time.
    await setGraph(b, [
      { id: 'n1', type: 'sub-workflow', position: { x: 0, y: 0 }, data: { config: { workflowId: a } } },
    ])
    const res = await authed(request(app).get(`/api/workflows/${a}/dependencies`))
    expect(res.body.cycle).toEqual([a, b, a])
  })

  it('404s a workflow the caller cannot see', async () => {
    const other = await request(app)
      .post('/api/auth/register')
      .send({ email: 'deps-other@example.com', password: 'password123', displayName: 'Other' })
    const res = await request(app)
      .get(`/api/workflows/${a}/dependencies`)
      .set('Authorization', `Bearer ${other.body.token}`)
    expect(res.status).toBe(404)
  })

  it('is available on the public API under the read scope', async () => {
    const token = (
      await authed(request(app).post('/api/tokens')).send({ name: 'deps-read', scopes: ['read'] })
    ).body.token
    const res = await request(app)
      .get(`/api/v1/workflows/${a}/dependencies`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.workflowId).toBe(a)
    expect(res.body.dependsOn.map((d) => d.name).sort()).toEqual(['Per item', 'Send alert'])
  })
})
