// Three-way merge for workflow graphs.
//
// The tests are organised around the property that justifies building this at
// all: a merge must combine *unrelated* edits without asking, and must refuse
// to guess at *related* ones. A merge that conflicts too eagerly is a
// last-write-wins with extra steps, and one that conflicts too rarely silently
// destroys someone's work — so both directions are pinned hard.

const { mergeGraphs, describeConflict, sameNode } = require('../services/graphMerge')

const node = (id, type, config = {}, label = id) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label, config },
})
const edge = (source, target, sourceHandle = null) => ({
  id: `${source}-${target}`,
  source,
  target,
  sourceHandle,
})

const graph = (nodes, edges = []) => ({ nodes, edges })

const http = (id, config = {}, label = id) =>
  node(id, 'action-http', { method: 'GET', url: 'https://api/x', retries: 3, ...config }, label)

describe('clean merges', () => {
  it('combines edits to different fields of the same node', () => {
    // The case that justifies a real three-way merge: one person changed the
    // URL, the other the retry count. A node-granular merge would call this a
    // conflict and be useless for the situation it exists for.
    const base = graph([http('h1')])
    const ours = graph([http('h1', { url: 'https://api/live' })])
    const theirs = graph([http('h1', { retries: 5 })])

    const result = mergeGraphs(base, ours, theirs)
    expect(result.clean).toBe(true)
    expect(result.graph.nodes[0].data.config).toMatchObject({
      url: 'https://api/live',
      retries: 5,
    })
  })

  it('treats the same edit on both sides as agreement, not conflict', () => {
    const base = graph([http('h1')])
    const both = graph([http('h1', { url: 'https://api/v2' })])
    const result = mergeGraphs(base, both, both)
    expect(result.clean).toBe(true)
    expect(result.graph.nodes[0].data.config.url).toBe('https://api/v2')
  })

  it('ignores position entirely — dragging a node is not a semantic change', () => {
    const base = graph([http('h1')])
    const ours = { nodes: [{ ...http('h1'), position: { x: 900, y: 40 } }], edges: [] }
    const theirs = { nodes: [{ ...http('h1'), position: { x: 12, y: 700 } }], edges: [] }

    const result = mergeGraphs(base, ours, theirs)
    expect(result.clean).toBe(true)
    // Ours wins, silently: a merge that stopped to ask about coordinates would
    // be unusable.
    expect(result.graph.nodes[0].position).toEqual({ x: 900, y: 40 })
  })

  it('takes a node added on either side', () => {
    const base = graph([node('t1', 'trigger-manual')])
    const ours = graph([node('t1', 'trigger-manual'), http('h1')], [edge('t1', 'h1')])
    const theirs = graph([node('t1', 'trigger-manual'), node('l1', 'output-log', { message: 'x' })], [edge('t1', 'l1')])

    const result = mergeGraphs(base, ours, theirs)
    expect(result.clean).toBe(true)
    expect(result.graph.nodes.map((n) => n.id).sort()).toEqual(['h1', 'l1', 't1'])
    expect(result.graph.edges).toHaveLength(2)
  })

  it('honours a delete when the other side left the node alone', () => {
    const base = graph([node('t1', 'trigger-manual'), http('h1')], [edge('t1', 'h1')])
    const ours = base
    const theirs = graph([node('t1', 'trigger-manual')])

    const result = mergeGraphs(base, ours, theirs)
    expect(result.clean).toBe(true)
    expect(result.graph.nodes.map((n) => n.id)).toEqual(['t1'])
    expect(result.summary.removed).toBe(1)
  })

  it('merges edge additions and removals as a set', () => {
    const base = graph([node('a', 'output-log', { message: 'a' }), node('b', 'output-log', { message: 'b' }), node('c', 'output-log', { message: 'c' })], [edge('a', 'b')])
    const ours = graph(base.nodes, [edge('a', 'b'), edge('b', 'c')]) // added b→c
    const theirs = graph(base.nodes, []) // removed a→b

    const result = mergeGraphs(base, ours, theirs)
    expect(result.clean).toBe(true)
    expect(result.graph.edges.map((e) => `${e.source}→${e.target}`)).toEqual(['b→c'])
  })

  it('matches edges by endpoints, so a re-created connection is the same edge', () => {
    const base = graph([node('a', 'output-log', { message: 'a' }), node('b', 'output-log', { message: 'b' })], [edge('a', 'b')])
    const ours = graph(base.nodes, [{ id: 'different-id', source: 'a', target: 'b', sourceHandle: null }])
    const result = mergeGraphs(base, ours, base)
    expect(result.clean).toBe(true)
    expect(result.graph.edges).toHaveLength(1)
  })
})

describe('conflicts', () => {
  it('reports two different edits to the same field', () => {
    const base = graph([http('h1')])
    const ours = graph([http('h1', { url: 'https://live/x' })])
    const theirs = graph([http('h1', { url: 'https://git/x' })])

    const result = mergeGraphs(base, ours, theirs)
    expect(result.clean).toBe(false)
    expect(result.graph).toBeNull()
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        kind: 'field',
        nodeId: 'h1',
        field: 'config.url',
        base: 'https://api/x',
        ours: 'https://live/x',
        theirs: 'https://git/x',
      }),
    ])
  })

  it('reports a node deleted on one side and edited on the other, both ways round', () => {
    const base = graph([node('t1', 'trigger-manual'), http('h1')])

    const deletedByThem = mergeGraphs(
      base,
      graph([node('t1', 'trigger-manual'), http('h1', { url: 'https://live/x' })]),
      graph([node('t1', 'trigger-manual')])
    )
    expect(deletedByThem.conflicts[0]).toMatchObject({
      kind: 'modify-delete',
      nodeId: 'h1',
    })

    const deletedByUs = mergeGraphs(
      base,
      graph([node('t1', 'trigger-manual')]),
      graph([node('t1', 'trigger-manual'), http('h1', { url: 'https://git/x' })])
    )
    expect(deletedByUs.conflicts[0]).toMatchObject({
      kind: 'delete-modify',
      nodeId: 'h1',
    })
  })

  it('reports two different nodes added under the same id', () => {
    const base = graph([node('t1', 'trigger-manual')])
    const ours = graph([node('t1', 'trigger-manual'), http('x', { url: 'https://live' })])
    const theirs = graph([node('t1', 'trigger-manual'), http('x', { url: 'https://git' })])

    const result = mergeGraphs(base, ours, theirs)
    expect(result.clean).toBe(false)
    expect(result.conflicts[0].field).toBe('config.url')
  })

  it('produces no graph at all when anything conflicts', () => {
    // A graph with conflict markers is not a graph, and writing a half-merged
    // definition into a workflow that may be deployed is not acceptable.
    const base = graph([http('h1'), http('h2')])
    const ours = graph([http('h1', { url: 'a' }), http('h2', { url: 'clean-ours' })])
    const theirs = graph([http('h1', { url: 'b' }), http('h2')])

    const result = mergeGraphs(base, ours, theirs)
    expect(result.graph).toBeNull()
    expect(result.summary.conflicts).toBe(1)
  })

  it('describes a conflict compactly enough to scan', () => {
    const conflict = {
      kind: 'field',
      label: 'Charge card',
      field: 'config.url',
      ours: 'https://live/x',
      theirs: 'https://git/x',
    }
    expect(describeConflict(conflict)).toBe(
      'Charge card · config.url: live "https://live/x" vs document "https://git/x"'
    )
    expect(describeConflict({ kind: 'modify-delete', label: 'Ship', detail: 'gone' })).toBe(
      'Ship: gone'
    )
  })
})

describe('strategies', () => {
  const base = graph([http('h1')])
  const ours = graph([http('h1', { url: 'https://live/x' })])
  const theirs = graph([http('h1', { url: 'https://git/x' })])

  it('--ours resolves a conflicted field to the live value', () => {
    const result = mergeGraphs(base, ours, theirs, { strategy: 'ours' })
    expect(result.clean).toBe(true)
    expect(result.graph.nodes[0].data.config.url).toBe('https://live/x')
  })

  it('--theirs resolves it to the document', () => {
    const result = mergeGraphs(base, ours, theirs, { strategy: 'theirs' })
    expect(result.clean).toBe(true)
    expect(result.graph.nodes[0].data.config.url).toBe('https://git/x')
  })

  it('resolves a modify-delete by side too', () => {
    const b = graph([node('t1', 'trigger-manual'), http('h1')])
    const o = graph([node('t1', 'trigger-manual'), http('h1', { url: 'https://live' })])
    const t = graph([node('t1', 'trigger-manual')])

    expect(mergeGraphs(b, o, t, { strategy: 'ours' }).graph.nodes.map((n) => n.id).sort())
      .toEqual(['h1', 't1'])
    expect(mergeGraphs(b, o, t, { strategy: 'theirs' }).graph.nodes.map((n) => n.id))
      .toEqual(['t1'])
  })
})

describe('graph integrity', () => {
  it('drops an edge whose endpoint the merge removed, and says it did', () => {
    // They deleted the node; we added an edge into it. The edge survives the
    // set merge but points at nothing — debris, not a conflict, and the engine
    // would refuse the graph.
    const base = graph([node('t1', 'trigger-manual'), http('h1')], [])
    const ours = graph([node('t1', 'trigger-manual'), http('h1')], [edge('t1', 'h1')])
    const theirs = graph([node('t1', 'trigger-manual')], [])

    const result = mergeGraphs(base, ours, theirs)
    expect(result.clean).toBe(true)
    expect(result.graph.edges).toHaveLength(0)
    expect(result.droppedEdges).toEqual([
      { source: 't1', target: 'h1', sourceHandle: null, reason: 'an endpoint was removed by the merge' },
    ])
  })

  it('keeps branch handles distinct — a true edge is not a false edge', () => {
    const nodes = [node('c1', 'condition'), node('a', 'output-log', { message: 'a' })]
    const base = graph(nodes, [])
    const ours = graph(nodes, [edge('c1', 'a', 'true')])
    const theirs = graph(nodes, [edge('c1', 'a', 'false')])

    const result = mergeGraphs(base, ours, theirs)
    expect(result.clean).toBe(true)
    expect(result.graph.edges.map((e) => e.sourceHandle).sort()).toEqual(['false', 'true'])
  })

  it('summarises what the merge did', () => {
    const base = graph([node('t1', 'trigger-manual'), http('h1')], [edge('t1', 'h1')])
    const ours = graph([node('t1', 'trigger-manual'), http('h1', { url: 'https://live' })], [edge('t1', 'h1')])
    const theirs = graph(
      [node('t1', 'trigger-manual'), http('h1'), node('l1', 'output-log', { message: 'x' })],
      [edge('t1', 'h1'), edge('h1', 'l1')]
    )

    const result = mergeGraphs(base, ours, theirs)
    expect(result.summary).toMatchObject({ added: 1, changed: 1, conflicts: 0, nodes: 3, edges: 2 })
  })

  it('merges cleanly against an empty base', () => {
    // No common ancestor resolvable: every node reads as added by whichever
    // side has it, which is the safest possible reading — nothing is deleted.
    const ours = graph([http('h1', { url: 'https://live' })])
    const theirs = graph([node('l1', 'output-log', { message: 'x' })])
    const result = mergeGraphs({ nodes: [], edges: [] }, ours, theirs)
    expect(result.clean).toBe(true)
    expect(result.graph.nodes.map((n) => n.id).sort()).toEqual(['h1', 'l1'])
  })
})

describe('sameNode', () => {
  it('compares semantics, not position or edge ids', () => {
    expect(sameNode(http('h1'), { ...http('h1'), position: { x: 99, y: 99 } })).toBe(true)
    expect(sameNode(http('h1'), http('h1', { url: 'other' }))).toBe(false)
    expect(sameNode(http('h1', {}, 'A'), http('h1', {}, 'B'))).toBe(false)
  })
})
