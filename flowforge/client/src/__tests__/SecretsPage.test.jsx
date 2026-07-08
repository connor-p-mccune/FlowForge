import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import SecretsPage from '../components/secrets/SecretsPage'
import { apiFetch } from '../services/api'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

const toast = { success: vi.fn(), error: vi.fn() }
vi.mock('../hooks/useToast', () => ({ useToast: () => toast }))

const SECRETS = [
  {
    name: 'SLACK_TOKEN', created_by_name: 'Olivia',
    created_at: '2026-06-01T10:00:00.000Z', updated_at: '2026-06-02T10:00:00.000Z',
  },
  {
    name: 'STRIPE_KEY', created_by_name: 'Olivia',
    created_at: '2026-06-01T10:00:00.000Z', updated_at: '2026-06-01T10:00:00.000Z',
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  apiFetch.mockImplementation((url, options = {}) => {
    if (!options.method) return Promise.resolve({ secrets: SECRETS })
    if (options.method === 'PUT') {
      const name = url.split('/').pop()
      return Promise.resolve({
        secret: { name, created_by_name: 'Olivia', created_at: 'x', updated_at: 'x' },
      })
    }
    if (options.method === 'DELETE') return Promise.resolve({})
    return Promise.reject(new Error(`unexpected ${options.method} ${url}`))
  })
})

describe('SecretsPage', () => {
  it('lists secret names with masked values — never a plaintext value', async () => {
    const { container } = render(<SecretsPage workspaceId="ws1" />)
    await waitFor(() => expect(container.textContent).toContain('SLACK_TOKEN'))
    expect(container.textContent).toContain('STRIPE_KEY')
    expect(apiFetch).toHaveBeenCalledWith('/api/workspaces/ws1/secrets')
    // Values render as mask dots only.
    expect(container.querySelectorAll('.secrets-page__value')).toHaveLength(2)
  })

  it('adds a secret via PUT and normalizes the typed name', async () => {
    render(<SecretsPage workspaceId="ws1" />)
    await screen.findByText('SLACK_TOKEN')

    fireEvent.change(screen.getByPlaceholderText('STRIPE_API_KEY'), {
      target: { value: 'my api key' },
    })
    // Lowercase + spaces normalize to UPPER_SNAKE.
    expect(screen.getByPlaceholderText('STRIPE_API_KEY').value).toBe('MY_API_KEY')

    fireEvent.change(screen.getByPlaceholderText('sk_live_…'), {
      target: { value: 'sk-live-999' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add secret' }))

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/workspaces/ws1/secrets/MY_API_KEY', {
        method: 'PUT',
        body: { value: 'sk-live-999' },
      })
    )
    expect(await screen.findByText('MY_API_KEY')).toBeInTheDocument()
    expect(toast.success).toHaveBeenCalled()
  })

  it('blocks adding a duplicate name and points at rotation instead', async () => {
    render(<SecretsPage workspaceId="ws1" />)
    await screen.findByText('SLACK_TOKEN')

    fireEvent.change(screen.getByPlaceholderText('STRIPE_API_KEY'), {
      target: { value: 'SLACK_TOKEN' },
    })
    fireEvent.change(screen.getByPlaceholderText('sk_live_…'), { target: { value: 'v' } })

    expect(screen.getByRole('button', { name: 'Add secret' })).toBeDisabled()
    expect(screen.getByText(/already exists/)).toBeInTheDocument()
  })

  it('rotates a secret in place', async () => {
    render(<SecretsPage workspaceId="ws1" />)
    await screen.findByText('SLACK_TOKEN')

    fireEvent.click(screen.getAllByRole('button', { name: 'Replace value' })[0])
    fireEvent.change(screen.getByPlaceholderText('New value'), {
      target: { value: 'xoxb-new-token' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/workspaces/ws1/secrets/SLACK_TOKEN', {
        method: 'PUT',
        body: { value: 'xoxb-new-token' },
      })
    )
  })

  it('deletes a secret after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<SecretsPage workspaceId="ws1" />)
    await screen.findByText('SLACK_TOKEN')

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0])

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/workspaces/ws1/secrets/SLACK_TOKEN', {
        method: 'DELETE',
      })
    )
    await waitFor(() => expect(screen.queryByText('SLACK_TOKEN')).not.toBeInTheDocument())
  })

  it('surfaces a load failure', async () => {
    apiFetch.mockRejectedValueOnce(new Error('Workspace not found'))
    render(<SecretsPage workspaceId="ws1" />)
    expect(await screen.findByText('Workspace not found')).toBeInTheDocument()
  })
})
