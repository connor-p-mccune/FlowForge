const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

// Rate limiting is skipped under NODE_ENV=test by default (other suites fire many
// auth requests). This suite opts in and drives the limiter with small, fast
// limits. These MUST be set before requiring the app so the middleware reads them
// at module load.
process.env.ENABLE_RATE_LIMIT = 'true'
process.env.AUTH_RATE_LIMIT_MAX = '3'
process.env.AUTH_RATE_LIMIT_WINDOW_MS = '60000'
process.env.WEBHOOK_RATE_LIMIT_MAX = '3'
process.env.WEBHOOK_RATE_LIMIT_WINDOW_MS = '60000'

// The webhook trigger enqueues to Bull/Redis — stub it so nothing touches Redis.
jest.mock('../config/queue', () => ({
  getExecutionQueue: () => ({ add: jest.fn().mockResolvedValue(undefined) }),
}))

const { app } = require('../index')

afterAll(() => {
  // Don't let this suite's opt-in leak into other suites sharing the process.
  delete process.env.ENABLE_RATE_LIMIT
  delete process.env.AUTH_RATE_LIMIT_MAX
  delete process.env.AUTH_RATE_LIMIT_WINDOW_MS
  delete process.env.WEBHOOK_RATE_LIMIT_MAX
  delete process.env.WEBHOOK_RATE_LIMIT_WINDOW_MS
})

describe('rate limiting', () => {
  // Each endpoint has its own limiter instance (independent counter), so the
  // three blocks below don't interfere with one another.

  describe('POST /api/auth/login (strict)', () => {
    it('blocks with 429 once the per-IP attempt limit is exceeded', async () => {
      const creds = { email: 'rl-login@example.com', password: 'wrongpass' }

      // The first MAX (3) attempts are processed normally (401 — bad creds).
      for (let i = 0; i < 3; i++) {
        const res = await request(app).post('/api/auth/login').send(creds)
        expect(res.status).toBe(401)
      }

      // The next attempt from the same IP is rejected by the limiter.
      const blocked = await request(app).post('/api/auth/login').send(creds)
      expect(blocked.status).toBe(429)
      expect(blocked.body.error).toMatch(/too many login attempts/i)
    })
  })

  describe('POST /api/auth/register (strict)', () => {
    it('blocks with 429 once the per-IP signup limit is exceeded', async () => {
      for (let i = 0; i < 3; i++) {
        const res = await request(app)
          .post('/api/auth/register')
          .send({ email: `rl-reg-${i}@example.com`, password: 'password123', displayName: `U${i}` })
        expect(res.status).toBe(201)
      }

      const blocked = await request(app)
        .post('/api/auth/register')
        .send({ email: 'rl-reg-blocked@example.com', password: 'password123', displayName: 'Blocked' })
      expect(blocked.status).toBe(429)
      expect(blocked.body.error).toMatch(/too many accounts/i)
    })
  })

  describe('POST /api/webhooks/:key (generous)', () => {
    it('blocks with 429 once the per-IP call limit is exceeded', async () => {
      // An unknown key returns 404, but the limiter middleware still counts the
      // hit (it runs before the handler) — so this exercises the limiter alone.
      for (let i = 0; i < 3; i++) {
        const res = await request(app).post('/api/webhooks/no-such-key').send({})
        expect(res.status).toBe(404)
      }

      const blocked = await request(app).post('/api/webhooks/no-such-key').send({})
      expect(blocked.status).toBe(429)
      expect(blocked.body.error).toMatch(/webhook rate limit/i)
    })
  })

  it('does not rate limit when ENABLE_RATE_LIMIT is read as off (skip is live)', async () => {
    // Sanity check that skip() consults env live: flip it off and confirm the
    // limiter lets a burst through, then restore for any later assertions.
    process.env.ENABLE_RATE_LIMIT = 'false'
    try {
      for (let i = 0; i < 6; i++) {
        const res = await request(app).post('/api/webhooks/no-such-key').send({})
        expect(res.status).toBe(404) // never 429 while skipping
      }
    } finally {
      process.env.ENABLE_RATE_LIMIT = 'true'
    }
  })
})
