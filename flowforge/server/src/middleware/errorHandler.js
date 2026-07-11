// Final Express error handler — turns body-parser failures and any uncaught
// error into the same { error } shape every route uses. Unexpected errors are
// logged with the request's correlation id and the id is returned in the 500
// body, so a user-reported failure maps to its log lines with one grep.
// (`next` is required for Express to treat this as an error handler even
// though it's unused.)

const logger = require('../services/logger')

function errorHandler(err, req, res, _next) {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' })
  }
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Invalid JSON in request body' })
  }
  const log = req.log || logger
  log.error('unhandled error', {
    method: req.method,
    path: req.path,
    error: err.message,
    stack: err.stack,
  })
  res.status(500).json({
    error: 'Internal server error',
    ...(req.id ? { requestId: req.id } : {}),
  })
}

module.exports = errorHandler
