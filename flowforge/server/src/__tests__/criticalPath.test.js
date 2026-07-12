// Tests for critical-path analysis: the longest dependency-respecting chain of
// steps through a run's executed subgraph (CPM), which is what actually set the
// run's wall-clock time.

const { computeCriticalPath } = require('../services/criticalPath')

// Build a step row spanning [startSec, endSec) seconds from an epoch, so
// durations are exact and readable.
const T0 = Date.parse('2026-01-01T00:00:00.000Z')
const step = (nodeId, startSec, endSec, status = 'succeeded') => ({
  node_id: nodeId,
  status,
  started_at: new Date(T0 + startSec * 1000).toISOString(),
  finished_at: new Date(T0 + endSec * 1000).toISOString(),
})
const edge = (source, target) => ({ source, target })

describe('computeCriticalPath', () => {
  it('returns empty for no executed steps', () => {
    expect(computeCriticalPath({ edges: [] }, [])).toEqual({ path: [], totalMs: 0, durationsMs: {} })
  })

  it('is a single node for a one-step run', () => {
    const result = computeCriticalPath({ edges: [] }, [step('a', 0, 2)])
    expect(result.path).toEqual(['a'])
    expect(result.totalMs).toBe(2000)
  })

  it('follows the longest branch of a diamond, not the wall clock', () => {
    // t → (b: 1s, c: 3s) → d: 1s. Critical path is t → c → d (0 + 3 + 1 = ... plus t).
    const graph = {
      edges: [edge('t', 'b'), edge('t', 'c'), edge('b', 'd'), edge('c', 'd')],
    }
    const steps = [
      step('t', 0, 0.5), // 0.5s
      step('b', 0.5, 1.5), // 1s (short branch)
      step('c', 0.5, 3.5), // 3s (long branch)
      step('d', 3.5, 4), // 0.5s (join, waits for c)
    ]
    const result = computeCriticalPath(graph, steps)
    expect(result.path).toEqual(['t', 'c', 'd'])
    expect(result.totalMs).toBe(500 + 3000 + 500)
    expect(result.durationsMs).toEqual({ t: 500, c: 3000, d: 500 })
  })

  it('excludes skipped nodes and edges into them', () => {
    // Condition took the true branch: yes ran, no was skipped.
    const graph = {
      edges: [edge('t', 'cond'), edge('cond', 'yes'), edge('cond', 'no'), edge('yes', 'end'), edge('no', 'end')],
    }
    const steps = [
      step('t', 0, 0.1),
      step('cond', 0.1, 0.2),
      step('yes', 0.2, 1.2),
      step('no', 0.2, 0.2, 'skipped'),
      step('end', 1.2, 1.3),
    ]
    const result = computeCriticalPath(graph, steps)
    expect(result.path).toEqual(['t', 'cond', 'yes', 'end'])
    expect(result.path).not.toContain('no')
  })

  it('includes a failed node and stops at it (downstream is skipped)', () => {
    const graph = { edges: [edge('t', 'x'), edge('x', 'y')] }
    const steps = [
      step('t', 0, 0.1),
      step('x', 0.1, 2.1, 'failed'),
      step('y', 2.1, 2.1, 'skipped'),
    ]
    const result = computeCriticalPath(graph, steps)
    expect(result.path).toEqual(['t', 'x'])
    expect(result.totalMs).toBe(100 + 2000)
  })

  it('counts reused nodes (zero duration) as part of the chain', () => {
    const graph = { edges: [edge('a', 'b'), edge('b', 'c')] }
    const steps = [
      step('a', 0, 0, 'reused'),
      step('b', 0, 0, 'reused'),
      step('c', 0, 1.5),
    ]
    const result = computeCriticalPath(graph, steps)
    expect(result.path).toEqual(['a', 'b', 'c'])
    expect(result.totalMs).toBe(1500)
  })

  it('handles two independent chains by picking the heavier', () => {
    const graph = { edges: [edge('a', 'b'), edge('c', 'd')] }
    const steps = [
      step('a', 0, 1),
      step('b', 1, 2), // chain a→b = 2s
      step('c', 0, 0.5),
      step('d', 0.5, 4), // chain c→d = 3.5s (heavier)
    ]
    const result = computeCriticalPath(graph, steps)
    expect(result.path).toEqual(['c', 'd'])
    expect(result.totalMs).toBe(500 + 3500)
  })

  it('ignores edges whose endpoints are not both executed (graph drift)', () => {
    // Edge references 'ghost', a node with no step (deleted/added since the run).
    const graph = { edges: [edge('a', 'b'), edge('ghost', 'b')] }
    const steps = [step('a', 0, 1), step('b', 1, 2)]
    const result = computeCriticalPath(graph, steps)
    expect(result.path).toEqual(['a', 'b'])
    expect(result.totalMs).toBe(2000)
  })

  it('bails to empty on a cycle introduced by a since-edited graph', () => {
    const graph = { edges: [edge('a', 'b'), edge('b', 'a')] }
    const steps = [step('a', 0, 1), step('b', 1, 2)]
    expect(computeCriticalPath(graph, steps)).toEqual({ path: [], totalMs: 0, durationsMs: {} })
  })

  it('collapses duplicate edges without corrupting the order', () => {
    const graph = { edges: [edge('a', 'b'), edge('a', 'b')] }
    const steps = [step('a', 0, 1), step('b', 1, 2)]
    const result = computeCriticalPath(graph, steps)
    expect(result.path).toEqual(['a', 'b'])
  })
})
