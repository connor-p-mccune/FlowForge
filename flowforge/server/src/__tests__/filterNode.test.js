// Tests for the Filter node runner, which keeps the items of a list that
// satisfy an FXL predicate.

const filter = require('../services/nodeRunners/filter')

describe('filter node runner', () => {
  const people = [
    { name: 'Ada', age: 36, admin: true },
    { name: 'Bob', age: 19, admin: false },
    { name: 'Cy', age: 52, admin: false },
  ]

  it('keeps items whose fields satisfy the predicate', async () => {
    const out = await filter({ source: people, predicate: 'age >= 21' }, {})
    expect(out.items).toEqual([people[0], people[2]])
    expect(out.count).toBe(2)
    expect(out.total).toBe(3)
  })

  it('exposes item, index, and the whole list to the predicate', async () => {
    const byItem = await filter({ source: people, predicate: 'item.admin' }, {})
    expect(byItem.items).toEqual([people[0]])

    const byIndex = await filter({ source: [10, 20, 30, 40], predicate: 'index < 2' }, {})
    expect(byIndex.items).toEqual([10, 20])
  })

  it('supports rich boolean logic and stdlib functions', async () => {
    const out = await filter(
      { source: people, predicate: 'age > 18 && contains(lower(name), "a")' },
      {}
    )
    expect(out.items).toEqual([people[0]]) // Ada
  })

  it('filters a list of scalars', async () => {
    const out = await filter({ source: [1, 2, 3, 4, 5], predicate: 'item % 2 == 0' }, {})
    expect(out.items).toEqual([2, 4])
  })

  it('accepts a JSON array string as the source', async () => {
    const out = await filter({ source: '[1, 2, 3]', predicate: 'item > 1' }, {})
    expect(out.items).toEqual([2, 3])
  })

  it('falls back to the node input when it is an array and no source is set', async () => {
    const out = await filter({ predicate: 'item > 1' }, [1, 2, 3])
    expect(out.items).toEqual([2, 3])
  })

  it('requires a predicate', async () => {
    await expect(filter({ source: people }, {})).rejects.toThrow(/requires a predicate/)
    await expect(filter({ source: people, predicate: '   ' }, {})).rejects.toThrow(/requires a predicate/)
  })

  it('requires an array source', async () => {
    await expect(filter({ source: 'not-json', predicate: 'true' }, {})).rejects.toThrow(/must be an array/)
    await expect(filter({ predicate: 'true' }, {})).rejects.toThrow(/requires a source array/)
  })

  it('reports a syntax error in the predicate', async () => {
    await expect(filter({ source: people, predicate: 'age >' }, {})).rejects.toThrow(/predicate is invalid/)
  })

  it('reports a runtime error with the offending item index', async () => {
    await expect(
      filter({ source: [1, 'x', 3], predicate: 'item * 2 > 2' }, {})
    ).rejects.toThrow(/item 2\/3/)
  })

  it('enforces the item cap', async () => {
    const previous = process.env.FILTER_MAX_ITEMS
    process.env.FILTER_MAX_ITEMS = '2'
    try {
      await expect(filter({ source: [1, 2, 3], predicate: 'true' }, {})).rejects.toThrow(/capped at 2/)
    } finally {
      if (previous === undefined) delete process.env.FILTER_MAX_ITEMS
      else process.env.FILTER_MAX_ITEMS = previous
    }
  })
})
