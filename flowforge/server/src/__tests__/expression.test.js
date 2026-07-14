// Tests for FXL, the safe expression language. Exercises the whole pipeline —
// lexing, parsing precedence, evaluation semantics, the stdlib, the safety
// guards, and the resource bounds — through the public API in ../services/
// expression.

const {
  parse,
  compile,
  check,
  evaluateExpression: evalExpr,
  evaluateBoolean,
  ExpressionError,
  FUNCTION_NAMES,
} = require('../services/expression')

describe('FXL literals and identifiers', () => {
  it('evaluates numeric, string, boolean, and null literals', () => {
    expect(evalExpr('42')).toBe(42)
    expect(evalExpr('3.14')).toBeCloseTo(3.14)
    expect(evalExpr('1e3')).toBe(1000)
    expect(evalExpr('"hello"')).toBe('hello')
    expect(evalExpr("'world'")).toBe('world')
    expect(evalExpr('true')).toBe(true)
    expect(evalExpr('false')).toBe(false)
    expect(evalExpr('null')).toBeNull()
  })

  it('resolves identifiers from the scope', () => {
    expect(evalExpr('amount', { amount: 500 })).toBe(500)
    expect(evalExpr('user', { user: { name: 'Ada' } })).toEqual({ name: 'Ada' })
  })

  it('returns undefined for a missing identifier rather than throwing', () => {
    expect(evalExpr('nope', { amount: 1 })).toBeUndefined()
  })

  it('decodes string escape sequences', () => {
    expect(evalExpr('"a\\nb"')).toBe('a\nb')
    expect(evalExpr('"tab\\there"')).toBe('tab\there')
    expect(evalExpr('"quote\\""')).toBe('quote"')
  })
})

describe('FXL arithmetic', () => {
  it('applies the four operators with correct precedence', () => {
    expect(evalExpr('2 + 3 * 4')).toBe(14)
    expect(evalExpr('(2 + 3) * 4')).toBe(20)
    expect(evalExpr('10 - 2 - 3')).toBe(5) // left-associative
    expect(evalExpr('17 % 5')).toBe(2)
    expect(evalExpr('2 * 3 + 4 * 5')).toBe(26)
  })

  it('handles unary minus and plus', () => {
    expect(evalExpr('-5')).toBe(-5)
    expect(evalExpr('-(2 + 3)')).toBe(-5)
    expect(evalExpr('3 - -2')).toBe(5)
    expect(evalExpr('+"7"')).toBe(7)
  })

  it('coerces numeric strings and booleans in arithmetic', () => {
    expect(evalExpr('"10" * 2')).toBe(20)
    expect(evalExpr('true + 1')).toBe(2)
  })

  it('throws a friendly error on non-numeric arithmetic', () => {
    expect(() => evalExpr('"abc" * 2')).toThrow(ExpressionError)
    expect(() => evalExpr('"abc" * 2')).toThrow(/as a number/)
  })

  it('treats + as concatenation when either side is a string', () => {
    expect(evalExpr('"a" + "b"')).toBe('ab')
    expect(evalExpr('"count: " + 3')).toBe('count: 3')
    expect(evalExpr('1 + "2"')).toBe('12')
  })
})

describe('FXL comparison and logic', () => {
  it('loose equality compares across numbers and strings', () => {
    expect(evalExpr('5 == "5"')).toBe(true)
    expect(evalExpr('true == "true"')).toBe(true)
    expect(evalExpr('null == null')).toBe(true)
    expect(evalExpr('null == 0')).toBe(false)
    expect(evalExpr('"a" != "b"')).toBe(true)
  })

  it('strict equality does not coerce', () => {
    expect(evalExpr('5 === "5"')).toBe(false)
    expect(evalExpr('5 === 5')).toBe(true)
    expect(evalExpr('5 !== "5"')).toBe(true)
  })

  it('compares objects and arrays structurally under ==', () => {
    expect(evalExpr('a == b', { a: [1, 2], b: [1, 2] })).toBe(true)
    expect(evalExpr('a == b', { a: { x: 1 }, b: { x: 1 } })).toBe(true)
    expect(evalExpr('a == b', { a: [1], b: [2] })).toBe(false)
  })

  it('relational operators compare numerically then lexically', () => {
    expect(evalExpr('10 > 3')).toBe(true)
    expect(evalExpr('"10" > "3"')).toBe(true) // numeric coercion, not lexical
    expect(evalExpr('2 <= 2')).toBe(true)
    expect(evalExpr('"apple" < "banana"')).toBe(true)
  })

  it('short-circuits && and ||', () => {
    expect(evalExpr('true && false')).toBe(false)
    expect(evalExpr('false || "fallback"')).toBe('fallback')
    expect(evalExpr('"" || "default"')).toBe('default')
    expect(evalExpr('"set" || "default"')).toBe('set')
    expect(evalExpr('a && a.name', { a: null })).toBeNull()
  })

  it('accepts word operators and/or/not', () => {
    expect(evalExpr('true and false')).toBe(false)
    expect(evalExpr('false or true')).toBe(true)
    expect(evalExpr('not false')).toBe(true)
    expect(evalExpr('amount > 100 and status == "open"', { amount: 200, status: 'open' })).toBe(true)
  })

  it('evaluates the ternary operator, right-associatively', () => {
    expect(evalExpr('1 > 0 ? "yes" : "no"')).toBe('yes')
    expect(evalExpr('n > 10 ? "big" : n > 5 ? "medium" : "small"', { n: 7 })).toBe('medium')
  })

  it('the in operator works over arrays, strings, and objects', () => {
    expect(evalExpr('"b" in ["a", "b", "c"]')).toBe(true)
    expect(evalExpr('"z" in ["a", "b"]')).toBe(false)
    expect(evalExpr('"ell" in "hello"')).toBe(true)
    expect(evalExpr('"name" in obj', { obj: { name: 'Ada' } })).toBe(true)
    expect(evalExpr('status in ["open", "review"]', { status: 'review' })).toBe(true)
  })
})

describe('FXL array and object literals', () => {
  it('builds array literals with evaluated elements', () => {
    expect(evalExpr('[1, 2, 3]')).toEqual([1, 2, 3])
    expect(evalExpr('[a, a * 2, "x"]', { a: 5 })).toEqual([5, 10, 'x'])
    expect(evalExpr('[]')).toEqual([])
  })

  it('builds object literals with identifier and string keys', () => {
    expect(evalExpr('{ a: 1, b: "two" }')).toEqual({ a: 1, b: 'two' })
    expect(evalExpr('{ "full name": name, age: age + 1 }', { name: 'Ada', age: 35 }))
      .toEqual({ 'full name': 'Ada', age: 36 })
    expect(evalExpr('{}')).toEqual({})
  })

  it('nests objects and arrays', () => {
    expect(evalExpr('{ id: item.id, tags: [item.a, item.b] }', { item: { id: 7, a: 'x', b: 'y' } }))
      .toEqual({ id: 7, tags: ['x', 'y'] })
  })

  it('computes fields with functions and ternaries', () => {
    expect(
      evalExpr('{ name: upper(name), tier: total > 100 ? "gold" : "standard" }', {
        name: 'ada',
        total: 150,
      })
    ).toEqual({ name: 'ADA', tier: 'gold' })
  })

  it('drops prototype-polluting keys from an object literal', () => {
    const result = evalExpr('{ __proto__: 1, safe: 2 }')
    expect(result).toEqual({ safe: 2 })
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
  })

  it('reports a malformed object literal', () => {
    expect(() => parse('{ a 1 }')).toThrow(/Expected ":"/)
    expect(() => parse('{ 1: 2 }')).toThrow(/Expected a property name/)
  })
})

describe('FXL member and index access', () => {
  it('reads nested object properties', () => {
    expect(evalExpr('user.profile.name', { user: { profile: { name: 'Ada' } } })).toBe('Ada')
  })

  it('reads array and string indices', () => {
    expect(evalExpr('items[1]', { items: ['a', 'b', 'c'] })).toBe('b')
    expect(evalExpr('word[0]', { word: 'hi' })).toBe('h')
    expect(evalExpr('data[key]', { data: { a: 1, b: 2 }, key: 'b' })).toBe(2)
  })

  it('returns undefined when walking through a missing path', () => {
    expect(evalExpr('a.b.c', { a: {} })).toBeUndefined()
    expect(evalExpr('a.b.c', {})).toBeUndefined()
    expect(evalExpr('missing[0]', {})).toBeUndefined()
  })

  it('chains member access and calls', () => {
    expect(evalExpr('upper(user.name)', { user: { name: 'ada' } })).toBe('ADA')
  })
})

describe('FXL standard library', () => {
  it('string helpers', () => {
    expect(evalExpr('upper("abc")')).toBe('ABC')
    expect(evalExpr('lower("ABC")')).toBe('abc')
    expect(evalExpr('trim("  x  ")')).toBe('x')
    expect(evalExpr('contains("hello world", "world")')).toBe(true)
    expect(evalExpr('startsWith("hello", "he")')).toBe(true)
    expect(evalExpr('endsWith("hello", "lo")')).toBe(true)
    expect(evalExpr('replace("a-b-c", "-", "_")')).toBe('a_b_c')
    expect(evalExpr('split("a,b,c", ",")')).toEqual(['a', 'b', 'c'])
    expect(evalExpr('join(["a", "b"], "-")')).toBe('a-b')
  })

  it('number and math helpers', () => {
    expect(evalExpr('abs(-5)')).toBe(5)
    expect(evalExpr('round(3.14159, 2)')).toBe(3.14)
    expect(evalExpr('floor(3.9)')).toBe(3)
    expect(evalExpr('ceil(3.1)')).toBe(4)
    expect(evalExpr('min(3, 1, 2)')).toBe(1)
    expect(evalExpr('max([3, 7, 2])')).toBe(7)
    expect(evalExpr('sum([1, 2, 3])')).toBe(6)
    expect(evalExpr('avg([2, 4])')).toBe(3)
    expect(evalExpr('clamp(15, 0, 10)')).toBe(10)
  })

  it('array helpers', () => {
    expect(evalExpr('len([1, 2, 3])')).toBe(3)
    expect(evalExpr('first([1, 2, 3])')).toBe(1)
    expect(evalExpr('last([1, 2, 3])')).toBe(3)
    expect(evalExpr('reverse([1, 2])')).toEqual([2, 1])
    expect(evalExpr('sort([3, 1, 2])')).toEqual([1, 2, 3])
    expect(evalExpr('unique([1, 1, 2])')).toEqual([1, 2])
    expect(evalExpr('slice([1, 2, 3, 4], 1, 3)')).toEqual([2, 3])
  })

  it('date helpers extract UTC components', () => {
    const scope = { d: '2026-01-14T09:23:45Z' }
    expect(evalExpr('year(d)', scope)).toBe(2026)
    expect(evalExpr('month(d)', scope)).toBe(1) // 1-based
    expect(evalExpr('day(d)', scope)).toBe(14)
    expect(evalExpr('hour(d)', scope)).toBe(9)
    expect(evalExpr('minute(d)', scope)).toBe(23)
    expect(evalExpr('weekday(d)', scope)).toBe(3) // Wednesday
    expect(evalExpr('parseDate(1768382625000)')).toBe('2026-01-14T09:23:45.000Z')
  })

  it('date arithmetic and comparison', () => {
    expect(evalExpr('dateAdd("2026-01-14T00:00:00Z", 2, "days")')).toBe('2026-01-16T00:00:00.000Z')
    expect(evalExpr('dateAdd("2026-01-14T00:00:00Z", -30, "minutes")')).toBe('2026-01-13T23:30:00.000Z')
    expect(evalExpr('dateDiff("2026-01-14T00:00:00Z", "2026-01-21T00:00:00Z", "days")')).toBe(7)
    expect(evalExpr('dateDiff("2026-01-14T00:00:00Z", "2026-01-14T06:00:00Z", "hours")')).toBe(6)
    expect(evalExpr('isBefore("2026-01-01T00:00:00Z", "2026-06-01T00:00:00Z")')).toBe(true)
    expect(evalExpr('isAfter("2026-06-01T00:00:00Z", "2026-01-01T00:00:00Z")')).toBe(true)
  })

  it('date helpers reject bad input and units', () => {
    expect(() => evalExpr('year("not a date")')).toThrow(/not a valid date/)
    expect(() => evalExpr('dateAdd("2026-01-14T00:00:00Z", 1, "fortnights")')).toThrow(/unit must be one of/)
  })

  it('object helpers', () => {
    expect(evalExpr('keys(obj)', { obj: { a: 1, b: 2 } })).toEqual(['a', 'b'])
    expect(evalExpr('values(obj)', { obj: { a: 1, b: 2 } })).toEqual([1, 2])
    expect(evalExpr('has(obj, "a")', { obj: { a: 1 } })).toBe(true)
    expect(evalExpr('get(obj, "a.b", "fallback")', { obj: { a: { b: 7 } } })).toBe(7)
    expect(evalExpr('get(obj, "a.z", "fallback")', { obj: { a: {} } })).toBe('fallback')
  })

  it('type, coalescing, and json helpers', () => {
    expect(evalExpr('type([])')).toBe('array')
    expect(evalExpr('type(null)')).toBe('null')
    expect(evalExpr('type(5)')).toBe('number')
    expect(evalExpr('len("hello")')).toBe(5)
    expect(evalExpr('isEmpty("")')).toBe(true)
    expect(evalExpr('isEmpty([1])')).toBe(false)
    expect(evalExpr('default(missing, "x")', {})).toBe('x')
    expect(evalExpr('coalesce("", null, "third")')).toBe('third')
    expect(evalExpr('parseJson("[1,2]")')).toEqual([1, 2])
    expect(evalExpr('json(obj)', { obj: { a: 1 } })).toBe('{"a":1}')
  })

  it('reports unknown functions and arity errors', () => {
    expect(() => evalExpr('bogus(1)')).toThrow(/Unknown function/)
    expect(() => evalExpr('upper()')).toThrow(/expects 1 argument/)
    expect(() => evalExpr('round(1, 2, 3)')).toThrow(/argument/)
  })
})

describe('FXL safety guards', () => {
  it('never traverses prototype-pollution keys', () => {
    expect(evalExpr('obj.__proto__', { obj: {} })).toBeUndefined()
    expect(evalExpr('obj.constructor', { obj: {} })).toBeUndefined()
    expect(evalExpr('obj["__proto__"]', { obj: {} })).toBeUndefined()
    expect(evalExpr('__proto__', { x: 1 })).toBeUndefined()
  })

  it('cannot call methods on values (no host reach)', () => {
    expect(() => parse('"x".toUpperCase()')).toThrow(/Only named functions/)
    expect(() => parse('obj.hasOwnProperty("a")')).toThrow(/Only named functions/)
  })

  it('does not evaluate — a string is inert data', () => {
    // A payload that would be dangerous under eval() is just a string value.
    expect(evalExpr('payload', { payload: 'process.exit(1)' })).toBe('process.exit(1)')
  })

  it('bounds runaway evaluation with a step limit', () => {
    // A deep chain of additions past the (low, overridden) step budget trips.
    const expr = Array.from({ length: 50 }, (_, i) => i).join(' + ')
    expect(() => evalExpr(expr, {}, { maxSteps: 10 })).toThrow(/step limit/)
  })

  it('rejects an over-large expression at parse time', () => {
    const huge = Array.from({ length: 600 }, () => '1').join(' + ')
    expect(() => parse(huge)).toThrow(/too large/)
  })
})

describe('FXL parse errors', () => {
  it('reports unexpected tokens with a position', () => {
    try {
      parse('1 +')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ExpressionError)
      expect(err.message).toMatch(/Unexpected end/)
      expect(typeof err.position).toBe('number')
    }
  })

  it('reports unterminated strings and bad characters', () => {
    expect(() => parse('"open')).toThrow(/Unterminated string/)
    expect(() => parse('1 @ 2')).toThrow(/Unexpected character/)
  })

  it('reports a missing colon in a ternary', () => {
    expect(() => parse('a ? b')).toThrow(/Expected ":"/)
  })

  it('rejects trailing garbage after a complete expression', () => {
    expect(() => parse('1 2')).toThrow(/Unexpected token/)
  })
})

describe('FXL public API', () => {
  it('evaluateBoolean coerces with FXL truthiness', () => {
    expect(evaluateBoolean('amount > 100', { amount: 200 })).toBe(true)
    expect(evaluateBoolean('name', { name: '' })).toBe(false)
    expect(evaluateBoolean('name', { name: 'x' })).toBe(true)
    expect(evaluateBoolean('items', { items: [] })).toBe(true) // non-empty array-ref truthiness: array is truthy
  })

  it('compile parses once and evaluates many times', () => {
    const program = compile('price * qty')
    expect(program.evaluate({ price: 3, qty: 4 })).toBe(12)
    expect(program.evaluate({ price: 5, qty: 2 })).toBe(10)
  })

  it('check reports ok and structured errors for the linter', () => {
    expect(check('a > 1')).toEqual({ ok: true })
    expect(check('')).toEqual({ ok: false, error: 'Expression is empty', position: 0 })
    const bad = check('a +')
    expect(bad.ok).toBe(false)
    expect(bad.error).toMatch(/Unexpected end/)
  })

  it('exposes the stdlib function names', () => {
    expect(FUNCTION_NAMES).toEqual([...FUNCTION_NAMES].sort())
    expect(FUNCTION_NAMES).toContain('upper')
    expect(FUNCTION_NAMES).toContain('coalesce')
  })
})
