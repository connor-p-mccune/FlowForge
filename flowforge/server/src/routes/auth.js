const express = require('express')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const auth = require('../middleware/auth')
const twoFactor = require('../services/twoFactor')
const { validate, EMAIL_PATTERN } = require('../middleware/validate')
const { loginLimiter, registerLimiter } = require('../middleware/rateLimit')

const router = express.Router()

// Access tokens expire after 7 days. They are stateless and not individually
// revocable; a refresh-token flow (short access token + hashed refresh token +
// /api/auth/refresh) is documented as deferred future work in SECURITY.md.
function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, displayName: user.display_name },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  )
}

// Secret for the short-lived "2FA pending" token issued between password and code
// entry. Derived from JWT_SECRET (read live so test setup ordering doesn't matter)
// with a distinct suffix, so a challenge token is cryptographically unusable as a
// real access token: the auth middleware verifies with JWT_SECRET and rejects it.
function challengeSecret() {
  return `${process.env.JWT_SECRET}::2fa-challenge`
}

// Signed after a correct password when the account has 2FA enabled. The holder
// must still present a valid code at /api/auth/2fa/login to get a real token.
function signChallengeToken(user) {
  return jwt.sign({ id: user.id, purpose: '2fa' }, challengeSecret(), { expiresIn: '5m' })
}

function userPayload(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    twoFactorEnabled: !!user.totp_enabled,
  }
}

router.post(
  '/auth/register',
  registerLimiter,
  validate({
    email: { required: true, type: 'string', maxLength: 320, pattern: EMAIL_PATTERN, patternMessage: 'email is invalid' },
    password: { required: true, type: 'string', minLength: 8, maxLength: 200 },
    displayName: { required: true, type: 'string', maxLength: 100 },
  }),
  async (req, res) => {
  try {
    const { email, password, displayName } = req.body

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email)
    if (existing) {
      return res.status(409).json({ error: 'Email already in use' })
    }

    const passwordHash = await bcrypt.hash(password, 10)
    const userId = uuidv4()
    const now = new Date().toISOString()

    db.prepare(
      'INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(userId, email, passwordHash, displayName, now)

    const workspaceId = uuidv4()
    db.prepare(
      'INSERT INTO workspaces (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(workspaceId, `${displayName}'s Workspace`, userId, now, now)

    db.prepare(
      'INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
    ).run(workspaceId, userId, 'owner', now)

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId)
    const token = signToken(user)

    res.status(201).json({ token, user: userPayload(user) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post(
  '/auth/login',
  loginLimiter,
  validate({
    email: { required: true, type: 'string', maxLength: 320 },
    password: { required: true, type: 'string', maxLength: 200 },
  }),
  async (req, res) => {
  try {
    const { email, password } = req.body

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email)
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' })
    }

    const match = await bcrypt.compare(password, user.password_hash)
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' })
    }

    // With 2FA enabled, the password is only the first factor: hand back a
    // short-lived challenge token instead of a session token. The client then
    // posts it with a code to /api/auth/2fa/login to finish signing in.
    if (user.totp_enabled) {
      return res.json({ requires2FA: true, tempToken: signChallengeToken(user) })
    }

    const token = signToken(user)
    res.json({ token, user: userPayload(user) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Second leg of a 2FA login: exchange a challenge token + a TOTP or backup code
// for a real session token. A used backup code is marked consumed so it can't be
// replayed.
router.post(
  '/auth/2fa/login',
  loginLimiter,
  validate({
    tempToken: { required: true, type: 'string', maxLength: 4096 },
    code: { required: true, type: 'string', maxLength: 100 },
  }),
  async (req, res) => {
  try {
    const { tempToken, code } = req.body

    let payload
    try {
      payload = jwt.verify(tempToken, challengeSecret())
    } catch {
      return res.status(401).json({ error: 'Your 2FA session expired. Please sign in again.' })
    }
    if (payload.purpose !== '2fa') {
      return res.status(401).json({ error: 'Invalid 2FA session' })
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id)
    if (!user || !user.totp_enabled) {
      return res.status(401).json({ error: 'Invalid 2FA session' })
    }

    let verified = false
    if (twoFactor.looksLikeTotp(code)) {
      verified = twoFactor.verifyToken(user.totp_secret, code)
    } else {
      const stored = JSON.parse(user.totp_backup_codes || '[]')
      const idx = await twoFactor.findUnusedBackupCode(stored, code)
      if (idx !== -1) {
        stored[idx].used = true
        db.prepare('UPDATE users SET totp_backup_codes = ? WHERE id = ?').run(
          JSON.stringify(stored),
          user.id
        )
        verified = true
      }
    }

    if (!verified) {
      return res.status(401).json({ error: 'Invalid authentication code' })
    }

    const token = signToken(user)
    res.json({ token, user: userPayload(user) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/auth/me', auth, (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)
    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }
    res.json({ user: userPayload(user) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Begin 2FA enrolment: generate a secret + backup codes and stash them on the
// user, but leave totp_enabled = 0 until /verify-setup confirms the authenticator
// works. The plaintext secret and backup codes are returned exactly once here —
// only their hashes/secret are stored, so they can't be retrieved again.
router.post('/auth/2fa/setup', auth, async (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)
    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }
    if (user.totp_enabled) {
      return res.status(400).json({ error: 'Two-factor authentication is already enabled' })
    }

    const { secret, otpauthUrl } = twoFactor.generateSecret(user.email)
    const backupCodes = twoFactor.generateBackupCodes()
    const hashedCodes = await twoFactor.hashBackupCodes(backupCodes)
    const qrCode = await twoFactor.toQRCode(otpauthUrl)

    db.prepare('UPDATE users SET totp_secret = ?, totp_backup_codes = ? WHERE id = ?').run(
      secret,
      JSON.stringify(hashedCodes),
      user.id
    )

    res.json({ qrCode, secret, backupCodes })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Confirm enrolment: the user enters a code from their authenticator and, if it
// matches the pending secret, 2FA is switched on. This proves the app is set up
// correctly before we start requiring a code at login.
router.post(
  '/auth/2fa/verify-setup',
  auth,
  validate({ code: { required: true, type: 'string', maxLength: 20 } }),
  (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)
    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }
    if (user.totp_enabled) {
      return res.status(400).json({ error: 'Two-factor authentication is already enabled' })
    }
    if (!user.totp_secret) {
      return res.status(400).json({ error: 'Start two-factor setup first' })
    }
    if (!twoFactor.verifyToken(user.totp_secret, req.body.code)) {
      return res.status(400).json({ error: 'Invalid authentication code' })
    }

    db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(user.id)
    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Turn 2FA off. Requires the password and a current code (TOTP or an unused
// backup code, so a lost authenticator can still be recovered) so a stolen
// session token alone can't strip the account's second factor. Clears the secret
// and backup codes — re-enabling later issues a fresh set.
router.post(
  '/auth/2fa/disable',
  auth,
  validate({
    password: { required: true, type: 'string', maxLength: 200 },
    code: { required: true, type: 'string', maxLength: 100 },
  }),
  async (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)
    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }
    if (!user.totp_enabled) {
      return res.status(400).json({ error: 'Two-factor authentication is not enabled' })
    }

    const match = await bcrypt.compare(req.body.password, user.password_hash)
    if (!match) {
      return res.status(401).json({ error: 'Invalid password' })
    }

    let verified = false
    if (twoFactor.looksLikeTotp(req.body.code)) {
      verified = twoFactor.verifyToken(user.totp_secret, req.body.code)
    } else {
      const stored = JSON.parse(user.totp_backup_codes || '[]')
      verified = (await twoFactor.findUnusedBackupCode(stored, req.body.code)) !== -1
    }
    if (!verified) {
      return res.status(401).json({ error: 'Invalid authentication code' })
    }

    db.prepare(
      'UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_backup_codes = NULL WHERE id = ?'
    ).run(user.id)
    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
