// Tests for the measured schedule post-mortem: how much of a finished run was
// work and how much was nodes waiting for an execution slot.
//
// Everything here is derived from step timestamps, so the fixtures are step rows
// at exact second offsets and the assertions are exact milliseconds.

const { analyzeRun, observedDurations } = require('../services/runSchedule')

const T0 = Date.parse('2026-01-01T00:00:00.000Z')
const at = (sec) => new Date(T0 + sec * 1000).toISOString()
const step = (nodeId, startSec, endSec, status = 'succeeded') => ({
  node_id: nodeId,
  status,
  started_at: at(startSec),
  finished_at: endSec == null ? null : at(endSec),
})
const edge = (source, target) => ({ source, target })

describe('analyzeRun', () => {
  it('is unavailable for a run with no started steps', () => {
    expect(analyzeRun({ edges: [] }, []).available).toBe(false)
    expect(analyzeRun({ edges: [] }, [step('a', 0, 1, 'pending')]).available).toBe(false)
  })

  it('reports no queueing when every node started as soon as it could', () => {
    // t → (a, b) both starting the instant t finished.
    const graph = { edges: [edge('t', 'a'), edge('t', 'b')] }
    const steps = [step('t', 0, 1), step('a', 1, 3), step('b', 1, 2)]
    const result = analyzeRun(graph, steps, { cap: 4 })

    expect(result.makespanMs).toBe(3000)
    expect(result.queuedMs).toBe(0)
    expect(result.workMs).toBe(1000 + 2000 + 1000)
  })

  it('measures the wait when a node was ready long before it started', () => {
    // Three nodes ready at t=1, one slot. c waits for both a and b.
    const graph = { edges: [edge('t', 'a'), edge('t', 'b'), edge('t', 'c')] }
    const steps = [step('t', 0, 1), step('a', 1, 3), step('b', 3, 5), step('c', 5, 7)]
    const result = analyzeRun(graph, steps, { cap: 1 })

    expect(result.perNode.a.queuedMs).toBe(0)
    expect(result.perNode.b.queuedMs).toBe(2000) // ready at 1, started at 3
    expect(result.perNode.c.queuedMs).toBe(4000) // ready at 1, started at 5
    expect(result.queuedMs).toBe(6000)
  })

  it('names the node that released the slot, not a predecessor', () => {
    const graph = { edges: [edge('t', 'a'), edge('t', 'b')] }
    const steps = [step('t', 0, 1), step('a', 1, 4), step('b', 4, 5)]
    const result = analyzeRun(graph, steps, { cap: 1 })

    // b's only predecessor is t, which finished at 1 — but b started at 4,
    // when a released the slot. a is not upstream of b in any sense the graph
    // records.
    expect(result.perNode.b.cause).toEqual({ nodeId: 'a', kind: 'slot' })
  })

  it('attributes a genuine data wait to the predecessor', () => {
    const graph = { edges: [edge('a', 'b')] }
    const steps = [step('a', 0, 4), step('b', 4, 5)]
    const result = analyzeRun(graph, steps, { cap: 4 })
    expect(result.perNode.b.cause).toEqual({ nodeId: 'a', kind: 'data' })
    expect(result.perNode.b.queuedMs).toBe(0)
  })

  it('ignores sub-millisecond gaps as bookkeeping, not queueing', () => {
    const graph = { edges: [edge('t', 'a')] }
    const steps = [
      { node_id: 't', status: 'succeeded', started_at: at(0), finished_at: new Date(T0 + 1000).toISOString() },
      { node_id: 'a', status: 'succeeded', started_at: new Date(T0 + 1002).toISOString(), finished_at: at(2) },
    ]
    expect(analyzeRun(graph, steps, { cap: 4 }).queuedMs).toBe(0)
  })
})

describe('analyzeRun — which steps took a slot', () => {
  it('excludes cached and reused steps from work and from queueing', () => {
    // A resumed run: `a` was adopted from the source run and settled instantly
    // without entering the scheduler's in-flight set.
    const graph = { edges: [edge('a', 'b')] }
    const steps = [step('a', 0, 0, 'reused'), step('b', 0, 2)]
    const result = analyzeRun(graph, steps, { cap: 2 })

    expect(result.workMs).toBe(2000) // b only
    expect(result.perNode.a.occupiedSlot).toBe(false)
    expect(result.perNode.b.occupiedSlot).toBe(true)
  })

  it('still lets a cached step satisfy a downstream node’s readiness', () => {
    const graph = { edges: [edge('a', 'b')] }
    const steps = [step('a', 0, 1, 'cached'), step('b', 1, 2)]
    const result = analyzeRun(graph, steps, { cap: 2 })
    expect(result.perNode.b.readyMs).toBe(1000)
    expect(result.perNode.b.queuedMs).toBe(0)
  })

  it('counts a caught step as work — the node ran and took the slot', () => {
    const graph = { edges: [] }
    const result = analyzeRun(graph, [step('x', 0, 3, 'caught')], { cap: 2 })
    expect(result.workMs).toBe(3000)
    expect(result.perNode.x.occupiedSlot).toBe(true)
  })

  it('counts a failed step as work for the same reason', () => {
    const result = analyzeRun({ edges: [] }, [step('x', 0, 2, 'failed')], { cap: 2 })
    expect(result.workMs).toBe(2000)
  })
})

describe('analyzeRun — utilisation and the chain', () => {
  it('computes utilisation against the cap', () => {
    // 4s of work over a 4s run with 2 slots = 50%.
    const graph = { edges: [edge('t', 'a'), edge('t', 'b')] }
    const steps = [step('t', 0, 0), step('a', 0, 2), step('b', 2, 4)]
    expect(analyzeRun(graph, steps, { cap: 2 }).utilisation).toBeCloseTo(0.5, 3)
  })

  it('reports null utilisation rather than assuming a cap', () => {
    expect(analyzeRun({ edges: [] }, [step('a', 0, 1)]).utilisation).toBeNull()
  })

  it('walks the chain back through both kinds of wait', () => {
    // t → a (data), then b queued behind a (slot), then c after b (data).
    const graph = { edges: [edge('t', 'a'), edge('t', 'b'), edge('b', 'c')] }
    const steps = [step('t', 0, 1), step('a', 1, 4), step('b', 4, 5), step('c', 5, 6)]
    const result = analyzeRun(graph, steps, { cap: 1 })

    expect(result.chain.map((l) => l.nodeId)).toEqual(['t', 'a', 'b', 'c'])
    expect(result.chain.map((l) => l.waitedFor)).toEqual([null, 'data', 'slot', 'data'])
    expect(result.chain[result.chain.length - 1].finishMs).toBe(result.makespanMs)
  })
})

describe('observedDurations', () => {
  it('returns only the nodes that took a slot', () => {
    const graph = { edges: [edge('a', 'b')] }
    const steps = [step('a', 0, 1, 'reused'), step('b', 1, 4)]
    const result = analyzeRun(graph, steps, { cap: 2 })
    expect(observedDurations(result)).toEqual({ b: 3000 })
  })
})
