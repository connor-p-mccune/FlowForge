// The server-side graph diff behind drift detection: node identity by id
// (position ignored), edge identity by (source, target, sourceHandle),
// structural config comparison, and the compact wire presentation.

const { diffGraphs, presentDiff } = require('../services/graphDiff')

const node = (id, type, config = {}, extra = {}) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label: extra.label || id, config },
})
const edge = (source, target, sourceHandle = null) => ({
  id: `${source}-${target}`,
  source,
  target,
  sourceHandle,
})

describe('diffGraphs', () => {
  it('reports identical graphs as identical — position moves are not drift', () => {
    const before = {
      nodes: [node('t1', 'trigger-manual'), node('h1', 'action-http', { url: 'https://a' })],
      edges: [edge('t1', 'h1')],
    }
    const after = {
      nodes: [
        { ...node('t1', 'trigger-manual'), position: { x: 500, y: 900 } },
        node('h1', 'action-http', { url: 'https://a' }),
      ],
      // Recreated edge: new id, same endpoints — not churn.
      edges: [{ ...edge('t1', 'h1'), id: 'brand-new-edge-id' }],
    }
    expect(diffGraphs(before, after).identical).toBe(true)
  })

  it('detects added, removed, and changed nodes with dotted change paths', () => {
    const before = {
      nodes: [node('t1', 'trigger-manual'), node('h1', 'action-http', { url: 'https://a' })],
      edges: [edge('t1', 'h1')],
    }
    const after = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('h1', 'action-http', { url: 'https://b' }, { label: 'Fetch' }),
        node('o1', 'output-log', {}),
      ],
      edges: [edge('t1', 'h1'), edge('h1', 'o1')],
    }
    const diff = diffGraphs(before, after)
    expect(diff.identical).toBe(false)
    expect(diff.addedNodes.map((n) => n.id)).toEqual(['o1'])
    expect(diff.removedNodes).toEqual([])
    expect(diff.changedNodes).toHaveLength(1)
    expect(diff.changedNodes[0].changes.sort()).toEqual(['config.url', 'label'])
    expect(diff.addedEdges).toHaveLength(1)
  })

  it('ignores the order of a config object\'s own keys', () => {
    // Comparison is per config key over a merged key set, so the order the
    // keys appear in the JSON document cannot manufacture a change.
    const before = { nodes: [node('h1', 'action-http', { url: 'https://a', method: 'GET' })], edges: [] }
    const after = { nodes: [node('h1', 'action-http', { method: 'GET', url: 'https://a' })], edges: [] }
    expect(diffGraphs(before, after).identical).toBe(true)
  })

  it('distinguishes edges by sourceHandle', () => {
    const before = { nodes: [node('c1', 'condition'), node('a', 'output-log')], edges: [edge('c1', 'a', 'true')] }
    const after = { nodes: [node('c1', 'condition'), node('a', 'output-log')], edges: [edge('c1', 'a', 'false')] }
    const diff = diffGraphs(before, after)
    expect(diff.addedEdges).toHaveLength(1)
    expect(diff.removedEdges).toHaveLength(1)
  })
})

describe('presentDiff', () => {
  it('renders compact items and a count summary, never raw configs', () => {
    const before = {
      nodes: [node('t1', 'trigger-manual'), node('h1', 'action-http', { url: 'https://a', token: 'sekrit' })],
      edges: [edge('t1', 'h1')],
    }
    const after = {
      nodes: [node('t1', 'trigger-manual'), node('n2', 'output-log', {}, { label: 'Log it' })],
      edges: [edge('t1', 'n2')],
    }
    const out = presentDiff(diffGraphs(before, after), before, after)
    expect(out.identical).toBe(false)
    expect(out.addedNodes).toEqual([{ id: 'n2', type: 'output-log', label: 'Log it' }])
    expect(out.removedNodes).toEqual([{ id: 'h1', type: 'action-http', label: 'h1' }])
    expect(out.removedEdges[0].description).toBe('t1 → h1')
    expect(out.summary).toEqual({
      addedNodes: 1,
      removedNodes: 1,
      changedNodes: 0,
      addedEdges: 1,
      removedEdges: 1,
    })
    // The wire shape carries labels and change paths, not config payloads.
    expect(JSON.stringify(out)).not.toContain('sekrit')
  })
})
