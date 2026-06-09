const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const { app } = require('../index')

describe('POST /api/auth/register', () => {
  it('creates a user and returns token + user', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'alice@example.com', password: 'password123', displayName: 'Alice' })
    expect(res.status).toBe(201)
    expect(res.body.token).toBeDefined()
    expect(res.body.user.email).toBe('alice@example.com')
    expect(res.body.user.displayName).toBe('Alice')
    expect(res.body.user.password_hash).toBeUndefined()
  })

  it('returns 409 on duplicate email', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'bob@example.com', password: 'pass', displayName: 'Bob' })

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'bob@example.com', password: 'pass', displayName: 'Bob' })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/already in use/i)
  })

  it('returns 400 when fields are missing', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'nope@example.com' })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/auth/login', () => {
  beforeAll(async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'carol@example.com', password: 'secret', displayName: 'Carol' })
  })

  it('returns token on valid credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'carol@example.com', password: 'secret' })
    expect(res.status).toBe(200)
    expect(res.body.token).toBeDefined()
    expect(res.body.user.email).toBe('carol@example.com')
  })

  it('returns 401 on wrong password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'carol@example.com', password: 'wrong' })
    expect(res.status).toBe(401)
    expect(res.body.error).toMatch(/invalid credentials/i)
  })

  it('returns 401 for unknown email', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ghost@example.com', password: 'pass' })
    expect(res.status).toBe(401)
  })
})

describe('GET /api/auth/me', () => {
  let token

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'dave@example.com', password: 'pass', displayName: 'Dave' })
    token = res.body.token
  })

  it('returns user when token is valid', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.user.email).toBe('dave@example.com')
  })

  it('returns 401 when no token provided', async () => {
    const res = await request(app).get('/api/auth/me')
    expect(res.status).toBe(401)
  })

  it('returns 401 when token is invalid', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer bad-token')
    expect(res.status).toBe(401)
  })
})

describe('GET /api/health', () => {
  it('returns ok', async () => {
    const res = await request(app).get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
  })
})
