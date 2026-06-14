// Phase 7 / item 2 — IP-based rate limiting (express-rate-limit).
//
// Two profiles:
//   * auth    — strict, to blunt brute-force / credential-stuffing and signup
//               spam. Applied per-endpoint to /api/auth/login and
//               /api/auth/register (each gets its own counter).
//   * webhook — generous, since the public trigger is meant to be called often
//               by external systems, but still capped to limit abuse / floods.
//
// All limits are env-overridable so they can be tuned per deployment (and so the
// test suite can drive them with small values). Counters key off req.ip; in
// production set `trust proxy` (done in index.js) so the real client IP is used.

const rateLimit = require('express-rate-limit')

const FIFTEEN_MIN_MS = 15 * 60 * 1000
const ONE_MIN_MS = 60 * 1000

function positiveInt(value, fallback) {
  const n = parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// Rate limiting runs in dev and production. The Jest suite fires many auth
// requests, so it is skipped under NODE_ENV=test unless a test explicitly opts
// in with ENABLE_RATE_LIMIT=true. DISABLE_RATE_LIMIT=true forces it off anywhere.
// Read live (per request) so a test that opts in can't leak into other suites.
function shouldSkip() {
  if (process.env.DISABLE_RATE_LIMIT === 'true') return true
  if (process.env.NODE_ENV === 'test') return process.env.ENABLE_RATE_LIMIT !== 'true'
  return false
}

function makeLimiter({ windowMs, max, message }) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: true, // emit RateLimit-* headers
    legacyHeaders: false, // drop deprecated X-RateLimit-* headers
    message: { error: message }, // keep the app-wide { error } JSON shape on 429
    skip: shouldSkip,
  })
}

const authWindowMs = positiveInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS, FIFTEEN_MIN_MS)
const authMax = positiveInt(process.env.AUTH_RATE_LIMIT_MAX, 5)

const loginLimiter = makeLimiter({
  windowMs: authWindowMs,
  max: authMax,
  message: 'Too many login attempts. Please try again later.',
})

const registerLimiter = makeLimiter({
  windowMs: authWindowMs,
  max: authMax,
  message: 'Too many accounts created from this IP. Please try again later.',
})

const webhookLimiter = makeLimiter({
  windowMs: positiveInt(process.env.WEBHOOK_RATE_LIMIT_WINDOW_MS, ONE_MIN_MS),
  max: positiveInt(process.env.WEBHOOK_RATE_LIMIT_MAX, 60),
  message: 'Webhook rate limit exceeded. Slow down.',
})

module.exports = { loginLimiter, registerLimiter, webhookLimiter, shouldSkip }
