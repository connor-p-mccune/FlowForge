import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import FlowTextPanel from '../components/canvas/FlowTextPanel'
import { apiFetch, apiFetchText } from '../services/api'

vi.mock('../services/api', () => ({ apiFetch: vi.fn(), apiFetchText: vi.fn() }))

const FLOW = `workflow "Order pipeline"

node hook: trigger-webhook @ 100,200
  label: "Order webhook"
`

beforeEach(() => {
  vi.clearAllMocks()
  apiFetchText.mockResolvedValue(FLOW)
  apiFetch.mockResolvedValue({ workflow: { id: 'wf1', name: 'Order pipeline' } })
})

function setup(props = {}) {
  return render(
    <FlowTextPanel workflowId="wf1" open onClose={vi.fn()} onApplied={vi.fn()} {...props} />
  )
}

const editor = () => screen.getByLabelText('Workflow source')

describe('FlowTextPanel', () => {
  it('renders nothing while closed and asks for nothing', () => {
    const { container } = render(<FlowTextPanel workflowId="wf1" open={false} onClose={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
    expect(apiFetchText).not.toHaveBeenCalled()
  })

  it('loads the workflow as text', async () => {
    setup()
    await waitFor(() => expect(editor()).toHaveValue(FLOW))
    expect(apiFetchText).toHaveBeenCalledWith('/api/workflows/wf1/export?format=flow')
  })

  it('will not apply until something has actually changed', async () => {
    setup()
    await waitFor(() => expect(editor()).toHaveValue(FLOW))
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()

    fireEvent.change(editor(), { target: { value: `${FLOW}\nnode two: output-log\n` } })
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled()
  })

  it('applies the edited text and hands the updated workflow back', async () => {
    const onApplied = vi.fn()
    setup({ onApplied })
    await waitFor(() => expect(editor()).toHaveValue(FLOW))

    const edited = FLOW.replace('Order pipeline', 'Renamed')
    fireEvent.change(editor(), { target: { value: edited } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/workflows/wf1/flow', {
        method: 'PUT',
        body: { flow: edited },
      })
    )
    expect(onApplied).toHaveBeenCalledWith({ id: 'wf1', name: 'Order pipeline' })
  })

  it('warns about unapplied edits, and stops once they are applied', async () => {
    setup()
    await waitFor(() => expect(editor()).toHaveValue(FLOW))
    fireEvent.change(editor(), { target: { value: `${FLOW}# note\n` } })
    expect(screen.getByText(/Unapplied edits/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(screen.queryByText(/Unapplied edits/)).not.toBeInTheDocument())
  })

  it('reverts to what was loaded', async () => {
    setup()
    await waitFor(() => expect(editor()).toHaveValue(FLOW))
    fireEvent.change(editor(), { target: { value: 'ruined' } })
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }))
    expect(editor()).toHaveValue(FLOW)
  })

  it('shows a syntax error with its line and the offending source', async () => {
    // The position is the product: a message that only says "invalid" leaves
    // the reader counting lines.
    const err = new Error('Value must be JSON — strings need quotes ("POST", not POST)')
    err.body = { error: err.message, line: 3, column: 11, frame: '  method: POST\n          ^' }
    apiFetch.mockRejectedValueOnce(err)

    setup()
    await waitFor(() => expect(editor()).toHaveValue(FLOW))
    fireEvent.change(editor(), { target: { value: 'workflow "W"\nnode n: action-http\n  method: POST\n' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/Line 3/)
    expect(alert).toHaveTextContent(/strings need quotes/)
    // Scoped to the frame — the same text is in the editor, which proves
    // nothing about the error being shown.
    expect(alert.querySelector('.flowtext__error-frame').textContent).toContain('method: POST')
  })

  it('puts the caret where the parser stopped', async () => {
    const err = new Error('nope')
    err.body = { error: 'nope', line: 2, column: 6 }
    apiFetch.mockRejectedValueOnce(err)

    setup()
    await waitFor(() => expect(editor()).toHaveValue(FLOW))
    const source = 'workflow "W"\nnode broken\n'
    fireEvent.change(editor(), { target: { value: source } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    // Line 2, column 6 → offset 13 (line one is 12 chars plus the newline) + 5.
    await waitFor(() => expect(editor().selectionStart).toBe(18))
  })

  it('surfaces a load failure rather than showing an empty box', async () => {
    apiFetchText.mockRejectedValueOnce(new Error('Workflow not found'))
    setup()
    expect(await screen.findByRole('alert')).toHaveTextContent('Workflow not found')
  })
})
