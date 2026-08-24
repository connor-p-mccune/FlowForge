import { describe, it, expect } from 'vitest'
import {
  makeDuplicate,
  decorateConditionEdges,
  decorateCollidingEdges,
} from '../utils/nodeOps'

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

// Where two branches supply the same field, one value is silently discarded.
// This is the only thing in the product that has ever drawn which — so the
// tests are mostly about not drawing it on the wrong line.
describe('decorateCollidingEdges', () => {
  const EDGES = [
    { id: 'e1', source: 'billing', target: 'merge' },
    { id: 'e2', source: 'crm', target: 'merge' },
    { id: 'e3', source: 'crm', target: 'elsewhere' },
  ]

  const report = (over = {}) => ({
    joins: [
      {
        nodeId: 'merge',
        label: 'Combine',
        collisions: [
          {
            key: 'status',
            resolution: 'tie-break',
            decidedBy: 'crm',
            sameType: true,
            contributors: [
              { nodeId: 'billing', label: 'Billing lookup', depth: 1, type: 'number' },
              { nodeId: 'crm', label: 'CRM lookup', depth: 1, type: 'number' },
            ],
            ...over,
          },
        ],
      },
    ],
  })

  it('marks the edge whose value does not survive', () => {
    const [billing] = decorateCollidingEdges(EDGES, report())
    expect(billing.label).toBe('status overridden')
    expect(billing.style.strokeDasharray).toBe('5 3')
  })

  it('leaves the winning edge alone', () => {
    const [, crm] = decorateCollidingEdges(EDGES, report())
    expect(crm.label).toBeUndefined()
    expect(crm.style).toBeUndefined()
  })

  it('leaves an edge that goes somewhere else alone', () => {
    const [, , other] = decorateCollidingEdges(EDGES, report())
    expect(other).toBe(EDGES[2])
  })

  it('marks every contributor when no winner can be named', () => {
    // Which one survives depends on the branch that ran, so singling one line
    // out would be a claim the report explicitly declined to make.
    const decorated = decorateCollidingEdges(EDGES, report({ decidedBy: null }))
    expect(decorated[0].label).toBe('status overridden')
    expect(decorated[1].label).toBe('status overridden')
  })

  it('keeps a branch label and adds to it', () => {
    // Losing a merge and taking a branch are different facts about one line.
    const branch = decorateConditionEdges([
      { id: 'e1', source: 'billing', target: 'merge', sourceHandle: 'true' },
    ])
    const [decorated] = decorateCollidingEdges(branch, report())
    expect(decorated.label).toBe('true · status overridden')
    expect(decorated.style.stroke).toBe('#16a34a')
    expect(decorated.style.strokeDasharray).toBe('5 3')
  })

  it('summarises rather than listing a label nobody can read past', () => {
    const many = {
      joins: [
        {
          nodeId: 'merge',
          collisions: ['status', 'body', 'headers', 'ok', 'url'].map((key) => ({
            key,
            resolution: 'tie-break',
            decidedBy: 'crm',
            sameType: true,
            contributors: [
              { nodeId: 'billing', label: 'B', depth: 1, type: 'any' },
              { nodeId: 'crm', label: 'C', depth: 1, type: 'any' },
            ],
          })),
        },
      ],
    }
    expect(decorateCollidingEdges(EDGES, many)[0].label).toBe('body, headers +3 overridden')
  })

  it('returns the same array when there is nothing to draw', () => {
    expect(decorateCollidingEdges(EDGES, null)).toBe(EDGES)
    expect(decorateCollidingEdges(EDGES, { joins: [] })).toBe(EDGES)
    expect(decorateCollidingEdges(EDGES, { available: false, reason: 'cycle' })).toBe(EDGES)
  })
})
