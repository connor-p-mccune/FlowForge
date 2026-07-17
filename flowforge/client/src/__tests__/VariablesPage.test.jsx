import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import VariablesPage from '../components/variables/VariablesPage'
import { apiFetch } from '../services/api'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

const toast = { success: vi.fn(), error: vi.fn() }
vi.mock('../hooks/useToast', () => ({ useToast: () => toast }))

const VARIABLES = [
  {
    name: 'API_BASE_URL', value: 'https://api.example.com', created_by_name: 'Olivia',
    created_at: '2026-06-01T10:00:00.000Z', updated_at: '2026-06-02T10:00:00.000Z',
  },
  {
    name: 'SLACK_CHANNEL', value: '#deploys', created_by_name: 'Olivia',
    created_at: '2026-06-01T10:00:00.000Z', updated_at: '2026-06-01T10:00:00.000Z',
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  apiFetch.mockImplementation((url, options = {}) => {
    if (!options.method) return Promise.resolve({ variables: VARIABLES })
    if (options.method === 'PUT') {
      const name = url.split('/').pop()
      return Promise.resolve({
        variable: {
          name, value: options.body.value,
          created_by_name: 'Olivia', created_at: 'x', updated_at: 'x',
        },
      })
    }
    if (options.method === 'DELETE') return Promise.resolve({})
    return Promise.reject(new Error(`unexpected ${options.method} ${url}`))
  })
})

describe('VariablesPage', () => {
  it('lists variables with their values visible — unlike secrets', async () => {
    const { container } = render(<VariablesPage workspaceId="ws1" />)
    await waitFor(() => expect(container.textContent).toContain('API_BASE_URL'))
    expect(container.textContent).toContain('https://api.example.com')
    expect(container.textContent).toContain('#deploys')
    expect(apiFetch).toHaveBeenCalledWith('/api/workspaces/ws1/variables')
  })

  it('adds a variable via PUT and normalizes the typed name', async () => {
    render(<VariablesPage workspaceId="ws1" />)
    await screen.findByText('API_BASE_URL')

    fireEvent.change(screen.getByPlaceholderText('API_BASE_URL'), {
      target: { value: 'retry limit' },
    })
    expect(screen.getByPlaceholderText('API_BASE_URL').value).toBe('RETRY_LIMIT')

    fireEvent.change(screen.getByPlaceholderText('https://api.staging.example.com'), {
      target: { value: '5' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add variable' }))

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/workspaces/ws1/variables/RETRY_LIMIT', {
        method: 'PUT',
        body: { value: '5' },
      })
    )
    expect(await screen.findByText('RETRY_LIMIT')).toBeInTheDocument()
    expect(toast.success).toHaveBeenCalled()
  })

  it('blocks adding a duplicate name and points at editing instead', async () => {
    render(<VariablesPage workspaceId="ws1" />)
    await screen.findByText('API_BASE_URL')

    fireEvent.change(screen.getByPlaceholderText('API_BASE_URL'), {
      target: { value: 'SLACK_CHANNEL' },
    })
    fireEvent.change(screen.getByPlaceholderText('https://api.staging.example.com'), {
      target: { value: 'v' },
    })

    expect(screen.getByRole('button', { name: 'Add variable' })).toBeDisabled()
    expect(screen.getByText(/already exists/)).toBeInTheDocument()
  })

  it('edits a variable in place, prefilled with the current value', async () => {
    render(<VariablesPage workspaceId="ws1" />)
    await screen.findByText('API_BASE_URL')

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit value' })[0])
    // Readable values prefill the edit form — no blind retype like secrets.
    const input = screen.getByPlaceholderText('New value')
    expect(input.value).toBe('https://api.example.com')

    fireEvent.change(input, { target: { value: 'https://api.prod.example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/workspaces/ws1/variables/API_BASE_URL', {
        method: 'PUT',
        body: { value: 'https://api.prod.example.com' },
      })
    )
    expect(await screen.findByText('https://api.prod.example.com')).toBeInTheDocument()
  })

  it('deletes a variable after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<VariablesPage workspaceId="ws1" />)
    await screen.findByText('API_BASE_URL')

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0])

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/workspaces/ws1/variables/API_BASE_URL', {
        method: 'DELETE',
      })
    )
    await waitFor(() => expect(screen.queryByText('API_BASE_URL')).not.toBeInTheDocument())
  })

  it('surfaces a load failure', async () => {
    apiFetch.mockRejectedValueOnce(new Error('Workspace not found'))
    render(<VariablesPage workspaceId="ws1" />)
    expect(await screen.findByText('Workspace not found')).toBeInTheDocument()
  })
})
