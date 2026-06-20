const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

// Opt this suite into rate limiting with a tiny AI budget. Keep the auth limit
// generous so registering the test user doesn't itself get throttled. Set before
// requiring the app so the middleware reads them at module load.
process.env.ENABLE_RATE_LIMIT = 'true'
process.env.AUTH_RATE_LIMIT_MAX = '100'
process.env.AI_RATE_LIMIT_MAX = '3'
process.env.AI_RATE_LIMIT_WINDOW_MS = '60000'

// The webhook trigger / AI service must not touch Redis or the network.
jest.mock('../config/queue', () => ({
  getExecutionQueue: () => ({ add: jest.fn().mockResolvedValue(undefined) }),
}))
jest.mock('../services/aiClient', () => ({
  callAiService: jest.fn().mockResolvedValue({ suggestions: [], graph_data: { nodes: [], edges: [] } }),
}))

const { app } = require('../index')

afterAll(() => {
  delete process.env.ENABLE_RATE_LIMIT
  delete process.env.AUTH_RATE_LIMIT_MAX
  delete process.env.AI_RATE_LIMIT_MAX
  delete process.env.AI_RATE_LIMIT_WINDOW_MS
})

describe('AI endpoint rate limiting', () => {
  let token

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'ai-rl@example.com', password: 'password123', displayName: 'AI RL' })
    token = res.body.token
  })

  it('blocks with 429 once the per-user AI call limit is exceeded', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post('/api/ai/suggest')
        .set('Authorization', `Bearer ${token}`)
        .send({ nodes: [], edges: [] })
      expect(res.status).toBe(200)
    }

    const blocked = await request(app)
      .post('/api/ai/suggest')
      .set('Authorization', `Bearer ${token}`)
      .send({ nodes: [], edges: [] })
    expect(blocked.status).toBe(429)
    expect(blocked.body.error).toMatch(/ai request rate limit/i)
  })

  it('rejects an unauthenticated AI call with 401 (limiter sits behind auth)', async () => {
    const res = await request(app).post('/api/ai/suggest').send({ nodes: [], edges: [] })
    expect(res.status).toBe(401)
  })
})
