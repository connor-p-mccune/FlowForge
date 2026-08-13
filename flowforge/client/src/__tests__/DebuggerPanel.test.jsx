import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import DebuggerPanel from '../components/canvas/DebuggerPanel'
import { apiFetch } from '../services/api'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

const NODES = [
  { id: 't1', type: 'trigger-manual', position: { x: 0, y: 0 }, data: { label: 'Start' } },
  { id: 'h1', type: 'action-http', position: { x: 0, y: 0 }, data: { label: 'Charge card' } },
  { id: 'n1', type: 'note', position: { x: 0, y: 0 }, data: { label: 'TODO' } },
]

const PAUSED = {
  breakId: 'brk-1',
  nodeId: 'h1',
  nodeLabel: 'Charge card',
  input: { orderId: 'ord-42' },
  config: { url: 'https://api.example.com/ord-42', method: 'POST' },
}

const renderPanel = (props = {}) =>
  render(
    <DebuggerPanel
      nodes={NODES}
      executionId="exec-1"
      activeBreak={null}
      onClose={() => {}}
      onSelectNode={() => {}}
      onStartDebugRun={() => {}}
      onResumed={() => {}}
      {...props}
    />
  )

beforeEach(() => {
  apiFetch.mockReset()
})

describe('arming breakpoints', () => {
  it('does not offer a node that never executes', () => {
    renderPanel()
    expect(screen.getByText('Charge card')).toBeInTheDocument()
    expect(screen.queryByText('TODO')).not.toBeInTheDocument()
  })

  it('will not start a run with nothing selected', () => {
    renderPanel()
    expect(screen.getByRole('button', { name: /Run with breakpoints/ })).toBeDisabled()
  })

  it('starts the run with the chosen breakpoints', () => {
    const onStartDebugRun = vi.fn()
    renderPanel({ onStartDebugRun })

    fireEvent.click(screen.getByLabelText(/Charge card/))
    fireEvent.click(screen.getByRole('button', { name: /Run with breakpoints/ }))

    expect(onStartDebugRun).toHaveBeenCalledWith({ breakpoints: ['h1'], stepFromStart: false })
  })

  it('offers stopping at every node without picking any', () => {
    const onStartDebugRun = vi.fn()
    renderPanel({ onStartDebugRun })

    fireEvent.click(screen.getByLabelText('Stop at every node'))
    fireEvent.click(screen.getByRole('button', { name: /Run with breakpoints/ }))

    expect(onStartDebugRun).toHaveBeenCalledWith({ breakpoints: [], stepFromStart: true })
  })

  it('says where a breakpoint lives, because that is the safety story', () => {
    renderPanel()
    expect(screen.getByText(/schedule or a webhook can never hit it/)).toBeInTheDocument()
  })
})

describe('a paused run', () => {
  it('shows the resolved input and config, not the template', () => {
    // The template is already readable on the canvas; what is worth stopping
    // for is the value it produced, which exists nowhere else.
    renderPanel({ activeBreak: PAUSED })
    expect(screen.getByText('paused')).toBeInTheDocument()
    expect(screen.getByText(/"orderId": "ord-42"/)).toBeInTheDocument()
    expect(screen.getByText(/"url": "https:\/\/api\.example\.com\/ord-42"/)).toBeInTheDocument()
  })

  it('continues the run', async () => {
    apiFetch.mockResolvedValue({ ok: true })
    const onResumed = vi.fn()
    renderPanel({ activeBreak: PAUSED, onResumed })

    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/executions/exec-1/breaks/brk-1/resume', {
        method: 'POST',
        body: { action: 'continue' },
      })
    )
    await waitFor(() => expect(onResumed).toHaveBeenCalled())
  })

  it('steps and aborts through the same endpoint', async () => {
    apiFetch.mockResolvedValue({ ok: true })
    renderPanel({ activeBreak: PAUSED })

    fireEvent.click(screen.getByRole('button', { name: /Step/ }))
    await waitFor(() =>
      expect(apiFetch).toHaveBeenLastCalledWith(expect.any(String), {
        method: 'POST',
        body: { action: 'step' },
      })
    )

    fireEvent.click(screen.getByRole('button', { name: /Abort/ }))
    await waitFor(() =>
      expect(apiFetch).toHaveBeenLastCalledWith(expect.any(String), {
        method: 'POST',
        body: { action: 'abort' },
      })
    )
  })

  it('sends an override with the resume', async () => {
    apiFetch.mockResolvedValue({ ok: true })
    renderPanel({ activeBreak: PAUSED })

    fireEvent.change(screen.getByLabelText(/Config patch/), {
      target: { value: '{"url":"https://staging.example.com"}' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(expect.any(String), {
        method: 'POST',
        body: { action: 'continue', override: { config: { url: 'https://staging.example.com' } } },
      })
    )
  })

  it('refuses to resume on malformed JSON instead of silently ignoring it', async () => {
    // An override that failed to parse server-side would resume with the
    // *original* value and look like the change did nothing.
    renderPanel({ activeBreak: PAUSED })

    fireEvent.change(screen.getByLabelText(/Input patch/), { target: { value: '{oops' } })
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))

    expect(await screen.findByText(/input override/)).toBeInTheDocument()
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('rejects a JSON array, which is not a patch', async () => {
    renderPanel({ activeBreak: PAUSED })
    fireEvent.change(screen.getByLabelText(/Config patch/), { target: { value: '[1,2]' } })
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))

    expect(await screen.findByText(/must be a JSON object/)).toBeInTheDocument()
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('surfaces a failed resume rather than pretending it worked', async () => {
    apiFetch.mockRejectedValue(new Error('This break was already resumed'))
    const onResumed = vi.fn()
    renderPanel({ activeBreak: PAUSED, onResumed })

    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    expect(await screen.findByText('This break was already resumed')).toBeInTheDocument()
    expect(onResumed).not.toHaveBeenCalled()
  })

  it('clears the override editors when the run stops somewhere new', () => {
    const { rerender } = renderPanel({ activeBreak: PAUSED })
    fireEvent.change(screen.getByLabelText(/Config patch/), { target: { value: '{"a":1}' } })

    rerender(
      <DebuggerPanel
        nodes={NODES}
        executionId="exec-1"
        activeBreak={{ ...PAUSED, breakId: 'brk-2', nodeId: 't1', nodeLabel: 'Start' }}
        onClose={() => {}}
        onSelectNode={() => {}}
        onStartDebugRun={() => {}}
        onResumed={() => {}}
      />
    )
    expect(screen.getByLabelText(/Config patch/)).toHaveValue('')
  })

  it('jumps to the paused node on the canvas', () => {
    const onSelectNode = vi.fn()
    renderPanel({ activeBreak: PAUSED, onSelectNode })
    fireEvent.click(screen.getByRole('button', { name: 'Charge card' }))
    expect(onSelectNode).toHaveBeenCalledWith('h1')
  })
})
