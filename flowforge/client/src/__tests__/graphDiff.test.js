import { describe, it, expect } from 'vitest'
import { diffGraphs, describeEdge } from '../utils/graphDiff'

const node = (id, type, config = {}, label = id, position = { x: 0, y: 0 }) => ({
  id,
  type,
  position,
  data: { label, config },
})
const edge = (id, source, target, sourceHandle = null) => ({ id, source, target, sourceHandle })

describe('diffGraphs', () => {
  it('reports identical graphs as identical, ignoring position moves', () => {
    const before = {
      nodes: [node('a', 'trigger-manual'), node('b', 'output-log', { message: 'hi' })],
      edges: [edge('e1', 'a', 'b')],
    }
    const after = {
      nodes: [
        node('a', 'trigger-manual', {}, 'a', { x: 500, y: 300 }), // moved only
        node('b', 'output-log', { message: 'hi' }),
      ],
      edges: [edge('e1', 'a', 'b')],
    }
    const diff = diffGraphs(before, after)
    expect(diff.identical).toBe(true)
  })

  it('detects added and removed nodes', () => {
    const before = { nodes: [node('a', 'trigger-manual')], edges: [] }
    const after = { nodes: [node('a', 'trigger-manual'), node('b', 'output-log')], edges: [] }
    const diff = diffGraphs(before, after)
    expect(diff.addedNodes.map((n) => n.id)).toEqual(['b'])
    expect(diffGraphs(after, before).removedNodes.map((n) => n.id)).toEqual(['b'])
  })

  it('reports which fields changed on a node', () => {
    const before = {
      nodes: [node('h', 'action-http', { url: 'https://old.example', method: 'GET' }, 'Fetch')],
      edges: [],
    }
    const after = {
      nodes: [node('h', 'action-http', { url: 'https://new.example', method: 'GET' }, 'Fetch v2')],
      edges: [],
    }
    const diff = diffGraphs(before, after)
    expect(diff.changedNodes).toHaveLength(1)
    expect(diff.changedNodes[0].changes.sort()).toEqual(['config.url', 'label'])
  })

  it('matches edges semantically, not by id', () => {
    const before = { nodes: [node('a', 't'), node('b', 'o')], edges: [edge('e1', 'a', 'b')] }
    const after = { nodes: [node('a', 't'), node('b', 'o')], edges: [edge('e99', 'a', 'b')] }
    expect(diffGraphs(before, after).identical).toBe(true)
  })

  it('treats a different condition branch as a different edge', () => {
    const before = { nodes: [node('c', 'condition'), node('x', 'o')], edges: [edge('e1', 'c', 'x', 'true')] }
    const after = { nodes: [node('c', 'condition'), node('x', 'o')], edges: [edge('e1', 'c', 'x', 'false')] }
    const diff = diffGraphs(before, after)
    expect(diff.addedEdges).toHaveLength(1)
    expect(diff.removedEdges).toHaveLength(1)
  })
})

describe('describeEdge', () => {
  it('names endpoints by label, even when one only exists in the old graph', () => {
    const before = {
      nodes: [node('a', 't', {}, 'Trigger'), node('gone', 'o', {}, 'Old logger')],
      edges: [],
    }
    const after = { nodes: [node('a', 't', {}, 'Trigger')], edges: [] }
    const text = describeEdge({ source: 'a', target: 'gone', sourceHandle: 'true' }, before, after)
    expect(text).toBe('Trigger → Old logger (true branch)')
  })
})
