// Evaluator for FXL. Walks the parser's AST against a scope object and returns a
// value. This is the whole point of the language: user-authored rules run here,
// so the evaluator is where safety is enforced.
//
// Safety properties:
//   • No host reach. Identifiers resolve only against the caller-supplied scope;
//     function calls resolve only against the vetted stdlib registry. There is
//     no `this`, no globals, no way to name a method on a value.
//   • Prototype-safe member access. `__proto__`, `prototype`, and `constructor`
//     are never traversed, so an expression can't walk up to a gadget or mutate
//     a prototype.
//   • Bounded work. A per-evaluation step counter and recursion-depth cap stop
//     a crafted expression from monopolising the event loop or the stack.
//
// Operator semantics are defined here explicitly rather than deferring to JS's
// own coercions, so `==`, `<`, and `+` behave the same predictable way every
// run regardless of the exact JS engine.

const { ExpressionError } = require('./errors')
const { callFunction, toBool } = require('./functions')

const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

const DEFAULT_MAX_STEPS = 10000
const MAX_DEPTH = 200

function describe(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'object') return 'an object'
  return `"${value}"`
}

// Arithmetic coercion. Numbers and numeric strings/booleans convert; everything
// else throws, so `amount * "abc"` fails loudly instead of silently becoming
// NaN and poisoning a comparison downstream.
function toNumber(value) {
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value)
  }
  throw new ExpressionError(`Cannot use ${describe(value)} as a number`)
}

function bothNumbers(a, b) {
  return typeof a === 'number' && typeof b === 'number'
}

// Deterministic loose equality. Numbers compare numerically, objects/arrays by
// structural JSON, null only equals null, and everything else by string form —
// so `5 == "5"` and `true == "true"` are true, matching a rules author's
// intuition, without JS `==`'s stranger corners.
function looseEquals(a, b) {
  if (bothNumbers(a, b)) return a === b
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b
  if (a == null || b == null) return a == null && b == null
  if (typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b)
  }
  return String(a) === String(b)
}

// -1 / 0 / 1 for relational operators. Numeric when both sides are (or coerce
// to) finite numbers; lexicographic string comparison otherwise.
function compare(a, b) {
  const na = Number(a)
  const nb = Number(b)
  const numeric =
    (typeof a === 'number' || (typeof a === 'string' && a.trim() !== '')) &&
    (typeof b === 'number' || (typeof b === 'string' && b.trim() !== '')) &&
    Number.isFinite(na) && Number.isFinite(nb)
  if (numeric) return na < nb ? -1 : na > nb ? 1 : 0
  const sa = String(a)
  const sb = String(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

function membership(needle, haystack) {
  if (Array.isArray(haystack)) return haystack.some((el) => looseEquals(el, needle))
  if (typeof haystack === 'string') return haystack.includes(String(needle))
  if (haystack && typeof haystack === 'object') {
    return Object.prototype.hasOwnProperty.call(haystack, String(needle))
  }
  return false
}

// Read a property/index off a value, refusing to traverse dangerous keys and
// treating primitives (other than string indexing) as having no members.
function readMember(base, key) {
  if (base == null) return undefined
  const prop = typeof key === 'number' ? key : String(key)
  if (typeof prop === 'string' && BLOCKED_KEYS.has(prop)) return undefined
  if (typeof base === 'string') {
    const idx = typeof key === 'number' ? key : Number(key)
    return Number.isInteger(idx) ? base[idx] : undefined
  }
  if (Array.isArray(base)) {
    const idx = typeof key === 'number' ? key : Number(key)
    return Number.isInteger(idx) ? base[idx] : undefined
  }
  if (typeof base === 'object') {
    return Object.prototype.hasOwnProperty.call(base, prop) ? base[prop] : undefined
  }
  return undefined
}

function evaluate(ast, scope = {}, options = {}) {
  const maxSteps = options.maxSteps || DEFAULT_MAX_STEPS
  const state = { steps: 0 }

  function walk(node, depth) {
    if (++state.steps > maxSteps) {
      throw new ExpressionError('Expression evaluation exceeded its step limit')
    }
    if (depth > MAX_DEPTH) {
      throw new ExpressionError('Expression is nested too deeply')
    }

    switch (node.type) {
      case 'Literal':
        return node.value

      case 'Identifier': {
        if (BLOCKED_KEYS.has(node.name)) return undefined
        if (scope != null && typeof scope === 'object' &&
            Object.prototype.hasOwnProperty.call(scope, node.name)) {
          return scope[node.name]
        }
        return undefined
      }

      case 'Array':
        return node.elements.map((el) => walk(el, depth + 1))

      case 'Member': {
        const base = walk(node.object, depth + 1)
        const key = node.computed ? walk(node.property, depth + 1) : node.property
        return readMember(base, key)
      }

      case 'Call': {
        const args = node.args.map((arg) => walk(arg, depth + 1))
        return callFunction(node.callee, args)
      }

      case 'Unary': {
        const value = walk(node.argument, depth + 1)
        switch (node.op) {
          case '!': return !toBool(value)
          case '-': return -toNumber(value)
          case '+': return toNumber(value)
          default: throw new ExpressionError(`Unknown unary operator "${node.op}"`)
        }
      }

      case 'Logical': {
        const left = walk(node.left, depth + 1)
        if (node.op === '&&') return toBool(left) ? walk(node.right, depth + 1) : left
        // '||' — return the left value when truthy so `x || 'fallback'` works.
        return toBool(left) ? left : walk(node.right, depth + 1)
      }

      case 'Conditional':
        return toBool(walk(node.test, depth + 1))
          ? walk(node.consequent, depth + 1)
          : walk(node.alternate, depth + 1)

      case 'Binary': {
        const left = walk(node.left, depth + 1)
        const right = walk(node.right, depth + 1)
        switch (node.op) {
          case '==': return looseEquals(left, right)
          case '!=': return !looseEquals(left, right)
          case '===': return left === right
          case '!==': return left !== right
          case '<': return compare(left, right) < 0
          case '<=': return compare(left, right) <= 0
          case '>': return compare(left, right) > 0
          case '>=': return compare(left, right) >= 0
          case 'in': return membership(left, right)
          case '+':
            if (typeof left === 'string' || typeof right === 'string') {
              return strConcat(left) + strConcat(right)
            }
            return toNumber(left) + toNumber(right)
          case '-': return toNumber(left) - toNumber(right)
          case '*': return toNumber(left) * toNumber(right)
          case '/': return toNumber(left) / toNumber(right)
          case '%': return toNumber(left) % toNumber(right)
          default: throw new ExpressionError(`Unknown operator "${node.op}"`)
        }
      }

      default:
        throw new ExpressionError(`Cannot evaluate node of type "${node.type}"`)
    }
  }

  return walk(ast, 0)
}

// String coercion for the `+` operator: objects/arrays stringify to JSON, null
// to '', so `"total: " + items` reads sensibly.
function strConcat(value) {
  if (value == null) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

module.exports = { evaluate }
