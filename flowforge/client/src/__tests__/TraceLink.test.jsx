import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../services/api', () => ({ apiFetch: vi.fn(), apiFetchText: vi.fn() }))

import TraceLink from '../components/execution/TraceLink'
import { ToastProvider } from '../hooks/useToast'
import { apiFetchText } from '../services/api'

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736'

const setup = (props = {}) =>
  render(
    <ToastProvider>
      <TraceLink executionId="ex-1" traceId={TRACE_ID} {...props} />
    </ToastProvider>
  )

describe('TraceLink', () => {
  beforeEach(() => {
    apiFetchText.mockReset()
  })

  it('renders nothing for a run that carries no trace', () => {
    // Runs recorded before tracing existed should show nothing rather than an
    // id that means nothing.
    const { container } = setup({ traceId: null })
    expect(container).toBeEmptyDOMElement()
  })

  it('shows a truncated id with the full value available on hover', () => {
    setup()
    const code = screen.getByText(/4bf92f3577b34da6/)
    expect(code).toHaveAttribute('title', TRACE_ID)
  })

  it('copies the full trace id, not the truncated display', async () => {
    // The truncated form is for reading; pasting it into a tracing backend
    // would find nothing.
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'Copy ID' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(TRACE_ID))
  })

  it('nudges rather than failing when the clipboard is refused', async () => {
    // Clipboard access is permission-gated; the id is on screen either way.
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'Copy ID' }))
    expect(await screen.findByText(/select the ID above instead/)).toBeInTheDocument()
  })

  it('downloads the OTLP document for the run', async () => {
    apiFetchText.mockResolvedValue('{"resourceSpans":[]}')
    const createObjectURL = vi.fn().mockReturnValue('blob:trace')
    const revokeObjectURL = vi.fn()
    Object.assign(URL, { createObjectURL, revokeObjectURL })

    setup()
    fireEvent.click(screen.getByRole('button', { name: 'OTLP' }))

    await waitFor(() =>
      expect(apiFetchText).toHaveBeenCalledWith('/api/executions/ex-1/trace')
    )
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalled())
  })

  it('surfaces an export failure instead of silently doing nothing', async () => {
    apiFetchText.mockRejectedValue(new Error('Execution not found'))
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'OTLP' }))
    expect(await screen.findByText(/Execution not found/)).toBeInTheDocument()
  })
})
