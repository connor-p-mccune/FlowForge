// A single error type for every failure in the expression pipeline — lexing,
// parsing, and evaluation. Carrying an optional source position lets the editor
// (and the linter) point at *where* an expression broke, not just that it did.
class ExpressionError extends Error {
  constructor(message, position = null) {
    super(message)
    this.name = 'ExpressionError'
    // Character offset into the source string, when known. Null for runtime
    // failures that aren't tied to a specific token (e.g. a step-limit trip).
    this.position = position
  }
}

module.exports = { ExpressionError }
