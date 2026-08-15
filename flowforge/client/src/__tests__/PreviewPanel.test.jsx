import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import PreviewPanel from '../components/canvas/PreviewPanel'
import { apiFetch } from '../services/api'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

const NODES = [
  { id: 'hook', type: 'trigger-webhook', position: { x: 0, y: 0 }, data: { label: 'Order webhook' } },
  { id: 'big', type: 'condition', position: { x: 0, y: 0 }, data: { label: 'Large order?' } },
  { id: 'vip', type: 'output-log', position: { x: 0, y: 0 }, data: { label: 'Priority shipping' } },
  { id: 'normal', type: 'output-log', position: { x: 0, y: 0 }, data: { label: 'Standard shipping' } },
]
const EDGES = [{ id: 'e1', source: 'hook', target: 'big' }]

const CHANGED = {
  analysed: true,
  truncated: false,
  runs: 20,
  identical: 19,
  changed: [
    {
      executionId: 'exec-1',
      at: '2026-01-12T09:00:00.000Z',
      before: { status: 'completed', path: ['hook', 'big', 'vip'] },
      after: { status: 'failed', path: ['hook', 'big', 'normal'] },
      difference: {
        identical: false,
        statusChanged: true,
        started: ['normal'],
        stopped: ['vip'],
        routed: [{ nodeId: 'big', before: true, after: false }],
      },
    },
  ],
  summary: { changed: 1, statusChanges: 1, routingChanges: 1, nodesStarted: ['normal'], nodesStopped: ['vip'], errors: 0 },
}

const IDENTICAL = { ...CHANGED, identical: 20, changed: [], summary: { ...CHANGED.summary, changed: 0 } }

function setup(props = {}) {
  return render(
    <PreviewPanel
      workflowId="wf-1"
      nodes={NODES}
      edges={EDGES}
      onClose={() => {}}
      onSelectNode={() => {}}
      {...props}
    />
  )
}

beforeEach(() => {
  apiFetch.mockReset()
})

describe('PreviewPanel', () => {
  it('does not replay anything until asked', async () => {
    setup()
    // Unlike the other analysis panels, this one executes graphs — so opening
    // it must cost nothing.
    expect(apiFetch).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /Replay recent runs/i })).toBeInTheDocument()
  })

  it('replays the canvas on screen and names what each run would do differently', async () => {
    apiFetch.mockResolvedValue(CHANGED)
    setup()
    fireEvent.click(screen.getByRole('button', { name: /Replay recent runs/i }))

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/workflows/wf-1/preview',
        expect.objectContaining({ method: 'POST' })
      )
    )
    expect(apiFetch.mock.calls[0][1].body.nodes).toHaveLength(4)

    expect(
      await screen.findByText('1 of 20 replayed runs would behave differently.')
    ).toBeInTheDocument()
    expect(screen.getByText(/status/)).toBeInTheDocument()
    // Nodes are resolved to their labels, and the routing one is clickable.
    expect(screen.getByRole('button', { name: 'Large order?' })).toBeInTheDocument()
    expect(screen.getByText(/now runs Standard shipping/)).toBeInTheDocument()
    expect(screen.getByText(/no longer runs Priority shipping/)).toBeInTheDocument()
    expect(screen.getByText('1 differ')).toBeInTheDocument()
  })

  it('says plainly when a change is behaviourally inert', async () => {
    apiFetch.mockResolvedValue(IDENTICAL)
    setup()
    fireEvent.click(screen.getByRole('button', { name: /Replay recent runs/i }))
    expect(await screen.findByText('All 20 replayed runs behave identically.')).toBeInTheDocument()
    expect(screen.getByText('no change')).toBeInTheDocument()
  })

  it('jumps to the node whose routing changed', async () => {
    const onSelectNode = vi.fn()
    apiFetch.mockResolvedValue(CHANGED)
    setup({ onSelectNode })
    fireEvent.click(screen.getByRole('button', { name: /Replay recent runs/i }))
    fireEvent.click(await screen.findByRole('button', { name: 'Large order?' }))
    expect(onSelectNode).toHaveBeenCalledWith('big')
  })

  it('reports a workflow with nothing to compare against', async () => {
    apiFetch.mockResolvedValue({ analysed: false, reason: 'no-runs', runs: 0, changed: [] })
    setup()
    fireEvent.click(screen.getByRole('button', { name: /Replay recent runs/i }))
    expect(await screen.findByText(/no run history yet/i)).toBeInTheDocument()
  })

  it('says so when the preview did not finish, rather than reading as clean', async () => {
    apiFetch.mockResolvedValue({ ...IDENTICAL, truncated: true })
    setup()
    fireEvent.click(screen.getByRole('button', { name: /Replay recent runs/i }))
    expect(await screen.findByText(/ran out of time/i)).toBeInTheDocument()
  })

  it('surfaces a replay that could not be compared', async () => {
    apiFetch.mockResolvedValue({
      ...CHANGED,
      changed: [{ executionId: 'exec-2', at: '2026-01-12T09:00:00.000Z', error: 'timed out', difference: null }],
    })
    setup()
    fireEvent.click(screen.getByRole('button', { name: /Replay recent runs/i }))
    expect(await screen.findByText('timed out')).toBeInTheDocument()
  })

  it('surfaces an error instead of an empty panel', async () => {
    apiFetch.mockRejectedValue(new Error('nope'))
    setup()
    fireEvent.click(screen.getByRole('button', { name: /Replay recent runs/i }))
    expect(await screen.findByText('nope')).toBeInTheDocument()
  })
})
