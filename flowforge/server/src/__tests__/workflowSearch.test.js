// Full-text workflow search: the FTS5 document build, lazy reindex-on-read,
// match expression hardening, ranking, and the /api/search route's scoping.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const { app } = require('../index')
const db = require('../config/database')
const {
  searchWorkflows,
  reindexWorkspace,
  nodeTextOf,
  toMatchExpression,
} = require('../services/workflowSearch')

describe('nodeTextOf', () => {
  it('flattens labels, types, config strings, and note text — not keys', () => {
    const graph = JSON.stringify({
      nodes: [
        {
          id: 'h1', type: 'action-http',
          data: { label: 'Charge card', config: { url: 'https://api.stripe.com/v1/charges', headers: '{}' } },
        },
        { id: 'n1', type: 'note', data: { label: '', config: { text: 'rotate the key quarterly' } } },
      ],
      edges: [],
    })
    const text = nodeTextOf(graph)
    expect(text).toContain('Charge card')
    expect(text).toContain('api.stripe.com')
    expect(text).toContain('rotate the key quarterly')
    expect(text).not.toContain('headers') // keys would make every doc match "url"
  })

  it('tolerates corrupt graph json', () => {
    expect(nodeTextOf('not json')).toBe('')
  })
})

describe('toMatchExpression', () => {
  it('quotes terms and prefix-matches the last one', () => {
    expect(toMatchExpression('stripe char')).toBe('"stripe" "char"*')
  })

  it('cannot be turned into FTS5 syntax', () => {
    // Operators, quotes, and parens ride inside quoted phrases or vanish.
    expect(toMatchExpression('a" OR "b')).toBe('"a" "OR" "b"*')
    expect(toMatchExpression('   ')).toBeNull()
    expect(toMatchExpression('NEAR(')).toBe('"NEAR("*')
  })
})

describe('searchWorkflows', () => {
  let jwt
  let workspaceId

  async function register(email) {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email, password: 'password123', displayName: 'Seeker' })
    const ws = await request(app)
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${res.body.token}`)
    return { jwt: res.body.token, workspaceId: ws.body.workspaces[0].id }
  }

  async function createWorkflow(token, wsId, name, graph) {
    const res = await request(app)
      .post(`/api/workspaces/${wsId}/workflows`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name })
    if (graph) {
      await request(app)
        .put(`/api/workflows/${res.body.workflow.id}/graph`)
        .set('Authorization', `Bearer ${token}`)
        .send(graph)
    }
    return res.body.workflow
  }

  const httpGraph = (url) => ({
    nodes: [
      { id: 't1', type: 'trigger-manual', position: { x: 0, y: 0 }, data: { label: 'Start', config: {} } },
      { id: 'h1', type: 'action-http', position: { x: 0, y: 0 }, data: { label: 'Call API', config: { method: 'GET', url, headers: '{}' } } },
    ],
    edges: [{ id: 't1-h1', source: 't1', target: 'h1' }],
  })

  beforeAll(async () => {
    const creds = await register('search@example.com')
    jwt = creds.jwt
    workspaceId = creds.workspaceId
  })

  it('finds a workflow by what is inside its nodes', async () => {
    const wf = await createWorkflow(jwt, workspaceId, 'Payments sync', httpGraph('https://api.stripe.com/v1/charges'))
    const results = searchWorkflows([workspaceId], 'stripe')
    const hit = results.find((r) => r.workflowId === wf.id)
    expect(hit).toBeDefined()
    expect(hit.field).toBe('nodes')
    expect(hit.snippet).toContain('[stripe')
  })

  it('ranks a name match above a config mention', async () => {
    const named = await createWorkflow(jwt, workspaceId, 'Zendesk escalation', httpGraph('https://example.com'))
    const mention = await createWorkflow(jwt, workspaceId, 'Misc chores', httpGraph('https://api.zendesk.com/tickets'))
    const results = searchWorkflows([workspaceId], 'zendesk')
    const ids = results.map((r) => r.workflowId)
    expect(ids.indexOf(named.id)).toBeGreaterThanOrEqual(0)
    expect(ids.indexOf(mention.id)).toBeGreaterThanOrEqual(0)
    expect(ids.indexOf(named.id)).toBeLessThan(ids.indexOf(mention.id))
  })

  it('reindexes lazily when a workflow changes', async () => {
    const wf = await createWorkflow(jwt, workspaceId, 'Mutable', httpGraph('https://old-vendor.example.com'))
    expect(searchWorkflows([workspaceId], 'oldvendor').length).toBe(0)
    expect(searchWorkflows([workspaceId], 'old vendor').some((r) => r.workflowId === wf.id)).toBe(true)

    await request(app)
      .put(`/api/workflows/${wf.id}/graph`)
      .set('Authorization', `Bearer ${jwt}`)
      .send(httpGraph('https://new-vendor.example.com'))

    expect(searchWorkflows([workspaceId], 'old vendor').some((r) => r.workflowId === wf.id)).toBe(false)
    expect(searchWorkflows([workspaceId], 'new vendor').some((r) => r.workflowId === wf.id)).toBe(true)
  })

  it('drops (and sweeps) documents of deleted workflows', async () => {
    const wf = await createWorkflow(jwt, workspaceId, 'Ephemeral doomed thing', null)
    reindexWorkspace(workspaceId)
    expect(searchWorkflows([workspaceId], 'doomed').some((r) => r.workflowId === wf.id)).toBe(true)

    await request(app).delete(`/api/workflows/${wf.id}`).set('Authorization', `Bearer ${jwt}`)
    expect(searchWorkflows([workspaceId], 'doomed').some((r) => r.workflowId === wf.id)).toBe(false)
    // The orphaned document was swept when the search noticed it.
    const orphan = db.prepare('SELECT COUNT(*) AS n FROM workflow_fts WHERE workflow_id = ?').get(wf.id)
    expect(orphan.n).toBe(0)
  })

  it('never leaks across workspaces', async () => {
    const other = await register('search-other@example.com')
    await createWorkflow(other.jwt, other.workspaceId, 'Secret rocket plans', null)
    expect(searchWorkflows([workspaceId], 'rocket')).toEqual([])
  })
})

describe('GET /api/search', () => {
  let jwt

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'search-route@example.com', password: 'password123', displayName: 'Router' })
    jwt = res.body.token
    const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${jwt}`)
    await request(app)
      .post(`/api/workspaces/${ws.body.workspaces[0].id}/workflows`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ name: 'Invoice mailer', description: 'sends invoices to accounting' })
  })

  it('returns scoped results with match context', async () => {
    const res = await request(app)
      .get('/api/search?q=invoice')
      .set('Authorization', `Bearer ${jwt}`)
    expect(res.status).toBe(200)
    expect(res.body.results.length).toBeGreaterThan(0)
    expect(res.body.results[0]).toEqual(
      expect.objectContaining({ name: 'Invoice mailer', field: expect.any(String), snippet: expect.any(String) })
    )
    // Another user's workspaces are not searched.
    expect(res.body.results.every((r) => r.name !== 'Secret rocket plans')).toBe(true)
  })

  it('requires a query and auth', async () => {
    expect((await request(app).get('/api/search?q=x')).status).toBe(401)
    const blank = await request(app).get('/api/search').set('Authorization', `Bearer ${jwt}`)
    expect(blank.status).toBe(400)
    const long = await request(app)
      .get(`/api/search?q=${'a'.repeat(201)}`)
      .set('Authorization', `Bearer ${jwt}`)
    expect(long.status).toBe(400)
  })

  it('is exposed on the public API under the read scope', async () => {
    const minted = await request(app)
      .post('/api/tokens')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ name: 'searcher', scopes: ['read'] })
    const pat = minted.body.token

    const res = await request(app)
      .get('/api/v1/search?q=invoice')
      .set('Authorization', `Bearer ${pat}`)
    expect(res.status).toBe(200)
    expect(res.body.results.some((r) => r.name === 'Invoice mailer')).toBe(true)

    // The trigger scope alone can't read.
    const writeOnly = await request(app)
      .post('/api/tokens')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ name: 'trigger-only', scopes: ['trigger'] })
    const denied = await request(app)
      .get('/api/v1/search?q=invoice')
      .set('Authorization', `Bearer ${writeOnly.body.token}`)
    expect(denied.status).toBe(403)
  })
})
