// Tests for the Aggregate node runner, which reduces a list to summary stats,
// optionally grouped by an FXL key.

const aggregate = require('../services/nodeRunners/aggregate')

describe('aggregate node runner', () => {
  const orders = [
    { region: 'EU', amount: 100 },
    { region: 'US', amount: 200 },
    { region: 'EU', amount: 50 },
    { region: 'US', amount: 200 },
  ]

  it('counts the whole list when no value is given', async () => {
    const out = await aggregate({ source: orders }, {})
    expect(out).toEqual({ count: 4 })
  })

  it('computes sum/avg/min/max over a value expression', async () => {
    const out = await aggregate({ source: orders, value: 'amount' }, {})
    expect(out).toEqual({ count: 4, sum: 550, avg: 137.5, min: 50, max: 200 })
  })

  it('evaluates the value expression per item', async () => {
    const out = await aggregate(
      { source: [{ price: 10, qty: 2 }, { price: 5, qty: 3 }], value: 'price * qty' },
      {}
    )
    expect(out.sum).toBe(35)
  })

  it('groups by an FXL key, preserving first-seen order', async () => {
    const out = await aggregate({ source: orders, value: 'amount', groupBy: 'region' }, {})
    expect(out.count).toBe(4)
    expect(out.groups).toEqual([
      { key: 'EU', count: 2, sum: 150, avg: 75, min: 50, max: 100 },
      { key: 'US', count: 2, sum: 400, avg: 200, min: 200, max: 200 },
    ])
  })

  it('groups with count only when no value is given', async () => {
    const out = await aggregate({ source: orders, groupBy: 'region' }, {})
    expect(out.groups).toEqual([
      { key: 'EU', count: 2 },
      { key: 'US', count: 2 },
    ])
  })

  it('returns zeros / nulls for an empty list', async () => {
    expect(await aggregate({ source: [], value: 'amount' }, {}))
      .toEqual({ count: 0, sum: 0, avg: 0, min: null, max: null })
    expect(await aggregate({ source: [] }, {})).toEqual({ count: 0 })
  })

  it('falls back to array input and accepts a JSON array string', async () => {
    expect((await aggregate({ value: 'item' }, [1, 2, 3])).sum).toBe(6)
    expect((await aggregate({ source: '[2,4]', value: 'item' }, {})).avg).toBe(3)
  })

  it('requires an array source', async () => {
    await expect(aggregate({ source: 'nope', value: 'item' }, {})).rejects.toThrow(/must be an array/)
    await expect(aggregate({ value: 'item' }, {})).rejects.toThrow(/requires a source array/)
  })

  it('reports a syntax error in an expression', async () => {
    await expect(aggregate({ source: orders, value: 'amount +' }, {})).rejects.toThrow(/value expression is invalid/)
    await expect(aggregate({ source: orders, groupBy: '{' }, {})).rejects.toThrow(/group-by expression is invalid/)
  })

  it('fails loudly on a non-numeric value', async () => {
    await expect(
      aggregate({ source: [{ x: 'nope' }], value: 'x' }, {})
    ).rejects.toThrow(/item 1\/1 is not a number/)
  })

  it('enforces the item cap', async () => {
    const previous = process.env.AGGREGATE_MAX_ITEMS
    process.env.AGGREGATE_MAX_ITEMS = '1'
    try {
      await expect(aggregate({ source: [1, 2], value: 'item' }, {})).rejects.toThrow(/capped at 1/)
    } finally {
      if (previous === undefined) delete process.env.AGGREGATE_MAX_ITEMS
      else process.env.AGGREGATE_MAX_ITEMS = previous
    }
  })
})
