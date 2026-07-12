// FXL — FlowForge's safe expression language. The public entry point for the
// rest of the server; the lexer/parser/evaluator/functions modules are internal.
//
// FXL powers the expression-based condition operator and the Filter node. It is
// deliberately *not* a general scripting language: no assignment, no loops, no
// user-defined functions, no access to anything outside the scope object handed
// in. That restraint is the feature — it upholds the project's core rule that
// there is no code-evaluation path for user input anywhere in the server, while
// still letting authors write real logic like:
//
//   amount > 1000 && status in ["pending", "review"]
//   upper(trim(user.name)) == "ADMIN"
//   len(items) > 0 ? first(items).id : "none"
//
// Typical use compiles once and evaluates many times (compile → evaluate per
// item in a Filter node), so parsing is cached at the call site by holding the
// compiled program.

const { parse } = require('./parser')
const { evaluate } = require('./evaluate')
const { ExpressionError } = require('./errors')
const { toBool, FUNCTION_NAMES } = require('./functions')

// Parse + evaluate in one call. Throws ExpressionError on a syntax or runtime
// problem. `scope` provides the identifiers the expression may reference.
function evaluateExpression(source, scope = {}, options = {}) {
  return evaluate(parse(source), scope, options)
}

// Evaluate and coerce the result to a boolean with FXL's truthiness rules —
// what a condition/predicate ultimately needs.
function evaluateBoolean(source, scope = {}, options = {}) {
  return toBool(evaluateExpression(source, scope, options))
}

// Parse once into a reusable program. `program.evaluate(scope)` skips re-parsing
// on every call — the Filter node compiles its predicate once, then runs it per
// list item.
function compile(source) {
  const ast = parse(source)
  return {
    ast,
    evaluate: (scope = {}, options = {}) => evaluate(ast, scope, options),
    evaluateBoolean: (scope = {}, options = {}) => toBool(evaluate(ast, scope, options)),
  }
}

// Static check used by the linter and editor: does this source parse? Returns a
// structured result instead of throwing so callers can render the message and
// caret position inline. An empty/blank source is reported as not-ok with a
// friendly message rather than a parser internal.
function check(source) {
  if (source == null || String(source).trim() === '') {
    return { ok: false, error: 'Expression is empty', position: 0 }
  }
  try {
    parse(source)
    return { ok: true }
  } catch (err) {
    if (err instanceof ExpressionError) {
      return { ok: false, error: err.message, position: err.position }
    }
    throw err
  }
}

module.exports = {
  parse,
  compile,
  check,
  evaluateExpression,
  evaluateBoolean,
  ExpressionError,
  FUNCTION_NAMES,
}
