import { describe, it, expect } from 'vitest'
import { makeDuplicate, decorateConditionEdges } from '../utils/nodeOps'

const source = {
  id: 'orig',
  type: 'action-http',
  position: { x: 100, y: 200 },
  selected: true,
  data: { label: 'Fetch', config: { url: 'https://x.example', headers: '{}' } },
}

describe('makeDuplicate', () => {
  it('copies type, data, and config under a fresh id with an offset', () => {
    const copy = makeDuplicate(source)
    expect(copy.id).not.toBe(source.id)
    expect(copy.type).toBe('action-http')
    expect(copy.position).toEqual({ x: 140, y: 240 })
    expect(copy.data).toEqual(source.data)
  })

  it('deep-copies data so the duplicate cannot mutate the original', () => {
    const copy = makeDuplicate(source)
    copy.data.config.url = 'https://changed.example'
    expect(source.data.config.url).toBe('https://x.example')
  })

  it('does not carry volatile props like selection', () => {
    const copy = makeDuplicate(source)
    expect(copy).not.toHaveProperty('selected')
  })
})

describe('decorateConditionEdges', () => {
  const plain = { id: 'e1', source: 'a', target: 'b', sourceHandle: null }
  const yes = { id: 'e2', source: 'c', target: 'x', sourceHandle: 'true' }
  const no = { id: 'e3', source: 'c', target: 'y', sourceHandle: 'false' }

  it('labels and colors true/false branch edges', () => {
    const [, decoratedYes, decoratedNo] = decorateConditionEdges([plain, yes, no])
    expect(decoratedYes.label).toBe('true')
    expect(decoratedYes.style.stroke).toBe('#16a34a')
    expect(decoratedNo.label).toBe('false')
    expect(decoratedNo.style.stroke).toBe('#dc2626')
  })

  it('leaves ordinary edges untouched and never mutates the input', () => {
    const input = [plain, yes]
    const result = decorateConditionEdges(input)
    expect(result[0]).toBe(plain) // same object — no decoration needed
    expect(yes).not.toHaveProperty('label') // original untouched
  })

  it('returns the same array reference when no edge needs decorating', () => {
    const input = [plain]
    expect(decorateConditionEdges(input)).toBe(input)
  })

  it('labels and colors an on-error branch edge', () => {
    const err = { id: 'e4', source: 'c', target: 'z', sourceHandle: 'error' }
    const [decorated] = decorateConditionEdges([err])
    expect(decorated.label).toBe('error')
    expect(decorated.style.stroke).toBe('#d97706')
  })
})
