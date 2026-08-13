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

describe('encryption key rotation', () => {
  // The banner exists to answer one question — is anything still on the old
  // key? — so it appears only when the answer is yes.
  const withKeyring = (keyring) => {
    apiFetch.mockImplementation((url, options = {}) => {
      if (url.endsWith('/secrets/keys')) return Promise.resolve(keyring)
      if (url.endsWith('/secrets/rotate')) {
        return Promise.resolve({ activeKeyId: 'k2', rotated: 1, unchanged: 1, names: ['STRIPE_KEY'], failed: [] })
      }
      if (!options.method) return Promise.resolve({ secrets: SECRETS })
      return Promise.resolve({})
    })
  }

  it('stays quiet when every secret is on the current key', async () => {
    withKeyring({ activeKeyId: 'k2', stale: 0, secrets: [] })
    render(<SecretsPage workspaceId="ws1" />)
    await screen.findByText('SLACK_TOKEN')
    expect(screen.queryByRole('button', { name: /Re-encrypt/ })).not.toBeInTheDocument()
  })

  it('offers to re-encrypt when something is behind, and says what that means', async () => {
    withKeyring({
      activeKeyId: 'k2',
      stale: 1,
      secrets: [{ name: 'STRIPE_KEY', keyId: 'k1', stale: true }],
    })
    render(<SecretsPage workspaceId="ws1" />)

    expect(await screen.findByText(/1 secret is encrypted with an older key/)).toBeInTheDocument()
    // The reassurance that matters: nothing is broken in the meantime.
    expect(screen.getByText(/still decrypt normally/)).toBeInTheDocument()
    expect(screen.getByText('key k1')).toBeInTheDocument()
  })

  it('re-encrypts and reports how many moved', async () => {
    withKeyring({
      activeKeyId: 'k2',
      stale: 1,
      secrets: [{ name: 'STRIPE_KEY', keyId: 'k1', stale: true }],
    })
    render(<SecretsPage workspaceId="ws1" />)
    fireEvent.click(await screen.findByRole('button', { name: /Re-encrypt/ }))

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/workspaces/ws1/secrets/rotate', { method: 'POST' })
    )
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('Re-encrypted 1 secret'))
    )
  })

  it('reports a secret whose key was retired instead of claiming success', async () => {
    apiFetch.mockImplementation((url, options = {}) => {
      if (url.endsWith('/secrets/keys')) {
        return Promise.resolve({
          activeKeyId: 'k2',
          stale: 1,
          secrets: [{ name: 'STRIPE_KEY', keyId: 'gone', stale: true }],
        })
      }
      if (url.endsWith('/secrets/rotate')) {
        return Promise.resolve({
          activeKeyId: 'k2', rotated: 0, unchanged: 1,
          names: [], failed: [{ name: 'STRIPE_KEY', error: 'key "gone" is not in the current key ring' }],
        })
      }
      if (!options.method) return Promise.resolve({ secrets: SECRETS })
      return Promise.resolve({})
    })
    render(<SecretsPage workspaceId="ws1" />)
    fireEvent.click(await screen.findByRole('button', { name: /Re-encrypt/ }))

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('not in the current key ring'))
    )
  })

  it('shows nothing at all to somebody who cannot manage keys', async () => {
    apiFetch.mockImplementation((url, options = {}) => {
      if (url.endsWith('/secrets/keys')) return Promise.reject(new Error('Only workspace owners can manage secrets'))
      if (!options.method) return Promise.resolve({ secrets: SECRETS })
      return Promise.resolve({})
    })
    render(<SecretsPage workspaceId="ws1" />)
    await screen.findByText('SLACK_TOKEN')
    // Refused is not an error worth surfacing — the section is an owner's concern.
    expect(screen.queryByText(/older key/)).not.toBeInTheDocument()
    expect(screen.queryByText('Only workspace owners can manage secrets')).not.toBeInTheDocument()
  })
})
