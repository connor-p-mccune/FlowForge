// A sandboxed playground for FXL, the safe expression language. Authors writing
// a condition / filter / map / aggregate rule can evaluate it against sample
// data before wiring it into a graph. It's the *same* parser, evaluator, and
// safety bounds the engine uses — no secrets, no side effects — so what runs
// here is exactly what a node would run.
//
// A failing expression is a successful test: a syntax or runtime error comes
// back as 200 with { ok: false, error, position }, so the editor renders it
// inline rather than treating it as a request failure — mirroring the node test
// bench. Only a malformed *request* (missing expression, non-object scope, an
// over-large input) is a 4xx.

const express = require('express')
const auth = require('../middleware/auth')
const { evaluateExpression, ExpressionError } = require('../services/expression')

const router = express.Router()

const MAX_SOURCE_CHARS = 2000
const MAX_SCOPE_CHARS = 20000

// POST /api/expressions/evaluate — { expression, scope? } → the evaluated value.
router.post('/expressions/evaluate', auth, (req, res) => {
  const { expression, scope } = req.body || {}

  if (typeof expression !== 'string' || expression.trim() === '') {
    return res.status(400).json({ error: 'expression is required' })
  }
  if (expression.length > MAX_SOURCE_CHARS) {
    return res.status(400).json({ error: `expression is too long (max ${MAX_SOURCE_CHARS} characters)` })
  }

  let scopeObj = {}
  if (scope !== undefined && scope !== null) {
    if (typeof scope !== 'object' || Array.isArray(scope)) {
      return res.status(400).json({ error: 'scope must be a JSON object' })
    }
    if (JSON.stringify(scope).length > MAX_SCOPE_CHARS) {
      return res.status(400).json({ error: 'scope is too large' })
    }
    scopeObj = scope
  }

  try {
    // FXL can evaluate to undefined (a missing field/identifier); normalise it
    // to null so it survives JSON and reads as "no value" in the playground.
    const raw = evaluateExpression(expression, scopeObj)
    const result = raw === undefined ? null : raw
    return res.json({
      ok: true,
      result,
      resultType: result === null ? 'null' : Array.isArray(result) ? 'array' : typeof result,
    })
  } catch (err) {
    if (err instanceof ExpressionError) {
      return res.json({ ok: false, error: err.message, position: err.position ?? null })
    }
    // Non-FXL error (shouldn't happen — the evaluator only throws ExpressionError).
    return res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
