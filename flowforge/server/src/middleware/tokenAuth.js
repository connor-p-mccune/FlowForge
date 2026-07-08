// Bearer authentication for the public API (/api/v1) using personal access
// tokens (see services/apiTokens.js). Session JWTs are rejected here and API
// tokens are rejected by the session `auth` middleware, so the two credential
// kinds can't cross over: a leaked API token never grants access to account
// endpoints like password or 2FA settings.
//
// Usage: router.post('/path', tokenAuth('trigger'), handler). The middleware
// resolves the token to its owning user and sets req.user to the same shape
// the session middleware produces ({ id, email, displayName }), so downstream
// membership checks work unchanged. req.apiToken carries the token row.

const db = require('../config/database')
const { hashToken, isTokenShaped } = require('../services/apiTokens')

function tokenAuth(requiredScope) {
  return (req, res, next) => {
    const header = req.headers.authorization
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'API token required (Authorization: Bearer ffp_…)' })
    }
    const token = header.slice('Bearer '.length).trim()
    if (!isTokenShaped(token)) {
      return res.status(401).json({ error: 'Invalid API token' })
    }

    try {
      const row = db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?').get(hashToken(token))
      if (!row) return res.status(401).json({ error: 'Invalid API token' })
      if (row.revoked_at) return res.status(401).json({ error: 'API token has been revoked' })
      if (row.expires_at && row.expires_at <= new Date().toISOString()) {
        return res.status(401).json({ error: 'API token has expired' })
      }

      let scopes = []
      try {
        scopes = JSON.parse(row.scopes) || []
      } catch {
        /* malformed scopes column — treat as no scopes */
      }
      if (requiredScope && !scopes.includes(requiredScope)) {
        return res.status(403).json({ error: `This token is missing the "${requiredScope}" scope` })
      }

      const user = db.prepare('SELECT id, email, display_name FROM users WHERE id = ?').get(row.user_id)
      if (!user) return res.status(401).json({ error: 'Invalid API token' })

      req.user = { id: user.id, email: user.email, displayName: user.display_name }
      req.apiToken = { id: row.id, name: row.name, scopes }

      db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?')
        .run(new Date().toISOString(), row.id)

      next()
    } catch (err) {
      console.error(err)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
}

module.exports = tokenAuth
