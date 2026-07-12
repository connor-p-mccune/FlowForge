// Parser for FXL. A hand-written Pratt (precedence-climbing) parser turns the
// lexer's token stream into an abstract syntax tree. Pratt parsing keeps
// operator precedence in one small table instead of a cascade of grammar
// rules, which is why the whole expression layer stays under a few hundred
// lines with no parser-generator dependency.
//
// AST node shapes (all plain objects, JSON-serialisable so a compiled program
// can be cached or inspected):
//   { type: 'Literal', value }
//   { type: 'Identifier', name }
//   { type: 'Array', elements: [...] }
//   { type: 'Object', properties: [{ key, value }] }   // { a: 1, "b": x }
//   { type: 'Member', object, property, computed }   // a.b  |  a[expr]
//   { type: 'Call', callee: name, args: [...] }        // fn(...)
//   { type: 'Unary', op, argument }
//   { type: 'Binary', op, left, right }
//   { type: 'Logical', op, left, right }               // && ||
//   { type: 'Conditional', test, consequent, alternate }

const { tokenize } = require('./lexer')
const { ExpressionError } = require('./errors')

// Binding power of each infix operator (higher binds tighter). Ternary sits at
// the bottom and is handled specially; `:` is never an infix operator on its
// own. Anything absent here ends an infix chain.
const INFIX_PRECEDENCE = {
  '?': 1,
  '||': 2,
  '&&': 3,
  '==': 4, '!=': 4, '===': 4, '!==': 4, in: 4,
  '<': 5, '<=': 5, '>': 5, '>=': 5,
  '+': 6, '-': 6,
  '*': 7, '/': 7, '%': 7,
}

const LOGICAL_OPS = new Set(['&&', '||'])
const PREFIX_OPS = new Set(['!', '-', '+'])

// Guard against a pathological expression exploding memory/time before it ever
// runs. A rule that legitimately needs 500 AST nodes is already unreadable.
const MAX_NODES = 500

function parse(source) {
  const tokens = tokenize(source)
  let pos = 0
  let nodeCount = 0

  const peek = () => tokens[pos]
  const next = () => tokens[pos++]
  const node = (obj) => {
    if (++nodeCount > MAX_NODES) {
      throw new ExpressionError('Expression is too large')
    }
    return obj
  }

  function expectPunct(value) {
    const t = peek()
    if (t.type !== 'punct' || t.value !== value) {
      throw new ExpressionError(`Expected "${value}"`, t.position)
    }
    return next()
  }

  // parseExpression(minPrecedence): precedence climbing. Parse a prefix/primary,
  // then fold in any infix operator whose precedence clears the caller's floor.
  function parseExpression(minPrecedence) {
    let left = parseUnary()

    for (;;) {
      const t = peek()
      if (t.type !== 'op') break
      const prec = INFIX_PRECEDENCE[t.value]
      if (prec === undefined || prec < minPrecedence) break

      if (t.value === '?') {
        next() // '?'
        const consequent = parseExpression(0)
        const colon = peek()
        if (colon.type !== 'op' || colon.value !== ':') {
          throw new ExpressionError('Expected ":" in conditional expression', colon.position)
        }
        next() // ':'
        // Right-associative: recurse at the ternary's own precedence so
        // `a ? b : c ? d : e` parses as `a ? b : (c ? d : e)`.
        const alternate = parseExpression(prec)
        left = node({ type: 'Conditional', test: left, consequent, alternate })
        continue
      }

      const op = next().value
      // Left-associative binary operators: the right operand may only absorb
      // operators that bind strictly tighter.
      const right = parseExpression(prec + 1)
      left = LOGICAL_OPS.has(op)
        ? node({ type: 'Logical', op, left, right })
        : node({ type: 'Binary', op, left, right })
    }

    return left
  }

  function parseUnary() {
    const t = peek()
    if (t.type === 'op' && PREFIX_OPS.has(t.value)) {
      next()
      return node({ type: 'Unary', op: t.value, argument: parseUnary() })
    }
    return parsePostfix()
  }

  // Member access and calls bind tighter than any operator and chain left to
  // right: `a.b[c].d`, `fn(x).y`.
  function parsePostfix() {
    let target = parsePrimary()
    for (;;) {
      const t = peek()
      if (t.type === 'punct' && t.value === '.') {
        next()
        const name = peek()
        if (name.type !== 'ident') {
          throw new ExpressionError('Expected a property name after "."', name.position)
        }
        next()
        target = node({ type: 'Member', object: target, property: name.value, computed: false })
      } else if (t.type === 'punct' && t.value === '[') {
        next()
        const index = parseExpression(0)
        expectPunct(']')
        target = node({ type: 'Member', object: target, property: index, computed: true })
      } else if (t.type === 'punct' && t.value === '(') {
        // Only bare names resolve to functions — there are no methods on values,
        // so `obj.fn()` or `(expr)()` is rejected. This is what keeps evaluation
        // from ever reaching a host method.
        if (target.type !== 'Identifier') {
          throw new ExpressionError('Only named functions can be called', t.position)
        }
        next()
        const args = parseArguments()
        target = node({ type: 'Call', callee: target.name, args })
      } else {
        break
      }
    }
    return target
  }

  function parseArguments() {
    const args = []
    if (peek().type === 'punct' && peek().value === ')') {
      next()
      return args
    }
    for (;;) {
      args.push(parseExpression(0))
      const t = peek()
      if (t.type === 'punct' && t.value === ',') {
        next()
        continue
      }
      expectPunct(')')
      break
    }
    return args
  }

  function parsePrimary() {
    const t = peek()
    switch (t.type) {
      case 'number':
      case 'string':
      case 'boolean':
      case 'null':
        next()
        return node({ type: 'Literal', value: t.value })
      case 'ident':
        next()
        return node({ type: 'Identifier', name: t.value })
      case 'punct':
        if (t.value === '(') {
          next()
          const inner = parseExpression(0)
          expectPunct(')')
          return inner
        }
        if (t.value === '[') {
          next()
          const elements = []
          if (!(peek().type === 'punct' && peek().value === ']')) {
            for (;;) {
              elements.push(parseExpression(0))
              const sep = peek()
              if (sep.type === 'punct' && sep.value === ',') {
                next()
                continue
              }
              break
            }
          }
          expectPunct(']')
          return node({ type: 'Array', elements })
        }
        if (t.value === '{') {
          next()
          const properties = []
          if (!(peek().type === 'punct' && peek().value === '}')) {
            for (;;) {
              const keyToken = peek()
              // Keys are an identifier (name: …) or a string literal ("full name": …).
              let key
              if (keyToken.type === 'ident' || keyToken.type === 'string') {
                key = keyToken.value
                next()
              } else {
                throw new ExpressionError('Expected a property name in object literal', keyToken.position)
              }
              const colon = peek()
              if (colon.type !== 'op' || colon.value !== ':') {
                throw new ExpressionError('Expected ":" after a property name', colon.position)
              }
              next() // ':'
              properties.push(node({ key, value: parseExpression(0) }))
              const sep = peek()
              if (sep.type === 'punct' && sep.value === ',') {
                next()
                continue
              }
              break
            }
          }
          expectPunct('}')
          return node({ type: 'Object', properties })
        }
        break
      default:
        break
    }
    if (t.type === 'eof') {
      throw new ExpressionError('Unexpected end of expression', t.position)
    }
    throw new ExpressionError(`Unexpected token "${t.value}"`, t.position)
  }

  const ast = parseExpression(0)
  const trailing = peek()
  if (trailing.type !== 'eof') {
    throw new ExpressionError(`Unexpected token "${trailing.value}"`, trailing.position)
  }
  return ast
}

module.exports = { parse }
