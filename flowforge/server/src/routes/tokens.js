// Personal access token management (session-authenticated — you manage your
// tokens from the app, then use them against /api/v1). The full token value
// appears exactly once, in the POST response; every other response carries
// only the display prefix and metadata.

const express = require('express')
const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const auth = require('../middleware/auth')
const { validate } = require('../middleware/validate')
const { generateToken, SCOPES } = require('../services/apiTokens')

const router = express.Router()

// Enough for real automation use; low enough that a runaway script minting
// tokens in a loop gets stopped.
const MAX_ACTIVE_TOKENS = 25
const MAX_EXPIRY_DAYS = 365

// Shape a row for API responses: parsed scopes, no hash.
function presentToken(row) {
  let scopes = []
  try {
    scopes = JSON.parse(row.scopes) || []
  } catch {
    /* malformed scopes column — present as none */
  }
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    scopes,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  }
}

// GET /api/tokens — the caller's tokens, newest first (revoked ones included,
// flagged, so the list doubles as an audit trail).
router.get('/tokens', auth, (req, res) => {
  try {
    const rows = db.prepare(
      'SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC, rowid DESC'
    ).all(req.user.id)
    res.json({ tokens: rows.map(presentToken) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/tokens — mint a token. Body: { name, scopes?, expiresInDays? }.
// scopes defaults to the full set; expiresInDays to non-expiring.
router.post(
  '/tokens',
  auth,
  validate({
    name: { required: true, type: 'string', maxLength: 100 },
    scopes: { type: 'array', maxItems: SCOPES.length },
    expiresInDays: { type: 'number' },
  }),
  (req, res) => {
    try {
      const { name, scopes: requestedScopes, expiresInDays } = req.body

      let scopes = SCOPES
      if (requestedScopes !== undefined) {
        if (
          requestedScopes.length === 0 ||
          !requestedScopes.every((s) => typeof s === 'string' && SCOPES.includes(s))
        ) {
          return res.status(400).json({ error: `scopes must be a non-empty subset of: ${SCOPES.join(', ')}` })
        }
        scopes = [...new Set(requestedScopes)]
      }

      let expiresAt = null
      if (expiresInDays !== undefined) {
        if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > MAX_EXPIRY_DAYS) {
          return res.status(400).json({ error: `expiresInDays must be an integer between 1 and ${MAX_EXPIRY_DAYS}` })
        }
        expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
      }

      const { active } = db.prepare(
        `SELECT COUNT(*) AS active FROM api_tokens
          WHERE user_id = ? AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > ?)`
      ).get(req.user.id, new Date().toISOString())
      if (active >= MAX_ACTIVE_TOKENS) {
        return res.status(400).json({ error: `You can have at most ${MAX_ACTIVE_TOKENS} active tokens — revoke one first` })
      }

      const { token, prefix, hash } = generateToken()
      const id = uuidv4()
      const now = new Date().toISOString()
      db.prepare(
        `INSERT INTO api_tokens (id, user_id, name, token_prefix, token_hash, scopes, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, req.user.id, name, prefix, hash, JSON.stringify(scopes), expiresAt, now)

      const row = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(id)
      // `token` is the only copy the caller will ever see.
      res.status(201).json({ token, apiToken: presentToken(row) })
    } catch (err) {
      console.error(err)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
)

// DELETE /api/tokens/:id — revoke. The row is kept (revoked_at set) so the
// list still shows when the token existed and was last used.
router.delete('/tokens/:id', auth, (req, res) => {
  try {
    const row = db.prepare(
      'SELECT * FROM api_tokens WHERE id = ? AND user_id = ?'
    ).get(req.params.id, req.user.id)
    if (!row) return res.status(404).json({ error: 'Token not found' })
    if (!row.revoked_at) {
      db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ?')
        .run(new Date().toISOString(), row.id)
    }
    res.status(204).end()
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
