// Tests for the Map node runner, which reshapes each item of a list with an FXL
// expression.

const map = require('../services/nodeRunners/map')

describe('map node runner', () => {
  const people = [
    { name: 'ada', age: 36 },
    { name: 'bob', age: 19 },
  ]

  it('reshapes each item with an object-literal mapping', async () => {
    const out = await map(
      { source: people, mapping: '{ name: upper(name), adult: age >= 18 }' },
      {}
    )
    expect(out.items).toEqual([
      { name: 'ADA', adult: true },
      { name: 'BOB', adult: true },
    ])
    expect(out.count).toBe(2)
  })

  it('supports a scalar mapping expression', async () => {
    const out = await map({ source: [1, 2, 3], mapping: 'item * 10' }, {})
    expect(out.items).toEqual([10, 20, 30])
  })

  it('exposes item, index, and the whole list', async () => {
    const out = await map(
      { source: ['a', 'b'], mapping: '{ value: item, position: index, of: len(items) }' },
      {}
    )
    expect(out.items).toEqual([
      { value: 'a', position: 0, of: 2 },
      { value: 'b', position: 1, of: 2 },
    ])
  })

  it('accepts a JSON array string and falls back to array input', async () => {
    expect((await map({ source: '[1,2]', mapping: 'item + 1' }, {})).items).toEqual([2, 3])
    expect((await map({ mapping: 'item + 1' }, [4, 5])).items).toEqual([5, 6])
  })

  it('requires a mapping expression', async () => {
    await expect(map({ source: people }, {})).rejects.toThrow(/requires a mapping/)
    await expect(map({ source: people, mapping: '  ' }, {})).rejects.toThrow(/requires a mapping/)
  })

  it('requires an array source', async () => {
    await expect(map({ source: 'nope', mapping: 'item' }, {})).rejects.toThrow(/must be an array/)
    await expect(map({ mapping: 'item' }, {})).rejects.toThrow(/requires a source array/)
  })

  it('reports a syntax error in the mapping', async () => {
    await expect(map({ source: people, mapping: '{ a: }' }, {})).rejects.toThrow(/expression is invalid/)
  })

  it('reports a runtime error with the offending item index', async () => {
    await expect(
      map({ source: [1, 'x', 3], mapping: 'item * 2' }, {})
    ).rejects.toThrow(/item 2\/3/)
  })

  it('enforces the item cap', async () => {
    const previous = process.env.MAP_MAX_ITEMS
    process.env.MAP_MAX_ITEMS = '1'
    try {
      await expect(map({ source: [1, 2], mapping: 'item' }, {})).rejects.toThrow(/capped at 1/)
    } finally {
      if (previous === undefined) delete process.env.MAP_MAX_ITEMS
      else process.env.MAP_MAX_ITEMS = previous
    }
  })
})
