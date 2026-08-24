import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import ConvergencePanel from '../components/canvas/ConvergencePanel'
import { apiFetch } from '../services/api'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

const NODES = [
  { id: 'hook', type: 'trigger-webhook', position: { x: 0, y: 0 }, data: { label: 'Order webhook' } },
  { id: 'crm', type: 'action-http', position: { x: 0, y: 0 }, data: { label: 'CRM lookup' } },
  { id: 'billing', type: 'action-http', position: { x: 0, y: 0 }, data: { label: 'Billing lookup' } },
  { id: 'merge', type: 'output-log', position: { x: 0, y: 0 }, data: { label: 'Combine' } },
]
const EDGES = [
  { id: 'e1', source: 'hook', target: 'crm' },
  { id: 'e2', source: 'hook', target: 'billing' },
  { id: 'e3', source: 'crm', target: 'merge' },
  { id: 'e4', source: 'billing', target: 'merge' },
]

const contributor = (nodeId, label, depth, type = 'number') => ({
  nodeId, label, handle: null, depth, type,
})

const REPORT = {
  workflowId: 'wf1',
  available: true,
  joins: [
    {
      nodeId: 'merge', label: 'Combine', type: 'output-log', arity: 2,
      mergeOrder: ['billing', 'crm'],
      collisions: [
        {
          key: 'status',
          contributors: [
            contributor('billing', 'Billing lookup', 1),
            contributor('crm', 'CRM lookup', 1),
          ],
          resolution: 'tie-break',
          decidedBy: 'crm',
          sameType: true,
        },
        {
          key: 'total',
          contributors: [
            contributor('billing', 'Subtotal', 1),
            contributor('crm', 'With tax', 2),
          ],
          resolution: 'dataflow',
          decidedBy: 'crm',
          sameType: true,
        },
      ],
    },
  ],
  summary: { joins: 1, collisions: 2, tieBroken: 1, dataflow: 1, typeChanging: 0 },
}

const panel = (props = {}) =>
  render(
    <ConvergencePanel
      workflowId="wf1"
      nodes={NODES}
      edges={EDGES}
      onClose={() => {}}
      onSelectNode={() => {}}
      {...props}
    />
  )

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ConvergencePanel', () => {
  it('lists each collision with the field and the node it happens at', async () => {
    apiFetch.mockResolvedValue(REPORT)
    panel()
    expect(await screen.findByText('status')).toBeInTheDocument()
    expect(screen.getAllByText(/at Combine/)).toHaveLength(2)
  })

  it('distinguishes a tie nothing decides from one the graph settles', async () => {
    // The whole product in two words. One of these needs a human; the other is
    // predictable from the canvas and needs nobody.
    apiFetch.mockResolvedValue(REPORT)
    panel()
    expect(await screen.findByText('alphabetical')).toBeInTheDocument()
    expect(screen.getByText('ran later')).toBeInTheDocument()
  })

  it('counts the two kinds separately in the header', async () => {
    apiFetch.mockResolvedValue(REPORT)
    panel()
    expect(await screen.findByText('1 tie-break')).toBeInTheDocument()
    expect(screen.getByText('1 settled')).toBeInTheDocument()
  })

  it('marks the contributor whose value survives', async () => {
    apiFetch.mockResolvedValue(REPORT)
    const { container } = panel()
    await screen.findByText('status')
    const wins = container.querySelectorAll('.convergence-src--wins')
    // One per collision, and never the losing side.
    expect([...wins].map((el) => el.textContent)).toEqual(['CRM lookup', 'With tax'])
  })

  it('selects the join node when a collision is clicked', async () => {
    apiFetch.mockResolvedValue(REPORT)
    const onSelectNode = vi.fn()
    panel({ onSelectNode })
    fireEvent.click((await screen.findByText('status')).closest('button'))
    expect(onSelectNode).toHaveBeenCalledWith('merge')
  })

  it('asks about the graph on screen, not the one that was saved', async () => {
    apiFetch.mockResolvedValue(REPORT)
    panel()
    await screen.findByText('status')
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/workflows/wf1/convergence',
      expect.objectContaining({ method: 'POST' })
    )
    expect(apiFetch.mock.calls[0][1].body.edges).toHaveLength(4)
  })

  it('hands the report up so the canvas can draw it', async () => {
    apiFetch.mockResolvedValue(REPORT)
    const onReport = vi.fn()
    panel({ onReport })
    await waitFor(() => expect(onReport).toHaveBeenCalledWith(REPORT))
  })

  it('clears the decoration when it closes, putting the canvas back', async () => {
    apiFetch.mockResolvedValue(REPORT)
    const onReport = vi.fn()
    const { unmount } = panel({ onReport })
    await waitFor(() => expect(onReport).toHaveBeenCalledWith(REPORT))
    unmount()
    expect(onReport).toHaveBeenLastCalledWith(null)
  })

  it('says so plainly when nothing collides', async () => {
    apiFetch.mockResolvedValue({
      workflowId: 'wf1', available: true, joins: [],
      summary: { joins: 0, collisions: 0, tieBroken: 0, dataflow: 0, typeChanging: 0 },
    })
    panel()
    expect(
      await screen.findByText(/No converging branch supplies a field another one also supplies/)
    ).toBeInTheDocument()
  })

  it('explains a cyclic graph rather than showing an empty list', async () => {
    apiFetch.mockResolvedValue({ workflowId: 'wf1', available: false, reason: 'cycle' })
    panel()
    expect(await screen.findByText(/no run of it happens at all/)).toBeInTheDocument()
  })

  it('warns when the winner changes what downstream can do', async () => {
    apiFetch.mockResolvedValue({
      ...REPORT,
      joins: [
        {
          ...REPORT.joins[0],
          collisions: [
            {
              ...REPORT.joins[0].collisions[0],
              sameType: false,
              contributors: [
                contributor('billing', 'Billing lookup', 1, 'string'),
                contributor('crm', 'CRM lookup', 1, 'number'),
              ],
            },
          ],
        },
      ],
    })
    panel()
    expect(await screen.findByText(/Differently shaped/)).toBeInTheDocument()
    expect(screen.getByText('string')).toBeInTheDocument()
  })

  it('says plainly when a winner cannot be named', async () => {
    apiFetch.mockResolvedValue({
      ...REPORT,
      joins: [
        {
          ...REPORT.joins[0],
          collisions: [{ ...REPORT.joins[0].collisions[0], decidedBy: null }],
        },
      ],
    })
    panel()
    expect(
      await screen.findByText(/Which one survives depends on the branch that ran/)
    ).toBeInTheDocument()
  })

  it('shows the error rather than an empty panel when the analysis fails', async () => {
    apiFetch.mockRejectedValue(new Error('Workflow not found'))
    panel()
    expect(await screen.findByText('Workflow not found')).toBeInTheDocument()
  })
})
