const express = require('express')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const auth = require('../middleware/auth')
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

function userPayload(user) {
  return { id: user.id, email: user.email, displayName: user.display_name }
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

module.exports = router
