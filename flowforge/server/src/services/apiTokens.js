// Personal access tokens for the public API (/api/v1).
//
// A token is `ffp_` + 40 hex chars (20 random bytes). Storage follows the
// GitHub/Stripe model: only the SHA-256 hash is persisted, so a database leak
// exposes nothing usable; the full value is returned exactly once, at mint
// time. The unhashed prefix (ffp_ + first 8 hex) is kept alongside so the UI
// can identify tokens without being able to reconstruct them.

const crypto = require('crypto')

const TOKEN_PREFIX = 'ffp_'
const PREFIX_DISPLAY_CHARS = 8

// The full scope set. `trigger` starts workflow runs; `read` reads workflows
// and execution results; `approve` settles pending approval gates.
const SCOPES = ['trigger', 'read', 'approve']

function generateToken() {
  const token = TOKEN_PREFIX + crypto.randomBytes(20).toString('hex')
  return {
    token,
    prefix: token.slice(0, TOKEN_PREFIX.length + PREFIX_DISPLAY_CHARS),
    hash: hashToken(token),
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function isTokenShaped(value) {
  return typeof value === 'string' && value.startsWith(TOKEN_PREFIX)
}

module.exports = { generateToken, hashToken, isTokenShaped, SCOPES, TOKEN_PREFIX }
