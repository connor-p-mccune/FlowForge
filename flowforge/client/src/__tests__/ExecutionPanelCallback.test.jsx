import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ExecutionPanel from '../components/execution/ExecutionPanel'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))
vi.mock('../hooks/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }),
}))

const nodes = [
  { id: 'w1', type: 'wait-callback', data: { label: 'Await payment', config: {} } },
]

function renderPanel({ steps, pendingCallbacks }) {
  render(
    <ExecutionPanel
      open
      onClose={vi.fn()}
      execution={{ id: 'exec-1', status: 'running', error: null }}
      steps={steps}
      nodes={nodes}
      workflowId="wf-1"
      onCancel={vi.fn()}
      pendingCallbacks={pendingCallbacks}
    />
  )
}

describe('ExecutionPanel callback URL', () => {
  const waiting = [{ nodeId: 'w1', status: 'running', output: null, error: null }]
  const pending = { w1: { url: '/api/callbacks/abc123', expiresAt: null } }

  it('shows the full callback URL with a copy button while the gate waits', () => {
    renderPanel({ steps: waiting, pendingCallbacks: pending })
    expect(screen.getByText(/Waiting for POST to/)).toBeInTheDocument()
    expect(screen.getByText(/\/api\/callbacks\/abc123$/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
  })

  it('copies the URL to the clipboard', () => {
    const writeText = vi.fn()
    Object.assign(navigator, { clipboard: { writeText } })
    renderPanel({ steps: waiting, pendingCallbacks: pending })
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/\/api\/callbacks\/abc123$/))
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('shows nothing once the step has settled', () => {
    renderPanel({
      steps: [{ nodeId: 'w1', status: 'succeeded', output: { result: 'received' }, error: null }],
      pendingCallbacks: pending,
    })
    expect(screen.queryByText(/Waiting for POST to/)).toBeNull()
  })
})
