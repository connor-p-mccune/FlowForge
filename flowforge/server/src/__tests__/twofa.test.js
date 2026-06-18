const request = require('supertest')
const speakeasy = require('speakeasy')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const { app } = require('../index')

// Produce a valid 6-digit TOTP for a base32 secret, the way an authenticator app
// would, so the tests can drive the real verification path.
function totp(secret) {
  return speakeasy.totp({ secret, encoding: 'base32' })
}

async function register(email) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'password123', displayName: 'Trinity' })
  return res.body.token
}

describe('TOTP two-factor — full enable → login → disable cycle', () => {
  let token // session token (pre-2FA, then post-disable)
  let secret // base32 TOTP secret from setup
  let backupCodes // plaintext one-time codes from setup

  beforeAll(async () => {
    token = await register('neo@example.com')
  })

  it('setup returns a QR code, a base32 secret, and 8 backup codes', async () => {
    const res = await request(app)
      .post('/api/auth/2fa/setup')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.qrCode).toMatch(/^data:image\/png;base64,/)
    expect(typeof res.body.secret).toBe('string')
    expect(res.body.backupCodes).toHaveLength(8)
    expect(res.body.backupCodes.every((c) => /^[A-Z0-9]{10}$/.test(c))).toBe(true)
    secret = res.body.secret
    backupCodes = res.body.backupCodes
  })

  it('does not require 2FA at login until setup is verified', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'neo@example.com', password: 'password123' })
    expect(res.status).toBe(200)
    expect(res.body.requires2FA).toBeUndefined()
    expect(res.body.token).toBeDefined()
  })

  it('rejects verify-setup with a wrong code', async () => {
    const res = await request(app)
      .post('/api/auth/2fa/verify-setup')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: '000000' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/invalid/i)
  })

  it('enables 2FA when a valid code confirms setup', async () => {
    const res = await request(app)
      .post('/api/auth/2fa/verify-setup')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: totp(secret) })
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
  })

  it('login now returns a challenge token instead of a session token', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'neo@example.com', password: 'password123' })
    expect(res.status).toBe(200)
    expect(res.body.requires2FA).toBe(true)
    expect(res.body.tempToken).toBeDefined()
    expect(res.body.token).toBeUndefined()
  })

  it('the challenge token cannot be used as a real access token', async () => {
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'neo@example.com', password: 'password123' })
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${login.body.tempToken}`)
    expect(res.status).toBe(401)
  })

  it('completes login with the challenge token + a valid TOTP code', async () => {
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'neo@example.com', password: 'password123' })

    const res = await request(app)
      .post('/api/auth/2fa/login')
      .send({ tempToken: login.body.tempToken, code: totp(secret) })
    expect(res.status).toBe(200)
    expect(res.body.token).toBeDefined()
    expect(res.body.user.twoFactorEnabled).toBe(true)

    // The returned session token grants access to protected routes.
    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${res.body.token}`)
    expect(me.status).toBe(200)
    expect(me.body.user.email).toBe('neo@example.com')
  })

  it('rejects a wrong code at 2fa/login', async () => {
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'neo@example.com', password: 'password123' })
    const res = await request(app)
      .post('/api/auth/2fa/login')
      .send({ tempToken: login.body.tempToken, code: '000000' })
    expect(res.status).toBe(401)
  })

  it('accepts a backup code and then consumes it (no replay)', async () => {
    const first = await request(app)
      .post('/api/auth/login')
      .send({ email: 'neo@example.com', password: 'password123' })
    const ok = await request(app)
      .post('/api/auth/2fa/login')
      .send({ tempToken: first.body.tempToken, code: backupCodes[0] })
    expect(ok.status).toBe(200)
    expect(ok.body.token).toBeDefined()

    // Same backup code, fresh challenge — must now be rejected as already used.
    const second = await request(app)
      .post('/api/auth/login')
      .send({ email: 'neo@example.com', password: 'password123' })
    const replay = await request(app)
      .post('/api/auth/2fa/login')
      .send({ tempToken: second.body.tempToken, code: backupCodes[0] })
    expect(replay.status).toBe(401)
  })

  it('refuses to re-run setup while 2FA is already enabled', async () => {
    const res = await request(app)
      .post('/api/auth/2fa/setup')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/already enabled/i)
  })

  it('rejects disable without the right password', async () => {
    const res = await request(app)
      .post('/api/auth/2fa/disable')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'wrong-password', code: totp(secret) })
    expect(res.status).toBe(401)
  })

  it('disables 2FA with password + a valid code, and login stops requiring 2FA', async () => {
    const disable = await request(app)
      .post('/api/auth/2fa/disable')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'password123', code: totp(secret) })
    expect(disable.status).toBe(200)
    expect(disable.body.success).toBe(true)

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'neo@example.com', password: 'password123' })
    expect(login.status).toBe(200)
    expect(login.body.requires2FA).toBeUndefined()
    expect(login.body.token).toBeDefined()
  })
})

describe('TOTP 2FA — guards on protected setup routes', () => {
  it('setup requires authentication', async () => {
    const res = await request(app).post('/api/auth/2fa/setup')
    expect(res.status).toBe(401)
  })

  it('verify-setup fails before setup has run', async () => {
    const token = await register('morpheus@example.com')
    const res = await request(app)
      .post('/api/auth/2fa/verify-setup')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: '123456' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/setup first/i)
  })

  it('disable fails when 2FA is not enabled', async () => {
    const token = await register('tank@example.com')
    const res = await request(app)
      .post('/api/auth/2fa/disable')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'password123', code: '123456' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/not enabled/i)
  })
})
