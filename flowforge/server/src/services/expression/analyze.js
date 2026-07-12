// Static analysis of an FXL source string, for the workflow linter and editor.
// Beyond "does it parse?", it walks the AST for calls to functions that aren't
// in the stdlib — a class of mistake (a typo'd `uppr(x)`, a `filter(...)` that
// doesn't exist) that is certain to fail at runtime but is invisible to a plain
// parse. Catching it at lint time mirrors how the rest of the linter reports
// problems the run *will* hit, before the run hits them.

const { parse } = require('./parser')
const { ExpressionError } = require('./errors')
const { FUNCTION_NAMES } = require('./functions')

const KNOWN_FUNCTIONS = new Set(FUNCTION_NAMES)

// Collect the names of any called functions the stdlib doesn't define.
function collectUnknownCalls(node, unknown) {
  if (!node || typeof node !== 'object') return
  if (node.type === 'Call' && !KNOWN_FUNCTIONS.has(node.callee)) {
    unknown.add(node.callee)
  }
  for (const key of Object.keys(node)) {
    const child = node[key]
    if (Array.isArray(child)) child.forEach((c) => collectUnknownCalls(c, unknown))
    else if (child && typeof child === 'object') collectUnknownCalls(child, unknown)
  }
}

// { ok, empty?, error?, position?, unknownFunctions? }. `empty` distinguishes a
// blank source (usually a "required field" problem) from a genuine syntax error.
function analyze(source) {
  if (source == null || String(source).trim() === '') {
    return { ok: false, empty: true, error: 'Expression is empty' }
  }
  let ast
  try {
    ast = parse(String(source))
  } catch (err) {
    if (err instanceof ExpressionError) {
      return { ok: false, error: err.message, position: err.position }
    }
    throw err
  }
  const unknown = new Set()
  collectUnknownCalls(ast, unknown)
  return { ok: true, unknownFunctions: [...unknown] }
}

module.exports = { analyze }
