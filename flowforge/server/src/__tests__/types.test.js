// The type lattice. Most of these pin *silence* as much as they pin answers:
// the whole design rests on "no rule may report a problem it cannot prove", so
// every operation has to keep dynamic types dynamic rather than guessing.

const t = require('../services/types')

describe('constructors and normalisation', () => {
  it('normalises a union: flattens, dedupes, and unwraps a single option', () => {
    expect(t.unionOf([t.NUMBER])).toEqual(t.NUMBER)
    expect(t.unionOf([t.NUMBER, t.NUMBER])).toEqual(t.NUMBER)
    const u = t.unionOf([t.NUMBER, t.unionOf([t.STRING, t.NUMBER])])
    expect(u.kind).toBe('union')
    expect(u.options).toHaveLength(2)
  })

  it('drops unknown from a union — no information contributes none', () => {
    expect(t.unionOf([t.UNKNOWN, t.STRING])).toEqual(t.STRING)
    expect(t.unionOf([t.UNKNOWN])).toEqual(t.UNKNOWN)
  })

  it('lets any absorb a union — a dynamic option makes the whole thing dynamic', () => {
    expect(t.unionOf([t.NUMBER, t.ANY])).toEqual(t.ANY)
  })

  it('canonicalises objects independently of key order', () => {
    const a = t.objectOf({ x: t.NUMBER, y: t.STRING })
    const b = t.objectOf({ y: t.STRING, x: t.NUMBER })
    expect(t.canonical(a)).toBe(t.canonical(b))
  })

  it('accepts both the bare and the annotated field spec', () => {
    const obj = t.objectOf({ a: t.NUMBER, b: { type: t.STRING, optional: true } })
    expect(obj.fields.a).toEqual({ type: t.NUMBER, optional: false })
    expect(obj.fields.b).toEqual({ type: t.STRING, optional: true })
  })
})

describe('predicates', () => {
  it('treats unknown and any as dynamic, and nothing else', () => {
    expect(t.isDynamic(t.UNKNOWN)).toBe(true)
    expect(t.isDynamic(t.ANY)).toBe(true)
    expect(t.isDynamic(t.NUMBER)).toBe(false)
    expect(t.isDynamic(t.arrayOf(t.ANY))).toBe(false)
  })

  it('mayBe is true for a dynamic type and for every option of a union', () => {
    expect(t.mayBe(t.UNKNOWN, 'string')).toBe(true)
    expect(t.mayBe(t.unionOf([t.NUMBER, t.STRING]), 'string')).toBe(true)
    expect(t.mayBe(t.NUMBER, 'string')).toBe(false)
  })

  it('is() requires certainty, so a union is never definitely one thing', () => {
    expect(t.is(t.NUMBER, 'number')).toBe(true)
    expect(t.is(t.unionOf([t.NUMBER, t.STRING]), 'number')).toBe(false)
    expect(t.is(t.UNKNOWN, 'number')).toBe(false)
  })

  it('counts numbers, booleans, and strings as possibly numeric — FXL coerces them', () => {
    expect(t.mayBeNumeric(t.NUMBER)).toBe(true)
    expect(t.mayBeNumeric(t.BOOLEAN)).toBe(true)
    expect(t.mayBeNumeric(t.STRING)).toBe(true)
    expect(t.mayBeNumeric(t.UNKNOWN)).toBe(true)
    // These three are exactly the ones the evaluator throws on.
    expect(t.mayBeNumeric(t.NULL)).toBe(false)
    expect(t.mayBeNumeric(t.arrayOf(t.NUMBER))).toBe(false)
    expect(t.mayBeNumeric(t.objectOf({}))).toBe(false)
  })

  it('recognises the containers `in` can search', () => {
    expect(t.mayBeContainer(t.arrayOf(t.NUMBER))).toBe(true)
    expect(t.mayBeContainer(t.STRING)).toBe(true)
    expect(t.mayBeContainer(t.objectOf({}))).toBe(true)
    expect(t.mayBeContainer(t.NUMBER)).toBe(false)
  })
})

describe('join', () => {
  it('is the identity on unknown in both directions', () => {
    expect(t.join(t.UNKNOWN, t.NUMBER)).toEqual(t.NUMBER)
    expect(t.join(t.NUMBER, t.UNKNOWN)).toEqual(t.NUMBER)
  })

  it('lets any win over anything known', () => {
    expect(t.join(t.ANY, t.NUMBER)).toEqual(t.ANY)
  })

  it('joins arrays element-wise rather than producing a union of arrays', () => {
    const joined = t.join(t.arrayOf(t.NUMBER), t.arrayOf(t.STRING))
    expect(joined.kind).toBe('array')
    expect(joined.element.kind).toBe('union')
  })

  it('makes a field optional when only one side has it', () => {
    const joined = t.join(t.objectOf({ a: t.NUMBER }), t.objectOf({ a: t.NUMBER, b: t.STRING }))
    expect(joined.fields.a.optional).toBe(false)
    expect(joined.fields.b.optional).toBe(true)
  })

  it('unions the types of a field both sides declare differently', () => {
    const joined = t.join(t.objectOf({ a: t.NUMBER }), t.objectOf({ a: t.STRING }))
    expect(t.describe(joined.fields.a.type)).toBe('number | string')
  })

  it('opens the result when either side is open', () => {
    const joined = t.join(t.objectOf({ a: t.NUMBER }, { open: true }), t.objectOf({ a: t.NUMBER }))
    expect(joined.open).toBe(true)
  })

  it('falls back to a union for unrelated kinds', () => {
    expect(t.join(t.NUMBER, t.STRING).kind).toBe('union')
  })
})

describe('mergeAssign — how the engine actually builds a node input', () => {
  it('keeps a certain contributor’s fields required', () => {
    const merged = t.mergeAssign([{ type: t.objectOf({ a: t.NUMBER }), certain: true }])
    expect(merged.fields.a.optional).toBe(false)
    expect(merged.open).toBe(false)
  })

  it('marks a branch contributor’s fields optional — the branch may not fire', () => {
    const merged = t.mergeAssign([{ type: t.objectOf({ a: t.NUMBER }), certain: false }])
    expect(merged.fields.a.optional).toBe(true)
  })

  it('lets one certain contributor guarantee a field another only might supply', () => {
    const merged = t.mergeAssign([
      { type: t.objectOf({ a: t.NUMBER }), certain: false },
      { type: t.objectOf({ a: t.STRING }), certain: true },
    ])
    expect(merged.fields.a.optional).toBe(false)
    expect(t.describe(merged.fields.a.type)).toBe('number | string')
  })

  it('opens the result when a contributor is dynamic — unlisted fields may exist', () => {
    const merged = t.mergeAssign([
      { type: t.objectOf({ a: t.NUMBER }), certain: true },
      { type: t.UNKNOWN, certain: true },
    ])
    expect(merged.open).toBe(true)
    expect(merged.fields.a.optional).toBe(false)
  })
})

describe('accepts', () => {
  it('never refuses a dynamic value or a dynamic expectation', () => {
    expect(t.accepts(t.NUMBER, t.UNKNOWN)).toBe(true)
    expect(t.accepts(t.UNKNOWN, t.objectOf({}))).toBe(true)
    expect(t.accepts(t.NUMBER, t.ANY)).toBe(true)
  })

  it('refuses a definite mismatch', () => {
    expect(t.accepts(t.NUMBER, t.STRING)).toBe(false)
    expect(t.accepts(t.arrayOf(t.NUMBER), t.objectOf({}))).toBe(false)
  })

  it('accepts a union source only when every option fits', () => {
    expect(t.accepts(t.NUMBER, t.unionOf([t.NUMBER, t.STRING]))).toBe(false)
    expect(t.accepts(t.unionOf([t.NUMBER, t.STRING]), t.NUMBER)).toBe(true)
  })

  it('checks required object fields structurally, ignoring optional ones', () => {
    const want = t.objectOf({ id: t.STRING, note: { type: t.STRING, optional: true } })
    expect(t.accepts(want, t.objectOf({ id: t.STRING }))).toBe(true)
    expect(t.accepts(want, t.objectOf({ id: t.NUMBER }))).toBe(false)
    expect(t.accepts(want, t.objectOf({}))).toBe(false)
    // An open shape might carry the field at runtime, so it is not refused.
    expect(t.accepts(want, t.objectOf({}, { open: true }))).toBe(true)
  })
})

describe('lookup — template access vs FXL member access', () => {
  const list = t.arrayOf(t.STRING)

  it('resolves `length` on an array in a template but not in an expression', () => {
    // The engine's template resolver uses plain JS property access…
    expect(t.lookup(list, 'length', 'template')).toEqual({ exists: 'yes', type: t.NUMBER })
    // …while FXL's readMember refuses every non-integer key on an array, so
    // `items.length` is silently undefined there. Catching that is the whole
    // reason the two modes exist.
    expect(t.lookup(list, 'length', 'expression').exists).toBe('no')
  })

  it('resolves a numeric index to the element type in both modes', () => {
    expect(t.lookup(list, '0', 'expression')).toEqual({ exists: 'maybe', type: t.STRING })
    expect(t.lookup(list, '2', 'template')).toEqual({ exists: 'maybe', type: t.STRING })
  })

  it('reports a missing field on a closed object as definitely absent', () => {
    const obj = t.objectOf({ status: t.NUMBER })
    expect(t.lookup(obj, 'status').exists).toBe('yes')
    expect(t.lookup(obj, 'stats').exists).toBe('no')
  })

  it('stays silent on an open object — we never claimed to know its fields', () => {
    const obj = t.objectOf({ status: t.NUMBER }, { open: true })
    expect(t.lookup(obj, 'anything').exists).toBe('maybe')
  })

  it('reports an optional field as maybe-present', () => {
    const obj = t.objectOf({ note: { type: t.STRING, optional: true } })
    expect(t.lookup(obj, 'note')).toEqual({ exists: 'maybe', type: t.STRING })
  })

  it('reads nothing off a number, in either mode', () => {
    expect(t.lookup(t.NUMBER, 'toFixed').exists).toBe('no')
    expect(t.lookup(t.NUMBER, 'toFixed', 'expression').exists).toBe('no')
  })

  it('needs every union option to lack a field before calling it absent', () => {
    const u = t.unionOf([t.objectOf({ a: t.NUMBER }), t.objectOf({ b: t.STRING })])
    expect(t.lookup(u, 'a').exists).toBe('maybe')
    expect(t.lookup(u, 'zzz').exists).toBe('no')
  })

  it('stays silent on any', () => {
    expect(t.lookup(t.ANY, 'whatever')).toEqual({ exists: 'maybe', type: t.ANY })
  })
})

describe('lookupPath', () => {
  const shape = t.objectOf({ body: t.objectOf({ total: t.NUMBER }) })

  it('walks a good path and returns the leaf type', () => {
    const r = t.lookupPath(shape, ['body', 'total'])
    expect(r.exists).toBe('yes')
    expect(r.type).toEqual(t.NUMBER)
  })

  it('reports which segment failed and what it was read from', () => {
    const r = t.lookupPath(shape, ['body', 'totl'])
    expect(r.exists).toBe('no')
    expect(r.failedAt).toBe(1)
    expect(t.fieldNames(r.container)).toEqual(['total'])
  })

  it('degrades to maybe once it passes through an optional field', () => {
    const optional = t.objectOf({ a: { type: t.objectOf({ b: t.NUMBER }), optional: true } })
    expect(t.lookupPath(optional, ['a', 'b']).exists).toBe('maybe')
  })
})

describe('suggest', () => {
  it('prefers a case-only difference', () => {
    expect(t.suggest('Status', ['status', 'state'])).toBe('status')
  })

  it('finds a one-character typo', () => {
    expect(t.suggest('bdy', ['body', 'status'])).toBe('body')
  })

  it('refuses to guess when nothing is close', () => {
    expect(t.suggest('elephant', ['body', 'status'])).toBeNull()
  })

  it('holds short names to a tighter bar, so "a" is never "corrected" to "b"', () => {
    expect(t.suggest('a', ['b'])).toBeNull()
    expect(t.suggest('id', ['idx'])).toBe('idx')
  })

  it('never suggests the name it was given', () => {
    expect(t.suggest('body', ['body'])).toBeNull()
  })
})

describe('describe', () => {
  it('renders primitives, arrays, objects, and unions compactly', () => {
    expect(t.describe(t.NUMBER)).toBe('number')
    expect(t.describe(t.arrayOf(t.STRING))).toBe('string[]')
    expect(t.describe(t.objectOf({ a: t.NUMBER, b: { type: t.STRING, optional: true } })))
      .toBe('{ a: number, b?: string }')
    expect(t.describe(t.unionOf([t.NUMBER, t.STRING]))).toBe('number | string')
    expect(t.describe(t.arrayOf(t.unionOf([t.NUMBER, t.STRING])))).toBe('(number | string)[]')
  })

  it('marks an open object with an ellipsis so a reader knows the list is partial', () => {
    expect(t.describe(t.objectOf({ a: t.NUMBER }, { open: true }))).toBe('{ a: number, … }')
    expect(t.describe(t.objectOf({}, { open: true }))).toBe('object')
  })

  it('truncates deep nesting rather than printing a wall of braces', () => {
    const deep = t.objectOf({ a: t.objectOf({ b: t.objectOf({ c: t.NUMBER }) }) })
    expect(t.describe(deep)).toBe('{ a: { b: object } }')
  })
})
