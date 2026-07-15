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
      '/executions/{executionId}/cancel',
      '/executions/{executionId}/compare/{otherExecutionId}',
      '/executions/{executionId}/resume',
      '/workflows',
      '/workflows/{workflowId}/executions',
      '/workflows/{workflowId}/export',
      '/workflows/{workflowId}/forecast',
      '/workflows/{workflowId}/insights',
      '/workflows/{workflowId}/schedule',
      '/workflows/{workflowId}/tests/run',
      '/workflows/{workflowId}/trigger',
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
