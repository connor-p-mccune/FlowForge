import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import ApprovalsInbox from '../components/dashboard/ApprovalsInbox'
import { apiFetch } from '../services/api'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

const toast = { success: vi.fn(), error: vi.fn() }
vi.mock('../hooks/useToast', () => ({ useToast: () => toast }))

const PENDING = [
  {
    id: 'appr-1',
    execution_id: 'exec-1',
    workflow_id: 'wf-1',
    workflow_name: 'Production deploy',
    status: 'pending',
    message: 'Deploy v2.3.1 to production?',
    requested_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  },
  {
    id: 'appr-2',
    execution_id: 'exec-2',
    workflow_id: 'wf-2',
    workflow_name: 'Invoice batch',
    status: 'pending',
    message: null,
    requested_at: new Date().toISOString(),
  },
]

function renderInbox() {
  return render(
    <MemoryRouter>
      <ApprovalsInbox />
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ApprovalsInbox', () => {
  it('lists pending approvals with workflow, message, and count', async () => {
    apiFetch.mockResolvedValueOnce({ approvals: PENDING })
    renderInbox()

    await screen.findByText('Production deploy')
    expect(apiFetch).toHaveBeenCalledWith('/api/approvals?status=pending')
    expect(screen.getByText('Deploy v2.3.1 to production?')).toBeInTheDocument()
    expect(screen.getByText('Invoice batch')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument() // the count pill
    expect(screen.getByText('5m ago')).toBeInTheDocument()
  })

  it('renders nothing when the inbox is empty', async () => {
    apiFetch.mockResolvedValueOnce({ approvals: [] })
    const { container } = renderInbox()
    await waitFor(() => expect(apiFetch).toHaveBeenCalled())
    expect(container.querySelector('.approvals-inbox')).toBeNull()
  })

  it('renders nothing (not an error) when the fetch fails', async () => {
    apiFetch.mockRejectedValueOnce(new Error('boom'))
    const { container } = renderInbox()
    await waitFor(() => expect(apiFetch).toHaveBeenCalled())
    expect(container.querySelector('.approvals-inbox')).toBeNull()
  })

  it('approves inline and removes the row', async () => {
    apiFetch.mockResolvedValueOnce({ approvals: PENDING })
    renderInbox()
    await screen.findByText('Production deploy')

    apiFetch.mockResolvedValueOnce({ approval: { id: 'appr-1', status: 'approved' } })
    fireEvent.click(screen.getAllByRole('button', { name: /approve/i })[0])

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/approvals/appr-1/respond', {
        method: 'POST',
        body: { decision: 'approve' },
      })
    )
    await waitFor(() => expect(screen.queryByText('Production deploy')).not.toBeInTheDocument())
    expect(screen.getByText('Invoice batch')).toBeInTheDocument()
    expect(toast.success).toHaveBeenCalled()
  })

  it('drops the row even when someone else decided first', async () => {
    apiFetch.mockResolvedValueOnce({ approvals: PENDING })
    renderInbox()
    await screen.findByText('Production deploy')

    apiFetch.mockRejectedValueOnce(new Error('Approval already approved'))
    fireEvent.click(screen.getAllByRole('button', { name: /reject/i })[0])

    await waitFor(() => expect(screen.queryByText('Production deploy')).not.toBeInTheDocument())
    expect(toast.error).toHaveBeenCalled()
  })
})
