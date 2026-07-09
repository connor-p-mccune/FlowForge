import { describe, it, expect } from 'vitest'
import { makeDuplicate } from '../utils/nodeOps'

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
