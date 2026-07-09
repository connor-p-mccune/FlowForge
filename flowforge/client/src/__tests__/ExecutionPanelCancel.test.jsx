import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ExecutionPanel from '../components/execution/ExecutionPanel'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))
vi.mock('../hooks/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }),
}))

function renderPanel({ status, onCancel = vi.fn() }) {
  render(
    <ExecutionPanel
      open
      onClose={vi.fn()}
      execution={{ id: 'exec-1', status, error: null }}
      steps={[]}
      nodes={[]}
      workflowId="wf-1"
      onCancel={onCancel}
    />
  )
  return onCancel
}

describe('ExecutionPanel stop button', () => {
  it('shows Stop while the run is in flight and forwards the click', () => {
    const onCancel = renderPanel({ status: 'running' })
    const stop = screen.getByRole('button', { name: /stop/i })
    fireEvent.click(stop)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('shows Stop for a queued (pending) run', () => {
    renderPanel({ status: 'pending' })
    expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument()
  })

  it.each(['completed', 'failed', 'cancelled'])('hides Stop once the run is %s', (status) => {
    renderPanel({ status })
    expect(screen.queryByRole('button', { name: /stop/i })).not.toBeInTheDocument()
  })

  it('renders the cancelled status badge', () => {
    renderPanel({ status: 'cancelled' })
    expect(screen.getByText('cancelled')).toHaveClass('status-badge--cancelled')
  })
})
