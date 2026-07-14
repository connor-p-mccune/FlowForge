// Tests for the Validate node runner: validate a payload against a JSON Schema
// and settle a 'valid' | 'invalid' branch result.

const runValidate = require('../services/nodeRunners/validate')

const schema = {
  type: 'object',
  required: ['email'],
  properties: { email: { type: 'string', format: 'email' }, age: { type: 'integer', minimum: 0 } },
}

describe('validate node runner', () => {
  it('routes valid input down the valid branch', async () => {
    const out = await runValidate({ schema }, { email: 'a@b.com', age: 20 })
    expect(out.result).toBe('valid')
    expect(out.valid).toBe(true)
    expect(out.errors).toEqual([])
  })

  it('routes invalid input down the invalid branch with the reasons', async () => {
    const out = await runValidate({ schema }, { age: -5 })
    expect(out.result).toBe('invalid')
    expect(out.valid).toBe(false)
    expect(out.errors.some((e) => /required property "email"/.test(e.message))).toBe(true)
    expect(out.errors.find((e) => e.path === '/age')).toBeTruthy()
  })

  it('accepts a schema provided as a JSON string', async () => {
    const out = await runValidate({ schema: JSON.stringify({ type: 'number' }) }, 5)
    expect(out.result).toBe('valid')
  })

  it('validates an explicit source, parsing a JSON string body', async () => {
    const out = await runValidate(
      { schema: { type: 'object', required: ['id'] }, source: '{"id": 7}' },
      { unrelated: true }
    )
    expect(out.result).toBe('valid')
    expect(out.data).toEqual({ id: 7 })
  })

  it('falls back to the node input when no source is given', async () => {
    const out = await runValidate({ schema: { type: 'object', required: ['id'] } }, { id: 1 })
    expect(out.valid).toBe(true)
  })

  it('throws for a missing or unparseable schema', async () => {
    await expect(runValidate({}, {})).rejects.toThrow(/requires a JSON Schema/)
    await expect(runValidate({ schema: '{not json' }, {})).rejects.toThrow(/not valid JSON/)
  })
})
