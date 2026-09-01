// The served OpenAPI document: available without a token, structurally sound,
// and in sync with the routes the public router actually mounts.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))

const { app } = require('../index')

describe('GET /api/v1/openapi.json', () => {
  it('serves the spec without authentication', async () => {
    const res = await request(app).get('/api/v1/openapi.json')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(res.body.openapi).toBe('3.0.3')
    expect(res.body.info.title).toMatch(/FlowForge/)
  })

  it('documents every public endpoint with its scope requirements', async () => {
    const { body: spec } = await request(app).get('/api/v1/openapi.json')
    expect(Object.keys(spec.paths).sort()).toEqual([
      '/approvals',
      '/approvals/{approvalId}/respond',
      '/executions/{executionId}',
      '/executions/{executionId}/breaks',
      '/executions/{executionId}/breaks/{breakId}/resume',
      '/executions/{executionId}/cancel',
      '/executions/{executionId}/compare/{otherExecutionId}',
      '/executions/{executionId}/resume',
      '/executions/{executionId}/rollback',
      '/executions/{executionId}/schedule',
      '/search',
      '/subjects/access',
      '/subjects/erasure',
      '/workflows',
      '/workflows/{workflowId}/assertions',
      '/workflows/{workflowId}/backfill',
      '/workflows/{workflowId}/backfills',
      '/workflows/{workflowId}/canary',
      '/workflows/{workflowId}/canary/promote',
      '/workflows/{workflowId}/canary/rollback',
      '/workflows/{workflowId}/capacity',
      '/workflows/{workflowId}/contract',
      '/workflows/{workflowId}/convergence',
      '/workflows/{workflowId}/dependencies',
      '/workflows/{workflowId}/diff',
      '/workflows/{workflowId}/drift',
      '/workflows/{workflowId}/effects',
      '/workflows/{workflowId}/executions',
      '/workflows/{workflowId}/export',
      '/workflows/{workflowId}/forecast',
      '/workflows/{workflowId}/guarantees',
      '/workflows/{workflowId}/insights',
      '/workflows/{workflowId}/lineage',
      '/workflows/{workflowId}/lint',
      '/workflows/{workflowId}/merge',
      '/workflows/{workflowId}/mutations',
      '/workflows/{workflowId}/paths',
      '/workflows/{workflowId}/pause',
      '/workflows/{workflowId}/preview',
      '/workflows/{workflowId}/query',
      '/workflows/{workflowId}/reach',
      '/workflows/{workflowId}/regressions',
      '/workflows/{workflowId}/resume',
      '/workflows/{workflowId}/schedule',
      '/workflows/{workflowId}/tests/run',
      '/workflows/{workflowId}/trigger',
      '/workflows/{workflowId}/types',
      '/workspaces',
      '/workspaces/{workspaceId}/audit',
      '/workspaces/{workspaceId}/audit/verify',
      '/workspaces/{workspaceId}/workflows/import',
    ])
    // Bearer auth is the declared scheme, applied globally.
    expect(spec.components.securitySchemes.bearerAuth.scheme).toBe('bearer')
    expect(spec.security).toEqual([{ bearerAuth: [] }])
  })

  it('declares the full execution status lifecycle, including cancelled', async () => {
    const { body: spec } = await request(app).get('/api/v1/openapi.json')
    expect(spec.components.schemas.ExecutionStatus.enum).toEqual([
      'pending',
      'running',
      'completed',
      'failed',
      'cancelled',
    ])
  })

  it('every documented operation carries at least one 2xx and the shared error responses', async () => {
    const { body: spec } = await request(app).get('/api/v1/openapi.json')
    for (const ops of Object.values(spec.paths)) {
      for (const op of Object.values(ops)) {
        const codes = Object.keys(op.responses)
        expect(codes.some((c) => c.startsWith('2'))).toBe(true)
        expect(codes).toContain('401')
        expect(op.operationId).toBeTruthy()
        expect(op.summary).toBeTruthy()
      }
    }
  })
})

// The test above pins what the *spec* says. This asks the *router*, which is
// the direction the drift actually goes: a route gets added to serve a feature,
// and writing the spec entry is the step somebody forgets. An endpoint nobody
// can find in the documentation is an endpoint nobody uses.
describe('the spec against the router', () => {
  const fs = require('fs')
  const nodePath = require('path')

  it('documents every route the public router mounts', async () => {
    const { body: spec } = await request(app).get('/api/v1/openapi.json')
    const source = fs.readFileSync(
      nodePath.join(__dirname, '..', 'routes', 'publicApi.js'),
      'utf8'
    )

    // Compared on shape rather than on parameter names: the spec names its
    // parameters (`{workflowId}`) and Express does not (`:id`).
    const shapeOf = (route) =>
      route.replace(/:[A-Za-z]+/g, '{}').replace(/\{[A-Za-z]+\}/g, '{}')
    const documented = new Set(Object.keys(spec.paths).map(shapeOf))

    const undocumented = []
    const pattern = /router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g
    let match = pattern.exec(source)
    while (match) {
      const [, method, route] = match
      // The spec cannot document the endpoint that serves the spec.
      if (route !== '/openapi.json' && !documented.has(shapeOf(route))) {
        undocumented.push(`${method.toUpperCase()} ${route}`)
      }
      match = pattern.exec(source)
    }

    expect(undocumented).toEqual([])
  })

  it('finds the routes at all, so the check cannot pass by matching nothing', () => {
    // A regex that stopped matching would make the test above vacuously green,
    // which is the failure mode of every source-scanning check.
    const source = fs.readFileSync(
      nodePath.join(__dirname, '..', 'routes', 'publicApi.js'),
      'utf8'
    )
    const mounted = source.match(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g) || []
    expect(mounted.length).toBeGreaterThan(40)
  })
})
