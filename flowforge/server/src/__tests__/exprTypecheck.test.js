// The FXL type checker.
//
// Two properties are worth more than any individual rule and are tested
// hardest: it must catch the mistakes that certainly break a run, and it must
// stay *silent* about everything it cannot prove. A checker that cries wolf on
// dynamic data would be turned off within a week, so most of the "no
// diagnostics" cases below are load-bearing rather than filler.

const T = require('../services/types')
const { typeCheck, SIGNATURES } = require('../services/expression/typecheck')
const { FUNCTION_NAMES, FUNCTION_ARITY, parse } = require('../services/expression')

// The scope a Filter node gives an FXL predicate over a list of orders.
const ORDER = T.objectOf({
  amount: T.NUMBER,
  status: T.STRING,
  tags: T.arrayOf(T.STRING),
  customer: T.objectOf({ id: T.STRING, vip: T.BOOLEAN }),
  items: T.arrayOf(T.objectOf({ sku: T.STRING, qty: T.NUMBER })),
})

const codes = (result) => result.diagnostics.map((d) => d.code)
const messages = (result) => result.diagnostics.map((d) => d.message).join('\n')

describe('the signature table is complete', () => {
  // Contract pinning, in the same spirit as the OpenAPI path test: a stdlib
  // function with no signature would silently type as `unknown` forever.
  it('covers every function the stdlib exposes, and invents none', () => {
    expect(Object.keys(SIGNATURES).sort()).toEqual(FUNCTION_NAMES)
  })

  it('reads arity from the registry rather than restating it', () => {
    // If this ever drifts, the checker would refuse a legal call.
    expect(FUNCTION_ARITY.round).toEqual([1, 2])
    expect(FUNCTION_ARITY.coalesce[1]).toBe(Infinity)
  })
})

describe('inferred result types', () => {
  const typeOf = (source, env = ORDER) => T.describe(typeCheck(source, env).type)

  it('types literals and arithmetic', () => {
    expect(typeOf('1 + 2')).toBe('number')
    expect(typeOf('amount * 2')).toBe('number')
    expect(typeOf('"a"')).toBe('string')
    expect(typeOf('true')).toBe('boolean')
    expect(typeOf('null')).toBe('null')
  })

  it('types comparisons and membership as booleans', () => {
    expect(typeOf('amount > 10')).toBe('boolean')
    expect(typeOf('status in ["open", "closed"]')).toBe('boolean')
    expect(typeOf('!status')).toBe('boolean')
  })

  it('concatenates to a string when either side is text', () => {
    expect(typeOf('"total: " + amount')).toBe('string')
    expect(typeOf('amount + 1')).toBe('number')
  })

  it('walks member access through the environment', () => {
    expect(typeOf('customer.id')).toBe('string')
    expect(typeOf('customer.vip')).toBe('boolean')
    expect(typeOf('items')).toBe('{ sku: string, qty: number }[]')
  })

  it('gives an array index the element type', () => {
    expect(typeOf('items[0].sku')).toBe('string')
    expect(typeOf('tags[1]')).toBe('string')
  })

  it('joins the two arms of a ternary and both sides of a fallback', () => {
    expect(typeOf('amount > 1 ? "big" : "small"')).toBe('string')
    expect(typeOf('amount > 1 ? amount : status')).toBe('number | string')
    // `x || y` yields x when truthy and y otherwise, so it really is a join.
    expect(typeOf('status || "unknown"')).toBe('string')
  })

  it('types the polymorphic array helpers from their argument', () => {
    expect(typeOf('first(items)')).toBe('{ sku: string, qty: number }')
    expect(typeOf('last(tags)')).toBe('string')
    expect(typeOf('sort(tags)')).toBe('string[]')
    expect(typeOf('slice(tags, 0, 2)')).toBe('string[]')
    expect(typeOf('slice(status, 0, 2)')).toBe('string')
    expect(typeOf('len(items)')).toBe('number')
    expect(typeOf('split(status, ",")')).toBe('string[]')
  })

  it('resolves get() with a literal path instead of shrugging at `any`', () => {
    expect(typeOf('get(customer, "id")')).toBe('string')
    // A computed path can't be resolved, so it stays dynamic — and silent.
    expect(typeOf('get(customer, status)')).toBe('any')
  })

  it('types an object literal structurally', () => {
    expect(typeOf('{ id: customer.id, n: len(items) }')).toBe('{ id: string, n: number }')
  })
})

describe('errors it must catch', () => {
  it('arithmetic on a value that can never be a number', () => {
    const result = typeCheck('amount * customer', ORDER)
    expect(codes(result)).toEqual(['operand-type'])
    expect(messages(result)).toMatch(/"\*" needs numbers, but the right side is \{ id: string/)
  })

  it('arithmetic on a list', () => {
    expect(codes(typeCheck('items - 1', ORDER))).toEqual(['operand-type'])
  })

  it('a `+` where neither side is text and one is structural', () => {
    expect(codes(typeCheck('items + 1', ORDER))).toEqual(['operand-type'])
    // …but concatenating an object onto a string is legal: it JSON-stringifies.
    expect(codes(typeCheck('"order " + customer', ORDER))).toEqual([])
  })

  it('unary minus on a non-number', () => {
    expect(codes(typeCheck('-customer', ORDER))).toEqual(['operand-type'])
  })

  it('a field that cannot exist, with a suggestion', () => {
    const result = typeCheck('customer.vlp', ORDER)
    expect(codes(result)).toEqual(['no-such-field'])
    expect(messages(result)).toMatch(/has no field "vlp" — did you mean "vip"\?/)
  })

  it('an identifier that is not in scope, with a suggestion', () => {
    const result = typeCheck('ammount > 10', ORDER)
    expect(codes(result)).toEqual(['unknown-identifier'])
    expect(messages(result)).toMatch(/"ammount" is not in scope here — did you mean "amount"\?/)
  })

  it('`.length` on a list — a number in a template, undefined in an expression', () => {
    // This is the flagship catch: the same text means two different things in
    // the two places FlowForge reads data, and only one of them works.
    const result = typeCheck('tags.length > 0', ORDER)
    expect(codes(result)).toEqual(['no-such-field'])
    expect(messages(result)).toMatch(/expressions have no "\.length"; use len\(…\)/)
  })

  it('a bad argument type', () => {
    const result = typeCheck('sum(status)', ORDER)
    expect(codes(result)).toEqual(['argument-type'])
    expect(messages(result)).toMatch(/sum\(\) argument 1 expects unknown\[\], got string/)
  })

  it('a wrong argument count', () => {
    expect(codes(typeCheck('round(amount, 2, 3)', ORDER))).toEqual(['arity'])
    expect(codes(typeCheck('upper()', ORDER))).toEqual(['arity'])
  })

  it('a date unit outside the supported set', () => {
    const result = typeCheck('dateAdd(now(), 1, "weeks")', ORDER)
    expect(codes(result)).toEqual(['invalid-unit'])
    expect(messages(result)).toMatch(/seconds, minutes, hours, days/)
  })

  it('a date helper handed something that is not a timestamp', () => {
    expect(codes(typeCheck('year(customer)', ORDER))).toEqual(['argument-type'])
  })

  it('reports every offending argument, not just the first', () => {
    expect(codes(typeCheck('clamp(customer, items, tags)', ORDER))).toEqual([
      'argument-type',
      'argument-type',
      'argument-type',
    ])
  })
})

describe('warnings for legal-but-meaningless expressions', () => {
  it('ordering two objects, which always reports equal', () => {
    const result = typeCheck('customer > customer', ORDER)
    expect(codes(result)).toEqual(['meaningless-comparison', 'meaningless-comparison'])
    expect(result.diagnostics[0].severity).toBe('warning')
  })

  it('comparing an object to a primitive, which is always false', () => {
    const result = typeCheck('customer == "vip"', ORDER)
    expect(codes(result)).toEqual(['always-false'])
    expect(messages(result)).toMatch(/is always false/)
    expect(messages(typeCheck('customer != "vip"', ORDER))).toMatch(/is always true/)
  })

  it('`in` against something with no members', () => {
    const result = typeCheck('"x" in amount', ORDER)
    expect(codes(result)).toEqual(['always-false'])
  })

  it('does not complain about comparing two values of the same primitive type', () => {
    expect(codes(typeCheck('status == "open"', ORDER))).toEqual([])
    expect(codes(typeCheck('amount >= 10', ORDER))).toEqual([])
    // FXL's == compares string forms, so number-vs-string is a real intent.
    expect(codes(typeCheck('amount == "10"', ORDER))).toEqual([])
  })
})

describe('silence is the default — nothing dynamic is ever reported', () => {
  const OPEN = T.objectOf({ known: T.NUMBER }, { open: true })

  it('says nothing about an unknown environment', () => {
    expect(codes(typeCheck('a.b.c * d - e', T.UNKNOWN))).toEqual([])
    expect(codes(typeCheck('sum(whatever)', T.UNKNOWN))).toEqual([])
  })

  it('says nothing about a field on an open object', () => {
    expect(codes(typeCheck('anything > 5', OPEN))).toEqual([])
    expect(codes(typeCheck('known + unlisted', OPEN))).toEqual([])
  })

  it('says nothing about a value typed `any` — dynamic by contract', () => {
    const env = T.objectOf({ body: T.ANY })
    expect(codes(typeCheck('body.items[0].price * 2', env))).toEqual([])
    expect(codes(typeCheck('sum(body.totals)', env))).toEqual([])
  })

  it('says nothing when a union still has a viable option', () => {
    const env = T.objectOf({ v: T.unionOf([T.NUMBER, T.objectOf({})]) })
    // Might be a number at runtime, so multiplying it is not provably wrong.
    expect(codes(typeCheck('v * 2', env))).toEqual([])
  })

  it('leaves unknown function names to analyze(), which already reports them', () => {
    const result = typeCheck('uppr(status)', ORDER)
    expect(codes(result)).toEqual([])
    expect(result.type).toEqual(T.UNKNOWN)
  })

  it('stops cascading after a bad member — one root cause, one message', () => {
    expect(codes(typeCheck('customer.nope.deeper + 1', ORDER))).toEqual(['no-such-field'])
  })
})

describe('parse failures and positions', () => {
  it('reports a syntax error as data, not an exception', () => {
    const result = typeCheck('amount >', ORDER)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Unexpected end/)
  })

  it('reports an empty source distinctly from a broken one', () => {
    expect(typeCheck('   ', ORDER)).toMatchObject({ ok: false, empty: true })
  })

  it('points the caret at the offending token', () => {
    // The AST carries source offsets so a *semantic* finding can render the
    // same caret a syntax error does.
    const result = typeCheck('amount + customer.vlp', ORDER)
    expect(result.diagnostics[0].position).toBe('amount + customer.'.length)
  })

  it('keeps positions on every node kind the parser builds', () => {
    const ast = parse('a.b + f(1) ? [2] : { k: 3 }')
    const seen = []
    const walk = (n) => {
      if (!n || typeof n !== 'object') return
      if (n.type) seen.push([n.type, n.position])
      for (const v of Object.values(n)) {
        if (Array.isArray(v)) v.forEach(walk)
        else if (v && typeof v === 'object') walk(v)
      }
    }
    walk(ast)
    expect(seen.length).toBeGreaterThan(5)
    for (const [, position] of seen) expect(typeof position).toBe('number')
  })
})
