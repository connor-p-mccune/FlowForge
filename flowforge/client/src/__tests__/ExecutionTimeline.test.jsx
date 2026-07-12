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
