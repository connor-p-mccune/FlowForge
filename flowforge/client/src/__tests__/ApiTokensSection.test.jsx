import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import ApiTokensSection from '../components/settings/ApiTokensSection'
import { apiFetch } from '../services/api'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

const toast = { success: vi.fn(), error: vi.fn() }
vi.mock('../hooks/useToast', () => ({ useToast: () => toast }))

const EXISTING = [
  {
    id: 'tk1', name: 'ci pipeline', tokenPrefix: 'ffp_11111111', scopes: ['trigger', 'read'],
    lastUsedAt: '2026-07-01T10:00:00.000Z', expiresAt: null, revokedAt: null,
    createdAt: '2026-06-01T10:00:00.000Z',
  },
  {
    id: 'tk2', name: 'old bot', tokenPrefix: 'ffp_22222222', scopes: ['read'],
    lastUsedAt: null, expiresAt: null, revokedAt: '2026-06-15T10:00:00.000Z',
    createdAt: '2026-05-01T10:00:00.000Z',
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  apiFetch.mockImplementation((url, options = {}) => {
    if (!options.method) return Promise.resolve({ tokens: EXISTING })
    if (options.method === 'POST') {
      return Promise.resolve({
        token: 'ffp_' + 'a'.repeat(40),
        apiToken: {
          id: 'tk3', name: options.body.name, tokenPrefix: 'ffp_aaaaaaaa',
          scopes: options.body.scopes, lastUsedAt: null,
          expiresAt: null, revokedAt: null, createdAt: 'now',
        },
      })
    }
    if (options.method === 'DELETE') return Promise.resolve({})
    return Promise.reject(new Error('unexpected'))
  })
})

describe('ApiTokensSection', () => {
  it('lists tokens with prefix, status, and usage', async () => {
    const { container } = render(<ApiTokensSection />)
    await waitFor(() => expect(container.textContent).toContain('ci pipeline'))
    expect(container.textContent).toContain('ffp_11111111…')
    expect(container.textContent).toContain('Active')
    expect(container.textContent).toContain('Revoked')
    expect(container.textContent).toContain('never used')
    // A revoked token has no Revoke button; the active one does.
    expect(screen.getAllByRole('button', { name: 'Revoke' })).toHaveLength(1)
  })

  it('creates a token and reveals the full value exactly once', async () => {
    const { container } = render(<ApiTokensSection />)
    await screen.findByText('ci pipeline')

    fireEvent.click(screen.getByRole('button', { name: 'New token' }))
    fireEvent.change(screen.getByPlaceholderText('e.g. deploy pipeline'), {
      target: { value: 'release bot' },
    })
    // Drop the read scope, keep trigger.
    fireEvent.click(screen.getByLabelText(/Read/))
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }))

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/tokens', {
        method: 'POST',
        body: { name: 'release bot', scopes: ['trigger'] },
      })
    )
    expect(container.textContent).toContain('ffp_' + 'a'.repeat(40))
    expect(container.textContent).toContain('won’t be shown again')

    // Dismissing hides the value for good.
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(container.textContent).not.toContain('ffp_' + 'a'.repeat(40))
  })

  it('requires a name and at least one scope', async () => {
    render(<ApiTokensSection />)
    await screen.findByText('ci pipeline')

    fireEvent.click(screen.getByRole('button', { name: 'New token' }))
    const submit = screen.getByRole('button', { name: 'Create token' })
    expect(submit).toBeDisabled()

    fireEvent.change(screen.getByPlaceholderText('e.g. deploy pipeline'), {
      target: { value: 'x' },
    })
    expect(submit).not.toBeDisabled()

    // Unchecking both scopes disables submit again.
    fireEvent.click(screen.getByLabelText(/Trigger runs/))
    fireEvent.click(screen.getByLabelText(/Read/))
    expect(submit).toBeDisabled()
  })

  it('revokes a token after confirmation and flags it in the list', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { container } = render(<ApiTokensSection />)
    await screen.findByText('ci pipeline')

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/tokens/tk1', { method: 'DELETE' })
    )
    await waitFor(() =>
      expect(container.querySelectorAll('.tokens__badge--revoked')).toHaveLength(2)
    )
  })
})
