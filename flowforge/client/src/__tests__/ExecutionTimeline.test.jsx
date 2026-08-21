import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import ExecutionTimeline from '../components/execution/ExecutionTimeline'

const nodes = [
  { id: 'a', data: { label: 'Fetch users' } },
  { id: 'b', data: { label: 'Send digest' } },
]

// Two 1s steps overlapping for half their duration inside a 1.5s window —
// the shape a parallel run produces.
const steps = [
  {
    nodeId: 'a',
    status: 'succeeded',
    startedAt: '2026-07-09T10:00:00.000Z',
    finishedAt: '2026-07-09T10:00:01.000Z',
  },
  {
    nodeId: 'b',
    status: 'succeeded',
    startedAt: '2026-07-09T10:00:00.500Z',
    finishedAt: '2026-07-09T10:00:01.500Z',
  },
  { nodeId: 'c', type: 'output-log', status: 'pending', startedAt: null, finishedAt: null },
]

describe('ExecutionTimeline', () => {
  it('positions bars inside the run window and reports total wall time', () => {
    render(<ExecutionTimeline steps={steps} nodes={nodes} />)

    expect(screen.getByText(/total wall time 1\.5s/i)).toBeInTheDocument()

    const barA = screen.getByTitle('Fetch users: succeeded — 1.0s')
    const barB = screen.getByTitle('Send digest: succeeded — 1.0s')
    // Step A starts at the window origin; step B a third of the way in.
    expect(barA.style.left).toBe('0%')
    expect(barB.style.left).toContain('33.33')
    // Both spans cover two-thirds of the window.
    expect(barA.style.width).toContain('66.66')
  })

  it('rows without timing render a dash instead of a bar', () => {
    render(<ExecutionTimeline steps={steps} nodes={nodes} />)
    // The untimed step keeps its row (labelled by node type) but no bar.
    expect(screen.getByText('output-log')).toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('says so when no step has timing data', () => {
    render(<ExecutionTimeline steps={[{ nodeId: 'x', status: 'pending' }]} nodes={[]} />)
    expect(screen.getByText(/no timing data/i)).toBeInTheDocument()
  })

  it('highlights the critical path when one is provided', () => {
    const criticalPath = { path: ['a'], totalMs: 1000, durationsMs: { a: 1000 } }
    const { container } = render(
      <ExecutionTimeline steps={steps} nodes={nodes} criticalPath={criticalPath} />
    )
    // The summary note names the chain and its share of wall time.
    expect(screen.getByText(/Critical path/)).toBeInTheDocument()
    expect(screen.getByText(/1 step/)).toBeInTheDocument()
    // Only the critical step's bar carries the ring modifier and title suffix.
    expect(container.querySelectorAll('.exec-timeline__bar--critical')).toHaveLength(1)
    expect(screen.getByTitle(/Fetch users: succeeded — 1\.0s \(critical path\)/)).toBeInTheDocument()
  })

  it('renders no critical-path note when none is provided', () => {
    render(<ExecutionTimeline steps={steps} nodes={nodes} />)
    expect(screen.queryByText(/Critical path/)).not.toBeInTheDocument()
  })
})

// The engine runs at most EXEC_MAX_PARALLEL nodes at once, so on a wide graph
// the bars arrive in waves and nothing on the canvas explains why — the node
// holding the slot may be on an unrelated branch. The schedule analysis is what
// turns that gap into a segment.
describe('ExecutionTimeline — waiting for a slot', () => {
  const schedule = {
    available: true,
    cap: 1,
    observed: { makespanMs: 1500, workMs: 2000, queuedMs: 500, utilisation: 1, chain: [] },
    idealMakespanMs: 1000,
    perNode: {
      a: { startMs: 0, finishMs: 1000, queuedMs: 0, durationMs: 1000, occupiedSlot: true, cause: null },
      b: {
        startMs: 500, finishMs: 1500, queuedMs: 500, durationMs: 1000,
        occupiedSlot: true, cause: { nodeId: 'a', kind: 'slot' },
      },
    },
  }

  it('draws a queued segment ending where the bar begins', () => {
    const { container } = render(
      <ExecutionTimeline steps={steps} nodes={nodes} schedule={schedule} />
    )
    const queued = container.querySelectorAll('.exec-timeline__queued')
    expect(queued).toHaveLength(1)
    // b's bar starts a third of the way in; the 500ms wait is another third,
    // so the segment runs from the origin up to the bar.
    expect(queued[0].style.left).toBe('0%')
    expect(queued[0].style.width).toContain('33.33')
  })

  it('names the node that was holding the slot', () => {
    render(<ExecutionTimeline steps={steps} nodes={nodes} schedule={schedule} />)
    expect(
      screen.getByTitle(/Send digest: ready, waiting 500ms for a slot held by Fetch users/)
    ).toBeInTheDocument()
  })

  it('summarises the wait and the floor the cap kept the run from', () => {
    render(<ExecutionTimeline steps={steps} nodes={nodes} schedule={schedule} />)
    expect(screen.getByText(/Waiting for a slot/)).toBeInTheDocument()
    expect(screen.getByText(/500ms across the run/)).toBeInTheDocument()
    expect(screen.getByText(/same work takes 1\.0s/)).toBeInTheDocument()
  })

  it('shows the wait alongside the duration', () => {
    render(<ExecutionTimeline steps={steps} nodes={nodes} schedule={schedule} />)
    expect(screen.getByText('+500ms')).toBeInTheDocument()
  })

  it('draws nothing extra for a node that waited on data, not on capacity', () => {
    const dataWait = {
      ...schedule,
      observed: { ...schedule.observed, queuedMs: 0 },
      perNode: {
        ...schedule.perNode,
        b: { ...schedule.perNode.b, queuedMs: 0, cause: { nodeId: 'a', kind: 'data' } },
      },
    }
    const { container } = render(
      <ExecutionTimeline steps={steps} nodes={nodes} schedule={dataWait} />
    )
    expect(container.querySelectorAll('.exec-timeline__queued')).toHaveLength(0)
    expect(screen.queryByText(/Waiting for a slot/)).not.toBeInTheDocument()
  })

  it('renders exactly as before when no analysis is supplied', () => {
    const { container } = render(<ExecutionTimeline steps={steps} nodes={nodes} />)
    expect(container.querySelectorAll('.exec-timeline__queued')).toHaveLength(0)
    expect(screen.getByText(/total wall time 1\.5s/i)).toBeInTheDocument()
  })
})
