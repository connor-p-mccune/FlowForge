// Unit tests for the hand-rolled JSON Schema validator (services/jsonSchema.js).
// Pure function of (schema, data), so every case is a direct assertion.

const { validate } = require('../services/jsonSchema')

const ok = (schema, data) => expect(validate(schema, data).valid).toBe(true)
const bad = (schema, data) => {
  const r = validate(schema, data)
  expect(r.valid).toBe(false)
  return r.errors
}

describe('type checking', () => {
  it('checks primitive types', () => {
    ok({ type: 'string' }, 'hi')
    ok({ type: 'number' }, 3.5)
    ok({ type: 'boolean' }, true)
    ok({ type: 'null' }, null)
    bad({ type: 'string' }, 5)
    bad({ type: 'number' }, '5')
  })

  it('distinguishes integer from number', () => {
    ok({ type: 'integer' }, 42)
    bad({ type: 'integer' }, 42.5)
    ok({ type: 'number' }, 42.5)
  })

  it('treats arrays and objects distinctly (not both "object")', () => {
    ok({ type: 'array' }, [1, 2])
    bad({ type: 'object' }, [1, 2])
    ok({ type: 'object' }, { a: 1 })
    bad({ type: 'array' }, { a: 1 })
  })

  it('does not treat a boolean as a number', () => {
    bad({ type: 'number' }, true)
  })

  it('accepts a union of types', () => {
    ok({ type: ['string', 'null'] }, null)
    ok({ type: ['string', 'null'] }, 'x')
    bad({ type: ['string', 'null'] }, 3)
  })

  it('honours nullable (OpenAPI-style)', () => {
    ok({ type: 'string', nullable: true }, null)
    ok({ type: 'string', nullable: true }, 'x')
  })
})

describe('enum and const', () => {
  it('validates enum membership', () => {
    ok({ enum: ['a', 'b', 'c'] }, 'b')
    bad({ enum: ['a', 'b'] }, 'z')
  })
  it('validates const via deep equality', () => {
    ok({ const: { a: 1, b: 2 } }, { b: 2, a: 1 }) // key order doesn't matter
    bad({ const: 5 }, 6)
  })
})

describe('number constraints', () => {
  it('checks minimum/maximum and their exclusive forms', () => {
    ok({ type: 'number', minimum: 0, maximum: 100 }, 50)
    bad({ minimum: 10 }, 9)
    bad({ maximum: 10 }, 11)
    bad({ exclusiveMinimum: 10 }, 10)
    ok({ exclusiveMinimum: 10 }, 11)
    bad({ exclusiveMaximum: 10 }, 10)
  })
  it('checks multipleOf', () => {
    ok({ multipleOf: 5 }, 25)
    bad({ multipleOf: 5 }, 26)
  })
})

describe('string constraints', () => {
  it('checks length and pattern', () => {
    ok({ type: 'string', minLength: 2, maxLength: 4 }, 'abc')
    bad({ minLength: 3 }, 'ab')
    bad({ maxLength: 3 }, 'abcd')
    ok({ pattern: '^[a-z]+$' }, 'abc')
    bad({ pattern: '^[a-z]+$' }, 'ABC')
  })
  it('checks common formats leniently', () => {
    ok({ format: 'email' }, 'a@b.com')
    bad({ format: 'email' }, 'not-an-email')
    ok({ format: 'date-time' }, '2026-01-14T09:00:00Z')
    bad({ format: 'date-time' }, 'not a date')
  })
  it('ignores an invalid regex in the schema rather than throwing', () => {
    ok({ pattern: '[' }, 'anything')
  })
})

describe('array constraints', () => {
  it('checks minItems/maxItems and uniqueItems', () => {
    ok({ type: 'array', minItems: 1, maxItems: 3 }, [1, 2])
    bad({ minItems: 2 }, [1])
    bad({ maxItems: 2 }, [1, 2, 3])
    ok({ uniqueItems: true }, [1, 2, 3])
    bad({ uniqueItems: true }, [1, 2, 2])
  })
  it('validates every item against items and reports the index', () => {
    ok({ items: { type: 'number' } }, [1, 2, 3])
    const errors = bad({ items: { type: 'number' } }, [1, 'two', 3])
    expect(errors[0].path).toBe('/1')
  })
})

describe('object constraints', () => {
  const schema = {
    type: 'object',
    required: ['id', 'email'],
    properties: {
      id: { type: 'integer' },
      email: { type: 'string', format: 'email' },
      age: { type: 'integer', minimum: 0 },
    },
    additionalProperties: false,
  }

  it('accepts a well-formed object', () => {
    ok(schema, { id: 1, email: 'a@b.com', age: 30 })
  })

  it('flags a missing required property', () => {
    const errors = bad(schema, { id: 1 })
    expect(errors.some((e) => /required property "email"/.test(e.message))).toBe(true)
  })

  it('validates nested property constraints with a pointer path', () => {
    const errors = bad(schema, { id: 1, email: 'nope', age: -1 })
    expect(errors.find((e) => e.path === '/email')).toBeTruthy()
    expect(errors.find((e) => e.path === '/age')).toBeTruthy()
  })

  it('rejects unexpected properties when additionalProperties is false', () => {
    const errors = bad(schema, { id: 1, email: 'a@b.com', extra: true })
    expect(errors.some((e) => /unexpected property "extra"/.test(e.message))).toBe(true)
  })

  it('allows extra properties when additionalProperties is not false', () => {
    const loose = { type: 'object', properties: { id: { type: 'integer' } } }
    ok(loose, { id: 1, anything: 'goes' })
  })

  it('validates deeply nested structures', () => {
    const nested = {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: { type: 'object', required: ['sku'], properties: { sku: { type: 'string' } } },
        },
      },
    }
    ok(nested, { items: [{ sku: 'A1' }, { sku: 'B2' }] })
    const errors = bad(nested, { items: [{ sku: 'A1' }, { qty: 2 }] })
    expect(errors[0].path).toBe('/items/1')
  })
})

describe('boolean schemas', () => {
  it('true accepts anything, false rejects everything', () => {
    ok(true, 42)
    bad(false, 42)
  })
})
