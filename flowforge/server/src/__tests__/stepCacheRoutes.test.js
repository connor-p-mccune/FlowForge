const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const { app } = require('../index')
const db = require('../config/database')
const { cacheKey, store } = require('../services/stepCache')

describe('step cache routes', () => {
  let token
  let workspaceId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'cache-user@example.com', password: 'password123', displayName: 'Cacher' })
    token = res.body.token
    const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`)
    workspaceId = ws.body.workspaces[0].id
  })

  async function createWorkflow(name) {
    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/workflows`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name })
    return res.body.workflow
  }

  function seedEntries(workflowId, n) {
    for (let i = 0; i < n; i++) {
      store(cacheKey(workflowId, 'transform', { i }, {}), {
        workflowId,
        nodeId: `n${i}`,
        outputJson: '{"v":1}',
        ttlSeconds: 600,
      })
    }
  }

  it('GET reports live entries and hits without exposing payloads', async () => {
    const workflow = await createWorkflow('Cached stats')
    seedEntries(workflow.id, 3)
    db.prepare('UPDATE step_cache SET hits = 4 WHERE workflow_id = ? AND node_id = ?')
      .run(workflow.id, 'n0')

    const res = await request(app)
      .get(`/api/workflows/${workflow.id}/cache`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.cache.entries).toBe(3)
    expect(res.body.cache.hits).toBe(4)
    expect(JSON.stringify(res.body)).not.toContain('"v":1')
  })

  it('GET excludes expired entries from the count', async () => {
    const workflow = await createWorkflow('Cached expiry')
    seedEntries(workflow.id, 2)
    db.prepare(
      'UPDATE step_cache SET expires_at = ? WHERE workflow_id = ? AND node_id = ?'
    ).run(new Date(Date.now() - 1000).toISOString(), workflow.id, 'n0')

    const res = await request(app)
      .get(`/api/workflows/${workflow.id}/cache`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.cache.entries).toBe(1)
  })

  it('DELETE clears the workflow cache and reports the count', async () => {
    const workflow = await createWorkflow('Cached clear')
    seedEntries(workflow.id, 2)

    const res = await request(app)
      .delete(`/api/workflows/${workflow.id}/cache`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.cleared).toBe(2)
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM step_cache WHERE workflow_id = ?').get(workflow.id).n
    ).toBe(0)
  })

  it('hides the cache of a workflow the caller cannot see', async () => {
    const workflow = await createWorkflow('Private cache')
    const other = await request(app)
      .post('/api/auth/register')
      .send({ email: 'cache-other@example.com', password: 'password123', displayName: 'Other' })

    for (const method of ['get', 'delete']) {
      const res = await request(app)[method](`/api/workflows/${workflow.id}/cache`)
        .set('Authorization', `Bearer ${other.body.token}`)
      expect(res.status).toBe(404)
    }
  })

  it('requires authentication', async () => {
    expect((await request(app).get('/api/workflows/x/cache')).status).toBe(401)
    expect((await request(app).delete('/api/workflows/x/cache')).status).toBe(401)
  })
})
