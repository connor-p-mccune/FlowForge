const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const { app } = require('../index')
const { buildAdjacency, topoSort } = require('../services/dagParser')

const EXPECTED_CATEGORIES = [
  'AI Automation',
  'Reporting',
  'Notifications',
  'Data Processing',
  'Resilience',
]

describe('workflow templates', () => {
  let token
  let workspaceId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'tmpl-user@example.com', password: 'password123', displayName: 'Tmpl' })
    token = res.body.token

    const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`)
    workspaceId = ws.body.workspaces[0].id
  })

  function flatten(grouped) {
    return Object.values(grouped).flat()
  }

  describe('GET /api/templates', () => {
    it('is public (no auth required) and groups templates by category', async () => {
      const res = await request(app).get('/api/templates')
      expect(res.status).toBe(200)
      expect(res.body.templates).toBeDefined()

      // Auto-seeded on startup: the six built-in templates across five categories.
      const all = flatten(res.body.templates)
      expect(all).toHaveLength(6)
      for (const cat of EXPECTED_CATEGORIES) {
        expect(res.body.templates[cat]?.length).toBeGreaterThan(0)
      }
    })

    it('returns each template with a parsed { nodes, edges } graph', async () => {
      const res = await request(app).get('/api/templates')
      for (const t of flatten(res.body.templates)) {
        expect(typeof t.id).toBe('string')
        expect(typeof t.name).toBe('string')
        expect(typeof t.description).toBe('string')
        expect(EXPECTED_CATEGORIES).toContain(t.category)
        expect(Array.isArray(t.graph.nodes)).toBe(true)
        expect(Array.isArray(t.graph.edges)).toBe(true)
        expect(t.graph.nodes.length).toBeGreaterThan(0)
      }
    })

    it('ships templates whose graphs are runnable DAGs (no cycles, all wired)', async () => {
      const res = await request(app).get('/api/templates')
      for (const t of flatten(res.body.templates)) {
        const { nodes, edges } = t.graph
        // Every edge references real nodes.
        const ids = new Set(nodes.map((n) => n.id))
        for (const e of edges) {
          expect(ids.has(e.source)).toBe(true)
          expect(ids.has(e.target)).toBe(true)
        }
        // Topological sort succeeds and covers every node.
        const { adj, inDegree } = buildAdjacency(nodes, edges)
        const order = topoSort(nodes, adj, inDegree)
        expect(order).toHaveLength(nodes.length)
      }
    })
  })

  describe('POST /api/workspaces/:wsId/workflows/from-template', () => {
    async function getTemplates() {
      const res = await request(app).get('/api/templates')
      return flatten(res.body.templates)
    }

    it('clones a template into a new, runnable workflow', async () => {
      const [template] = await getTemplates()

      const res = await request(app)
        .post(`/api/workspaces/${workspaceId}/workflows/from-template`)
        .set('Authorization', `Bearer ${token}`)
        .send({ templateId: template.id, name: 'My Cloned Flow' })

      expect(res.status).toBe(201)
      expect(res.body.workflow.name).toBe('My Cloned Flow')
      expect(res.body.workflow.workspace_id).toBe(workspaceId)

      const graph = JSON.parse(res.body.workflow.graph_json)
      expect(graph.nodes).toEqual(template.graph.nodes)
      expect(graph.edges).toEqual(template.graph.edges)
    })

    it('produces a workflow the loader/engine can read back', async () => {
      const templates = await getTemplates()
      // Clone the branching (condition) template specifically to confirm the
      // true/false sourceHandles survive the round-trip.
      const branching = templates.find((t) =>
        t.graph.nodes.some((n) => n.type === 'condition')
      )
      expect(branching).toBeDefined()

      const create = await request(app)
        .post(`/api/workspaces/${workspaceId}/workflows/from-template`)
        .set('Authorization', `Bearer ${token}`)
        .send({ templateId: branching.id, name: 'Branching Flow' })
      expect(create.status).toBe(201)

      const load = await request(app)
        .get(`/api/workflows/${create.body.workflow.id}`)
        .set('Authorization', `Bearer ${token}`)
      expect(load.status).toBe(200)
      const graph = JSON.parse(load.body.workflow.graph_json)
      const handles = graph.edges.map((e) => e.sourceHandle).filter(Boolean).sort()
      expect(handles).toEqual(['false', 'true'])
    })

    it('clones every built-in template successfully', async () => {
      const templates = await getTemplates()
      for (const t of templates) {
        const res = await request(app)
          .post(`/api/workspaces/${workspaceId}/workflows/from-template`)
          .set('Authorization', `Bearer ${token}`)
          .send({ templateId: t.id, name: `Clone of ${t.name}` })
        expect(res.status).toBe(201)
      }
    })

    it('requires authentication', async () => {
      const [template] = await getTemplates()
      const res = await request(app)
        .post(`/api/workspaces/${workspaceId}/workflows/from-template`)
        .send({ templateId: template.id, name: 'Nope' })
      expect(res.status).toBe(401)
    })

    it('validates the request body', async () => {
      const res = await request(app)
        .post(`/api/workspaces/${workspaceId}/workflows/from-template`)
        .set('Authorization', `Bearer ${token}`)
        .send({ templateId: 'x' }) // missing name
      expect(res.status).toBe(400)
    })

    it('404s for an unknown template id', async () => {
      const res = await request(app)
        .post(`/api/workspaces/${workspaceId}/workflows/from-template`)
        .set('Authorization', `Bearer ${token}`)
        .send({ templateId: 'does-not-exist', name: 'Ghost' })
      expect(res.status).toBe(404)
    })

    it('hides the clone endpoint from non-members', async () => {
      const [template] = await getTemplates()
      const other = await request(app)
        .post('/api/auth/register')
        .send({ email: 'tmpl-other@example.com', password: 'password123', displayName: 'Other' })

      const res = await request(app)
        .post(`/api/workspaces/${workspaceId}/workflows/from-template`)
        .set('Authorization', `Bearer ${other.body.token}`)
        .send({ templateId: template.id, name: 'Sneaky' })
      expect(res.status).toBe(404)
    })
  })
})
