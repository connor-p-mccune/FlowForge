import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ExecutionPanel from '../components/execution/ExecutionPanel'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))
vi.mock('../hooks/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }),
}))

const nodes = [
  { id: 'gate', type: 'approval', data: { label: 'Release gate', config: {} } },
]

function renderPanel({ steps, pendingApprovals, onRespondApproval = vi.fn() }) {
  render(
    <ExecutionPanel
      open
      onClose={vi.fn()}
      execution={{ id: 'exec-1', status: 'running', error: null }}
      steps={steps}
      nodes={nodes}
      workflowId="wf-1"
      onCancel={vi.fn()}
      pendingApprovals={pendingApprovals}
      onRespondApproval={onRespondApproval}
    />
  )
  return onRespondApproval
}

describe('ExecutionPanel approval controls', () => {
  const runningGate = [{ nodeId: 'gate', status: 'running', output: null, error: null }]
  const pending = { gate: { id: 'appr-1', message: 'Ship v2 to prod?' } }

  it('shows the request message with Approve and Reject on a waiting gate', () => {
    renderPanel({ steps: runningGate, pendingApprovals: pending })
    expect(screen.getByText('Ship v2 to prod?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /reject/i })).toBeInTheDocument()
  })

  it('forwards Approve and Reject clicks with the approval id', () => {
    const onRespond = renderPanel({ steps: runningGate, pendingApprovals: pending })
    fireEvent.click(screen.getByRole('button', { name: /approve/i }))
    expect(onRespond).toHaveBeenCalledWith('appr-1', 'approve')
    fireEvent.click(screen.getByRole('button', { name: /reject/i }))
    expect(onRespond).toHaveBeenCalledWith('appr-1', 'reject')
  })

  it('falls back to a generic message when the request has none', () => {
    renderPanel({
      steps: runningGate,
      pendingApprovals: { gate: { id: 'appr-1', message: null } },
    })
    expect(screen.getByText('Waiting for approval')).toBeInTheDocument()
  })

  it('renders no controls once the gate has settled', () => {
    renderPanel({
      steps: [{ nodeId: 'gate', status: 'succeeded', output: { outcome: 'approved' }, error: null }],
      pendingApprovals: pending,
    })
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument()
  })

  it('renders no controls for steps without a pending approval', () => {
    renderPanel({ steps: runningGate, pendingApprovals: {} })
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument()
  })

  describe('the declared gate', () => {
    it('says nothing about an ordinary approval', () => {
      // "1 approval required" on every gate is a line people learn to skip,
      // and this one has to be read on the day it says four.
      const { container } = render(<div />)
      renderPanel({ steps: runningGate, pendingApprovals: pending })
      expect(container.querySelector('.approval-gate')).toBeNull()
      expect(screen.queryByText(/approvals/)).not.toBeInTheDocument()
    })

    it('shows how far along a quorum is', () => {
      renderPanel({
        steps: runningGate,
        pendingApprovals: { gate: { id: 'appr-1', message: 'Ship?', quorum: 3, approvals: 1 } },
      })
      expect(screen.getByText('1 of 3 approvals')).toBeInTheDocument()
    })

    it('names the rules rather than letting somebody discover them by being refused', () => {
      renderPanel({
        steps: runningGate,
        pendingApprovals: {
          gate: { id: 'appr-1', message: 'Ship?', quorum: 2, requiredRole: 'owner', separationOfDuties: true },
        },
      })
      expect(screen.getByText('0 of 2 approvals')).toBeInTheDocument()
      expect(screen.getByText('workspace owners only · not whoever started the run')).toBeInTheDocument()
    })

    it('shows a rule even when the gate needs only one approval', () => {
      renderPanel({
        steps: runningGate,
        pendingApprovals: { gate: { id: 'appr-1', message: 'Ship?', requiredRole: 'owner' } },
      })
      expect(screen.getByText('workspace owners only')).toBeInTheDocument()
      expect(screen.queryByText(/of 1 approvals/)).not.toBeInTheDocument()
    })
  })
})
