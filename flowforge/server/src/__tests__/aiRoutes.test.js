const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const mockCall = jest.fn()
jest.mock('../services/aiClient', () => ({ callAiService: (...args) => mockCall(...args) }))

const { app } = require('../index')

describe('POST /api/ai/suggest', () => {
  let token

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'ai-user@example.com', password: 'password123', displayName: 'AI' })
    token = res.body.token
  })

  beforeEach(() => mockCall.mockReset())

  it('proxies suggestions from the AI service', async () => {
    const suggestions = [{ type: 'action-http', label: 'Fetch', reason: 'next' }]
    mockCall.mockResolvedValue({ suggestions })

    const res = await request(app)
      .post('/api/ai/suggest')
      .set('Authorization', `Bearer ${token}`)
      .send({ nodes: [], edges: [], lastNodeType: 'trigger-manual' })

    expect(res.status).toBe(200)
    expect(res.body.suggestions).toEqual(suggestions)
    expect(mockCall).toHaveBeenCalledWith('/suggest', {
      nodes: [],
      edges: [],
      lastNodeType: 'trigger-manual',
    })
  })

  it('returns 502 when the AI service fails', async () => {
    mockCall.mockRejectedValue(new Error('AI service unavailable: boom'))
    const res = await request(app)
      .post('/api/ai/suggest')
      .set('Authorization', `Bearer ${token}`)
      .send({ nodes: [], edges: [] })
    expect(res.status).toBe(502)
    expect(res.body.error).toMatch(/unavailable/)
  })

  it('validates that nodes and edges are arrays', async () => {
    const res = await request(app)
      .post('/api/ai/suggest')
      .set('Authorization', `Bearer ${token}`)
      .send({ nodes: 'nope', edges: [] })
    expect(res.status).toBe(400)
  })

  it('requires authentication', async () => {
    const res = await request(app).post('/api/ai/suggest').send({ nodes: [], edges: [] })
    expect(res.status).toBe(401)
  })
})
