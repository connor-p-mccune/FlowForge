import { describe, it, expect } from 'vitest'

import {
  createClock,
  tick,
  observe,
  nodeOps,
  edgeOps,
  applyEffect,
  reconcileSnapshot,
} from '../services/graphOps'

// The client half of the collaboration CRDT. It does not carry the merge — the
// server does — so what is worth testing here is the part the server cannot
// supply: a clock that keeps advancing while the tab is offline, operations at
// field granularity, and applying merged elements back without destroying the
// local view state that is not part of the document.

const node = (id, overrides = {}) => ({
  id,
  type: 'action-http',
  position: { x: 1, y: 2 },
  data: { label: 'Fetch', config: { url: 'https://x', retries: 3 } },
  ...overrides,
})

describe('the clock', () => {
  it('advances on every local edit', () => {
    const clock = createClock()
    expect(tick(clock).l).toBe(1)
    expect(tick(clock).l).toBe(2)
  })

  it('stays ahead of everything it has seen', () => {
    // The receive half of the Lamport rule. Without it a rejoining tab issues
    // operations that lose to changes made while it was away.
    const clock = createClock()
    observe(clock, 40)
    expect(tick(clock).l).toBe(41)
  })

  it('never moves backwards', () => {
    const clock = createClock()
    tick(clock)
    tick(clock)
    observe(clock, 1)
    expect(clock.lamport).toBe(2)
  })

  it('ignores a missing or nonsense clock value', () => {
    const clock = createClock()
    observe(clock, undefined)
    observe(clock, NaN)
    expect(clock.lamport).toBe(0)
  })

  it('gives each tab its own site id', () => {
    expect(createClock().siteId).toBeTruthy()
    // Same tab, same site — one person with the workflow open twice is two
    // replicas, but one tab is one.
    expect(createClock().siteId).toBe(createClock().siteId)
  })
})

describe('building operations', () => {
  it('expands an update into one operation per field', () => {
    // Field granularity is the point: two people editing different config keys
    // of the same node both keep their edit.
    const ops = nodeOps(createClock(), 'update', {
      id: 'h1',
      data: { config: { url: 'https://new' } },
    })
    expect(ops).toEqual([
      { t: 'node.set', id: 'h1', l: 1, s: expect.any(String), path: 'config.url', value: 'https://new' },
    ])
  })

  it('separates data fields from config fields', () => {
    const ops = nodeOps(createClock(), 'update', {
      id: 'h1',
      position: { x: 5, y: 6 },
      data: { label: 'Renamed', config: { url: 'https://x' } },
    })
    expect(ops.map((o) => o.path)).toEqual(['position', 'data.label', 'config.url'])
  })

  it('shares one timestamp across a batch', () => {
    // The operations describe one user action; splitting them across clock
    // values would let another site's edit interleave into the middle of a
    // single gesture.
    const ops = nodeOps(createClock(), 'update', {
      id: 'h1',
      data: { label: 'A', config: { url: 'b', retries: 1 } },
    })
    expect(new Set(ops.map((o) => o.l)).size).toBe(1)
  })

  it('sends an add whole and a remove bare', () => {
    const clock = createClock()
    expect(nodeOps(clock, 'add', node('h1'))[0]).toMatchObject({ t: 'node.add', id: 'h1' })
    expect(nodeOps(clock, 'remove', { id: 'h1' })).toEqual([
      { t: 'node.remove', id: 'h1', l: 2, s: expect.any(String) },
    ])
  })

  it('refuses to build an operation for a reserved key', () => {
    const ops = nodeOps(createClock(), 'update', {
      id: 'h1',
      data: JSON.parse('{"label":"ok","__proto__":{"x":1}}'),
    })
    expect(ops.map((o) => o.path)).toEqual(['data.label'])
  })

  it('ignores an element with no id', () => {
    expect(nodeOps(createClock(), 'add', {})).toEqual([])
    expect(edgeOps(createClock(), 'add', {})).toEqual([])
  })

  it('builds edge add and remove', () => {
    const clock = createClock()
    expect(edgeOps(clock, 'add', { id: 'e1', source: 'a', target: 'b' })[0]).toMatchObject({
      t: 'edge.add',
      id: 'e1',
    })
    expect(edgeOps(clock, 'remove', { id: 'e1' })[0]).toMatchObject({ t: 'edge.remove' })
  })
})

describe('applying a merged element', () => {
  it('adds an element it has never seen', () => {
    expect(applyEffect([], { kind: 'node', id: 'h1', element: node('h1') })).toEqual([node('h1')])
  })

  it('replaces one it already has', () => {
    const before = [node('h1'), node('h2')]
    const after = applyEffect(before, {
      kind: 'node',
      id: 'h1',
      element: node('h1', { data: { label: 'Renamed' } }),
    })
    expect(after[0].data.label).toBe('Renamed')
    expect(after[1]).toBe(before[1])
  })

  it('removes one the merge says is gone', () => {
    expect(applyEffect([node('h1')], { kind: 'node', id: 'h1', element: null })).toEqual([])
  })

  it('is a no-op for a removal it already applied', () => {
    const list = [node('h1')]
    expect(applyEffect(list, { kind: 'node', id: 'gone', element: null })).toBe(list)
  })

  it('keeps local selection through a remote edit', () => {
    // Having somebody else's rename clear your selection is exactly the kind of
    // thing that makes shared editing feel hostile. Selection is view state,
    // not part of the document.
    const before = [{ ...node('h1'), selected: true }]
    const after = applyEffect(before, {
      kind: 'node',
      id: 'h1',
      element: node('h1', { data: { label: 'Theirs' } }),
    })
    expect(after[0]).toMatchObject({ selected: true, data: { label: 'Theirs' } })
  })
})

describe('reconciling a snapshot', () => {
  it('takes the server’s graph', () => {
    const after = reconcileSnapshot([node('old')], [node('new')])
    expect(after.map((n) => n.id)).toEqual(['new'])
  })

  it('keeps a selection through a reconnect', () => {
    const after = reconcileSnapshot(
      [{ ...node('h1'), selected: true }],
      [node('h1', { data: { label: 'Server' } })]
    )
    expect(after[0]).toMatchObject({ selected: true, data: { label: 'Server' } })
  })

  it('does not teleport a node the user is holding', () => {
    // A snapshot landing mid-drag would move the node out from under the
    // pointer; the local position is the freshest information anywhere.
    const held = { ...node('h1'), dragging: true, position: { x: 999, y: 999 } }
    const after = reconcileSnapshot([held], [node('h1', { position: { x: 0, y: 0 } })])
    expect(after[0].position).toEqual({ x: 999, y: 999 })
  })
})
