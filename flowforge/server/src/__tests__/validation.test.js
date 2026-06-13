const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const { app } = require('../index')

describe('input validation', () => {
  let token

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'validate@example.com', password: 'password123', displayName: 'Val' })
    token = res.body.token
  })

  it('rejects a malformed email on register', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'not-an-email', password: 'password123', displayName: 'Nope' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/email/i)
  })

  it('rejects an over-long display name', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'long@example.com', password: 'password123', displayName: 'x'.repeat(101) })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/at most/i)
  })

  it('rejects a non-string workspace name', async () => {
    const res = await request(app)
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 12345 })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/must be a string/i)
  })

  it('returns a JSON 404 for unknown API routes', async () => {
    const res = await request(app).get('/api/does-not-exist')
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Not found')
  })

  it('returns a JSON 400 for a malformed JSON body', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{ "email": "x" ') // truncated / invalid JSON
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/invalid json/i)
  })
})
