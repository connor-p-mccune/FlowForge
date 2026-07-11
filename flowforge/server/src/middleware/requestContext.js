// Request correlation + structured request logging.
//
// Every request gets an id: a valid inbound X-Request-Id is honored (so a
// gateway's id follows the request through FlowForge's logs), anything else
// gets a fresh UUID. The id is echoed on the response, bound onto req.log (a
// child logger routes can use for request-scoped lines), and included in the
// 500 body by the error handler — "what happened to request X?" becomes one
// grep.
//
// One line is logged per response with the real path (not the route pattern —
// logs are for debugging specific requests, unlike metrics where raw paths
// would explode label cardinality). Health and metrics scrapes log at debug
// so a probe every few seconds doesn't drown the interesting lines.

const { randomUUID } = require('crypto')
const logger = require('../services/logger')

// Header-safe, bounded: letters/digits/underscore/dot/dash, ≤ 64 chars.
const VALID_ID = /^[\w.-]{1,64}$/

function requestContext(req, res, next) {
  const inbound = req.get('x-request-id')
  req.id = inbound && VALID_ID.test(inbound) ? inbound : randomUUID()
  res.set('X-Request-Id', req.id)
  req.log = logger.child({ requestId: req.id })

  const startedAt = process.hrtime.bigint()
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
    const probe = req.path === '/metrics' || req.path.startsWith('/api/health')
    req.log[probe ? 'debug' : 'info']('request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
    })
  })
  next()
}

module.exports = requestContext
