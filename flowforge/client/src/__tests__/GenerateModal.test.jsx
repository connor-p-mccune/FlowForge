import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import GenerateModal from '../components/canvas/GenerateModal'

// The four example chips the modal renders (kept in step with the component).
const EXAMPLES = [
  'Send a Slack message when a webhook fires with a payment over $100',
  'Every Monday morning fetch our sales data and email me a summary',
  'Classify incoming support tickets and route urgent ones to Slack',
  'When a webhook receives a new signup, extract the name and email and add them to our CRM',
]

function setup(props = {}) {
  const handlers = {
    onSubmit: vi.fn(),
    onConfirmReplace: vi.fn(),
    onCancelReplace: vi.fn(),
    onClose: vi.fn(),
  }
  const utils = render(<GenerateModal {...handlers} {...props} />)
  return { ...handlers, ...utils }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GenerateModal', () => {
  it('renders a prompt textarea and four example chips', () => {
    setup()
    expect(screen.getByPlaceholderText(/Describe your workflow/i)).toBeInTheDocument()
    for (const ex of EXAMPLES) {
      expect(screen.getByRole('button', { name: ex })).toBeInTheDocument()
    }
  })

  it('disables Generate until there is a prompt', () => {
    setup()
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled()
    fireEvent.change(screen.getByPlaceholderText(/Describe your workflow/i), {
      target: { value: 'do a thing' },
    })
    expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled()
  })

  it('fills the textarea when an example chip is clicked', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: EXAMPLES[0] }))
    expect(screen.getByPlaceholderText(/Describe your workflow/i)).toHaveValue(EXAMPLES[0])
  })

  it('submits the trimmed prompt', () => {
    const { onSubmit } = setup()
    fireEvent.change(screen.getByPlaceholderText(/Describe your workflow/i), {
      target: { value: '  build me a flow  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onSubmit).toHaveBeenCalledWith('build me a flow')
  })

  it('shows the error message when generation fails', () => {
    setup({ error: 'The AI couldn’t generate a valid workflow for that description' })
    expect(
      screen.getByText(/couldn’t generate a valid workflow/i)
    ).toBeInTheDocument()
  })

  it('shows a generating state and disables inputs', () => {
    setup({ generating: true })
    expect(screen.getByRole('button', { name: 'Generating…' })).toBeDisabled()
    expect(screen.getByPlaceholderText(/Describe your workflow/i)).toBeDisabled()
    expect(screen.getByRole('button', { name: EXAMPLES[0] })).toBeDisabled()
  })

  it('asks for confirmation before replacing a non-empty canvas', () => {
    const { onConfirmReplace, onCancelReplace } = setup({ confirmReplace: true })
    expect(screen.getByText(/replace your current canvas/i)).toBeInTheDocument()
    // The prompt textarea is hidden in the confirm view.
    expect(screen.queryByPlaceholderText(/Describe your workflow/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Replace canvas' }))
    expect(onConfirmReplace).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancelReplace).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape when not generating', () => {
    const { onClose } = setup()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores Escape while generating', () => {
    const { onClose } = setup({ generating: true })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })
})
