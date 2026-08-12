import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import GuaranteesPanel from '../components/canvas/GuaranteesPanel'
import { apiFetch } from '../services/api'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

const NODES = [
  { id: 'hook', type: 'trigger-webhook', position: { x: 0, y: 0 }, data: { label: 'Order webhook' } },
  { id: 'approve', type: 'approval', position: { x: 0, y: 0 }, data: { label: 'Approve' } },
  { id: 'charge', type: 'action-http', position: { x: 0, y: 0 }, data: { label: 'Charge card' } },
  { id: 'n1', type: 'note', position: { x: 0, y: 0 }, data: { label: 'TODO' } },
]
const EDGES = [
  { id: 'e1', source: 'hook', target: 'approve' },
  { id: 'e2', source: 'approve', target: 'charge', sourceHandle: 'true' },
]

const HOLDS = {
  ok: true,
  analysed: true,
  results: [
    {
      kind: 'requires',
      node: 'charge',
      other: 'approve',
      statement: 'Charge card never runs unless Approve ran first',
      status: 'holds',
    },
  ],
  facts: {
    alwaysRuns: [{ nodeId: 'hook', label: 'Order webhook' }],
    decisions: [{ nodeId: 'approve', label: 'Approve', outcomes: ['true', 'false'] }],
  },
  suggestions: [],
}

const VIOLATED = {
  ok: false,
  analysed: true,
  results: [
    {
      kind: 'requires',
      node: 'charge',
      other: 'approve',
      statement: 'Charge card never runs unless Approve ran first',
      status: 'violated',
      message: 'Run by hand → Charge card reaches Charge card without Approve',
      counterexample: ['hook', 'charge'],
    },
  ],
  facts: { alwaysRuns: [], decisions: [] },
  suggestions: [],
}

const NOTHING_DECLARED = {
  ok: true,
  analysed: true,
  results: [],
  facts: { alwaysRuns: [], decisions: [] },
  suggestions: [
    {
      kind: 'requires',
      node: 'charge',
      other: 'approve',
      statement: 'Charge card never runs unless Approve ran first',
    },
  ],
}

const renderPanel = (props = {}) =>
  render(
    <GuaranteesPanel
      workflowId="wf-1"
      nodes={NODES}
      edges={EDGES}
      onClose={() => {}}
      onSelectNode={() => {}}
      {...props}
    />
  )

beforeEach(() => {
  apiFetch.mockReset()
})

describe('GuaranteesPanel', () => {
  it('verifies the canvas on screen and shows each verdict', async () => {
    apiFetch.mockResolvedValue(HOLDS)
    renderPanel()

    expect(
      await screen.findByText('Charge card never runs unless Approve ran first')
    ).toBeInTheDocument()
    expect(screen.getByText('all hold')).toBeInTheDocument()
    // The graph is posted, not read from the server's saved copy.
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/workflows/wf-1/guarantees',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('shows a violation with its counterexample as clickable nodes', async () => {
    apiFetch.mockResolvedValue(VIOLATED)
    const onSelectNode = vi.fn()
    renderPanel({ onSelectNode })

    expect(await screen.findByText(/reaches Charge card without Approve/)).toBeInTheDocument()
    expect(screen.getByText('1 broken')).toBeInTheDocument()

    // The counterexample names the nodes, and clicking one goes there.
    fireEvent.click(screen.getByRole('button', { name: 'Order webhook' }))
    expect(onSelectNode).toHaveBeenCalledWith('hook')
  })

  it('carries the verdict in words, not colour alone', async () => {
    apiFetch.mockResolvedValue(VIOLATED)
    renderPanel()
    expect(await screen.findByText('Violated')).toBeInTheDocument()
  })

  it('offers to pin an invariant that already holds', async () => {
    apiFetch.mockResolvedValue(NOTHING_DECLARED)
    renderPanel()

    expect(await screen.findByText('True today — pin it?')).toBeInTheDocument()
    apiFetch.mockResolvedValue(HOLDS)
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }))

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/workflows/wf-1/guarantees', {
        method: 'PUT',
        body: { guarantees: [{ kind: 'requires', node: 'charge', other: 'approve' }] },
      })
    )
  })

  it('removes a guarantee by saving the list without it', async () => {
    apiFetch.mockResolvedValue(HOLDS)
    renderPanel()
    await screen.findByText('Charge card never runs unless Approve ran first')

    fireEvent.click(screen.getByRole('button', { name: /^Remove guarantee/ }))
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/workflows/wf-1/guarantees', {
        method: 'PUT',
        body: { guarantees: [] },
      })
    )
  })

  it('writes one by hand, and never offers a note as a subject', async () => {
    apiFetch.mockResolvedValue(NOTHING_DECLARED)
    renderPanel()
    await screen.findByText(/Nothing declared yet/)

    fireEvent.click(screen.getByRole('button', { name: '+ Write a guarantee' }))
    const subject = screen.getByLabelText('Subject node')
    // Sticky notes never execute, so an invariant about one could not be
    // broken or upheld — they are not choices.
    expect([...subject.options].map((o) => o.value)).toEqual(['hook', 'approve', 'charge'])

    fireEvent.change(subject, { target: { value: 'charge' } })
    fireEvent.change(screen.getByLabelText('Related node'), { target: { value: 'approve' } })
    apiFetch.mockResolvedValue(HOLDS)
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/workflows/wf-1/guarantees', {
        method: 'PUT',
        body: { guarantees: [{ kind: 'requires', node: 'charge', other: 'approve' }] },
      })
    )
  })

  it('refuses a guarantee about a node and itself', async () => {
    apiFetch.mockResolvedValue(NOTHING_DECLARED)
    renderPanel()
    await screen.findByText(/Nothing declared yet/)

    fireEvent.click(screen.getByRole('button', { name: '+ Write a guarantee' }))
    fireEvent.change(screen.getByLabelText('Subject node'), { target: { value: 'charge' } })
    fireEvent.change(screen.getByLabelText('Related node'), { target: { value: 'charge' } })
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()
  })

  it('reports which nodes every run executes', async () => {
    apiFetch.mockResolvedValue(HOLDS)
    renderPanel()
    expect(await screen.findByText('Always runs')).toBeInTheDocument()
    expect(screen.getByText('Order webhook')).toBeInTheDocument()
  })

  it('says a cyclic graph admits no execution to verify against', async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      analysed: false,
      reason: 'cycle',
      results: [],
      facts: null,
      suggestions: [],
    })
    renderPanel()
    expect(await screen.findByText(/contains a cycle/)).toBeInTheDocument()
  })

  it('surfaces a failed request instead of rendering an empty panel', async () => {
    apiFetch.mockRejectedValue(new Error('Network down'))
    renderPanel()
    expect(await screen.findByText('Network down')).toBeInTheDocument()
  })
})
