import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import WebhookPanel from '../components/canvas/WebhookPanel'
import { apiFetch } from '../services/api'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

function renderPanel() {
  render(<WebhookPanel workflowId="wf-1" open onClose={vi.fn()} />)
}

describe('WebhookPanel signing', () => {
  beforeEach(() => {
    apiFetch.mockReset()
    apiFetch.mockImplementation((url, opts) => {
      if (!opts) return Promise.resolve({ webhooks: [] })
      if (opts.method === 'POST') {
        const signed = Boolean(opts.body.signed)
        return Promise.resolve({
          webhook: { id: 'wh-1', webhook_key: 'abc123', name: opts.body.name, signed },
          ...(signed ? { signingSecret: 'whsec_' + 'a'.repeat(48) } : {}),
        })
      }
      return Promise.resolve({})
    })
  })

  it('creates an unsigned webhook by default and shows no secret', async () => {
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /new webhook url/i }))

    await waitFor(() => expect(screen.getByText('Webhook 1')).toBeInTheDocument())
    const [, opts] = apiFetch.mock.calls.find(([, o]) => o?.method === 'POST')
    expect(opts.body.signed).toBe(false)
    expect(screen.queryByText(/signing secret/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/🔏 Signed/)).not.toBeInTheDocument()
  })

  it('creates a signed webhook and shows the secret exactly once', async () => {
    renderPanel()
    fireEvent.click(await screen.findByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: /new webhook url/i }))

    // The one-time secret block appears with the full secret and header recipe.
    expect(await screen.findByText(/copy it now/i)).toBeInTheDocument()
    expect(screen.getByText('whsec_' + 'a'.repeat(48))).toBeInTheDocument()
    expect(screen.getByText(/X-FlowForge-Signature/)).toBeInTheDocument()
    // And the list entry carries the signed badge.
    expect(screen.getByText(/🔏 Signed/)).toBeInTheDocument()
  })
})
