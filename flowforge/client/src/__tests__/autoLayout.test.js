import { describe, it, expect } from 'vitest'
import { layoutGraph } from '../utils/autoLayout'

const node = (id) => ({ id, type: 'x', position: { x: 999, y: 999 }, data: { label: id } })
const edge = (source, target) => ({ id: `${source}-${target}`, source, target })

const posOf = (result, id) => result.find((n) => n.id === id).position

describe('layoutGraph', () => {
  it('stacks a linear chain top to bottom, in order', () => {
    const out = layoutGraph(
      [node('a'), node('b'), node('c')],
      [edge('a', 'b'), edge('b', 'c')]
    )
    expect(posOf(out, 'a').y).toBeLessThan(posOf(out, 'b').y)
    expect(posOf(out, 'b').y).toBeLessThan(posOf(out, 'c').y)
    // A single-column chain lines up on the same x.
    expect(posOf(out, 'a').x).toBe(posOf(out, 'b').x)
    expect(posOf(out, 'b').x).toBe(posOf(out, 'c').x)
  })

  it('places diamond branches side by side on the same rank', () => {
    const out = layoutGraph(
      [node('a'), node('b'), node('c'), node('d')],
      [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')]
    )
    expect(posOf(out, 'b').y).toBe(posOf(out, 'c').y)
    expect(posOf(out, 'b').x).not.toBe(posOf(out, 'c').x)
    // The join lands below both branches.
    expect(posOf(out, 'd').y).toBeGreaterThan(posOf(out, 'b').y)
  })

  it('ranks by longest path, so a shortcut edge cannot hoist a node', () => {
    // a → b → c and a → c directly: c still sits below b.
    const out = layoutGraph(
      [node('a'), node('b'), node('c')],
      [edge('a', 'b'), edge('b', 'c'), edge('a', 'c')]
    )
    expect(posOf(out, 'c').y).toBeGreaterThan(posOf(out, 'b').y)
  })

  it('keeps children under their parents (barycenter ordering)', () => {
    // Two independent chains; their children should not swap columns.
    const out = layoutGraph(
      [node('l'), node('r'), node('lc'), node('rc')],
      [edge('l', 'lc'), edge('r', 'rc')]
    )
    expect(posOf(out, 'lc').x).toBeLessThan(posOf(out, 'rc').x)
    expect(posOf(out, 'l').x).toBeLessThan(posOf(out, 'r').x)
  })

  it('still positions disconnected nodes', () => {
    const out = layoutGraph([node('a'), node('lonely')], [])
    expect(posOf(out, 'lonely')).toBeDefined()
    expect(Number.isFinite(posOf(out, 'lonely').x)).toBe(true)
    // Sources share rank 0.
    expect(posOf(out, 'a').y).toBe(posOf(out, 'lonely').y)
  })

  it('tolerates cycles instead of throwing', () => {
    const out = layoutGraph(
      [node('a'), node('b'), node('c')],
      [edge('a', 'b'), edge('b', 'c'), edge('c', 'b')] // b↔c cycle
    )
    for (const id of ['a', 'b', 'c']) {
      expect(Number.isFinite(posOf(out, id).x)).toBe(true)
      expect(Number.isFinite(posOf(out, id).y)).toBe(true)
    }
  })

  it('ignores edges pointing at missing nodes', () => {
    const out = layoutGraph([node('a')], [edge('a', 'ghost')])
    expect(posOf(out, 'a')).toEqual({ x: 0, y: 0 })
  })

  it('returns new objects and leaves the input untouched', () => {
    const input = [node('a')]
    const out = layoutGraph(input, [])
    expect(out[0]).not.toBe(input[0])
    expect(input[0].position).toEqual({ x: 999, y: 999 })
  })

  it('handles an empty graph', () => {
    expect(layoutGraph([], [])).toEqual([])
  })
})
