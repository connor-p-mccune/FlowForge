import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import RollbackSection from '../components/execution/RollbackSection'
import { apiFetch } from '../services/api'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))
const toast = { success: vi.fn(), error: vi.fn() }
vi.mock('../hooks/useToast', () => ({ useToast: () => toast }))

const NODES = [
  { id: 'charge', data: { label: 'Charge card' } },
  { id: 'reserve', data: { label: 'Reserve stock' } },
  { id: 'refund', data: { label: 'Refund charge' } },
  { id: 'release', data: { label: 'Release stock' } },
]

const clean = [
  { node_id: 'refund', target_node_id: 'charge', seq: 0, status: 'succeeded', attempts: 1, error: null },
  { node_id: 'release', target_node_id: 'reserve', seq: 1, status: 'succeeded', attempts: 1, error: null },
]

const partial = [
  { node_id: 'refund', target_node_id: 'charge', seq: 0, status: 'failed', attempts: 3, error: 'ECONNREFUSED' },
  { node_id: 'release', target_node_id: 'reserve', seq: 1, status: 'succeeded', attempts: 1, error: null },
]

const run = (rollback_status) => ({ id: 'ex1', status: 'failed', rollback_status })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('RollbackSection', () => {
  it('renders nothing for a run that was never unwound', () => {
    const { container } = render(
      <RollbackSection execution={run(null)} compensations={[]} nodes={NODES} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('names what undid what, in unwind order', () => {
    render(<RollbackSection execution={run('completed')} compensations={clean} nodes={NODES} />)
    expect(screen.getByText(/Rolled back/)).toBeInTheDocument()
    expect(screen.getByText('Refund charge')).toBeInTheDocument()
    expect(screen.getByText('Charge card')).toBeInTheDocument()
    // The charge is refunded before the reservation is released.
    const rows = screen.getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('Refund charge')
    expect(rows[1]).toHaveTextContent('Release stock')
  })

  it('offers no retry when everything took', () => {
    render(<RollbackSection execution={run('completed')} compensations={clean} nodes={NODES} />)
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument()
  })

  it('calls a partial rollback out loud and shows the error', () => {
    render(<RollbackSection execution={run('partial')} compensations={partial} nodes={NODES} />)
    expect(screen.getByText(/Rollback partial/)).toBeInTheDocument()
    expect(screen.getByText(/1 of 2 compensations still failing/)).toBeInTheDocument()
    expect(screen.getByText('ECONNREFUSED')).toBeInTheDocument()
    // Retries are visible: "the refund went through on the third try" matters
    // when reconciling.
    expect(screen.getByText('3×')).toBeInTheDocument()
  })

  it('confirms before re-running compensations, then reports the outcome', async () => {
    apiFetch.mockResolvedValue({ outcome: 'completed', compensations: [] })
    const onRolledBack = vi.fn()
    render(
      <RollbackSection
        execution={run('partial')}
        compensations={partial}
        nodes={NODES}
        onRolledBack={onRolledBack}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /retry the rollback/i }))
    // Nothing has fired yet — the confirm step exists because these are real,
    // irreversible effects.
    expect(apiFetch).not.toHaveBeenCalled()
    expect(screen.getByText(/already succeeded are skipped/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /run them/i }))
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/executions/ex1/rollback', { method: 'POST' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(onRolledBack).toHaveBeenCalled()
  })

  it('reports a retry that is still partial as an error', async () => {
    apiFetch.mockResolvedValue({ outcome: 'partial', compensations: [] })
    render(<RollbackSection execution={run('partial')} compensations={partial} nodes={NODES} />)
    fireEvent.click(screen.getByRole('button', { name: /retry the rollback/i }))
    fireEvent.click(screen.getByRole('button', { name: /run them/i }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
  })
})
