const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const { app } = require('../index')

describe('security headers (helmet)', () => {
  it('sets API-appropriate hardening headers and hides the framework', async () => {
    const res = await request(app).get('/api/health')
    expect(res.status).toBe(200)
    // helmet defaults we expect on every response
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN')
    // Express's fingerprint is removed
    expect(res.headers['x-powered-by']).toBeUndefined()
  })

  it('does not send a Content-Security-Policy (disabled for this JSON API)', async () => {
    const res = await request(app).get('/api/health')
    expect(res.headers['content-security-policy']).toBeUndefined()
  })
})
