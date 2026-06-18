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

describe('POST /api/ai/generate', () => {
  let token

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'gen-user@example.com', password: 'password123', displayName: 'Gen' })
    token = res.body.token
  })

  beforeEach(() => mockCall.mockReset())

  const graphData = {
    nodes: [
      { id: 'trigger', type: 'trigger-webhook', position: { x: 0, y: 0 }, data: { label: 'Hook', config: {} } },
      { id: 'slack', type: 'action-slack', position: { x: 0, y: 120 }, data: { label: 'Slack', config: {} } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'slack', sourceHandle: null }],
  }

  it('proxies the generated graph from the AI service', async () => {
    mockCall.mockResolvedValue({ graph_data: graphData })

    const res = await request(app)
      .post('/api/ai/generate')
      .set('Authorization', `Bearer ${token}`)
      .send({ prompt: 'Slack me when a webhook fires' })

    expect(res.status).toBe(200)
    expect(res.body.graph_data).toEqual(graphData)
    expect(mockCall).toHaveBeenCalledWith('/generate', { prompt: 'Slack me when a webhook fires' })
  })

  it('returns 502 when the AI service fails', async () => {
    mockCall.mockRejectedValue(new Error('The model did not return valid JSON'))
    const res = await request(app)
      .post('/api/ai/generate')
      .set('Authorization', `Bearer ${token}`)
      .send({ prompt: 'something vague' })
    expect(res.status).toBe(502)
    expect(res.body.error).toMatch(/valid JSON/)
  })

  it('requires a prompt', async () => {
    const res = await request(app)
      .post('/api/ai/generate')
      .set('Authorization', `Bearer ${token}`)
      .send({})
    expect(res.status).toBe(400)
    expect(mockCall).not.toHaveBeenCalled()
  })

  it('requires authentication', async () => {
    const res = await request(app).post('/api/ai/generate').send({ prompt: 'hi' })
    expect(res.status).toBe(401)
  })
})
