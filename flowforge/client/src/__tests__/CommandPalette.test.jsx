import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import CommandPalette from '../components/palette/CommandPalette'
import { apiFetch } from '../services/api'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

const toast = { success: vi.fn(), error: vi.fn() }
vi.mock('../hooks/useToast', () => ({ useToast: () => toast }))

const mockNavigate = vi.fn()
vi.mock('react-router-dom', async (importOriginal) => {
  const mod = await importOriginal()
  return { ...mod, useNavigate: () => mockNavigate }
})

const WORKSPACES = [{ id: 'ws1', name: 'Acme' }]
const WORKFLOWS = [
  { id: 'wf1', name: 'Nightly Sync' },
  { id: 'wf2', name: 'Alert on failure' },
]

function renderPalette(open = true) {
  const onClose = vi.fn()
  render(
    <MemoryRouter>
      <CommandPalette open={open} onClose={onClose} />
    </MemoryRouter>
  )
  return { onClose }
}

beforeEach(() => {
  vi.clearAllMocks()
  apiFetch.mockImplementation((url, options = {}) => {
    if (url === '/api/workspaces') return Promise.resolve({ workspaces: WORKSPACES })
    if (url === '/api/workspaces/ws1/workflows' && !options.method) {
      return Promise.resolve({ workflows: WORKFLOWS })
    }
    if (options.method === 'POST') {
      return Promise.resolve({ workflow: { id: 'wf-new', name: 'Untitled workflow' } })
    }
    return Promise.reject(new Error(`unexpected ${url}`))
  })
})

describe('CommandPalette', () => {
  it('renders nothing while closed', () => {
    const { container } = render(
      <MemoryRouter>
        <CommandPalette open={false} onClose={vi.fn()} />
      </MemoryRouter>
    )
    expect(container.querySelector('.palette')).toBeNull()
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('loads workflows and pages when opened', async () => {
    renderPalette()
    expect(await screen.findByText('Nightly Sync')).toBeInTheDocument()
    expect(screen.getByText('Alert on failure')).toBeInTheDocument()
    expect(screen.getByText('Dashboard')).toBeInTheDocument()
    expect(screen.getByText('Secrets — Acme')).toBeInTheDocument()
    expect(screen.getByText('New workflow — Acme')).toBeInTheDocument()
  })

  it('fuzzy-filters results as you type', async () => {
    renderPalette()
    await screen.findByText('Nightly Sync')

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'nsync' } })
    expect(screen.getByText(/Sync/)).toBeInTheDocument()
    expect(screen.queryByText('Alert on failure')).not.toBeInTheDocument()
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument()
  })

  it('opens the selected workflow with Enter and closes', async () => {
    const { onClose } = renderPalette()
    await screen.findByText('Nightly Sync')

    const input = screen.getByLabelText('Search')
    fireEvent.change(input, { target: { value: 'nightly' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/workflow/wf1'))
    expect(onClose).toHaveBeenCalled()
  })

  it('arrow keys move the selection before Enter', async () => {
    renderPalette()
    await screen.findByText('Nightly Sync')

    const input = screen.getByLabelText('Search')
    // Two workflow entries come first; ArrowDown selects the second.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/workflow/wf2'))
  })

  it('creates a workflow through the New workflow action', async () => {
    renderPalette()
    await screen.findByText('Nightly Sync')

    fireEvent.click(screen.getByText('New workflow — Acme'))
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/workspaces/ws1/workflows', {
        method: 'POST',
        body: { name: 'Untitled workflow' },
      })
    )
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/workflow/wf-new'))
  })

  it('closes on Escape and on backdrop click', async () => {
    const { onClose } = renderPalette()
    await screen.findByText('Nightly Sync')

    fireEvent.keyDown(screen.getByLabelText('Search'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.click(document.querySelector('.palette__backdrop'))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('shows an empty state for a query with no matches', async () => {
    renderPalette()
    await screen.findByText('Nightly Sync')
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'zzzzzz' } })
    expect(screen.getByText(/No matches/)).toBeInTheDocument()
  })
})
