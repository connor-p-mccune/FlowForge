import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import WebhookPanel from '../components/canvas/WebhookPanel'
import { apiFetch } from '../services/api'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

const EXISTING = {
  id: 'wh-1',
  webhook_key: 'abc123',
  name: 'Pushes',
  signed: false,
  filter_expression: 'event == "push"',
}

function renderPanel() {
  render(<WebhookPanel workflowId="wf-1" open onClose={vi.fn()} />)
}

describe('WebhookPanel gate expressions', () => {
  beforeEach(() => {
    apiFetch.mockReset()
  })

  it('sends the create-form filter along and shows it on the new row', async () => {
    apiFetch.mockImplementation((url, opts) => {
      if (!opts) return Promise.resolve({ webhooks: [] })
      if (opts.method === 'POST') {
        return Promise.resolve({
          webhook: {
            id: 'wh-2',
            webhook_key: 'key2',
            name: opts.body.name,
            signed: false,
            filter_expression: opts.body.filterExpression ?? null,
          },
        })
      }
      return Promise.resolve({})
    })
    renderPanel()

    fireEvent.change(await screen.findByLabelText(/only fire when/i), {
      target: { value: 'ref == "main"' },
    })
    fireEvent.click(screen.getByRole('button', { name: /new webhook url/i }))

    await waitFor(() => {
      const [, opts] = apiFetch.mock.calls.find(([, o]) => o?.method === 'POST')
      expect(opts.body.filterExpression).toBe('ref == "main"')
    })
    expect(screen.getByText('ref == "main"')).toBeInTheDocument()
    // The form resets so the next webhook doesn't inherit the filter.
    expect(screen.getByLabelText(/only fire when/i)).toHaveValue('')
  })

  it('edits an existing filter through PUT without touching the key', async () => {
    apiFetch.mockImplementation((url, opts) => {
      if (!opts) return Promise.resolve({ webhooks: [EXISTING] })
      if (opts.method === 'PUT') {
        return Promise.resolve({
          webhook: { ...EXISTING, filter_expression: opts.body.filterExpression },
        })
      }
      return Promise.resolve({})
    })
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: /edit filter/i }))
    const input = screen.getByLabelText('Gate expression')
    expect(input).toHaveValue('event == "push"')
    fireEvent.change(input, { target: { value: 'event == "release"' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/webhooks/wh-1', {
        method: 'PUT',
        body: { filterExpression: 'event == "release"' },
      })
    )
    expect(screen.getByText('event == "release"')).toBeInTheDocument()
  })

  it('clearing the filter sends null and shows fires-on-everything', async () => {
    apiFetch.mockImplementation((url, opts) => {
      if (!opts) return Promise.resolve({ webhooks: [EXISTING] })
      if (opts.method === 'PUT') {
        return Promise.resolve({ webhook: { ...EXISTING, filter_expression: null } })
      }
      return Promise.resolve({})
    })
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: /edit filter/i }))
    fireEvent.change(screen.getByLabelText('Gate expression'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/webhooks/wh-1', {
        method: 'PUT',
        body: { filterExpression: null },
      })
    )
    expect(screen.getByText(/fires on every delivery/i)).toBeInTheDocument()
  })

  it('surfaces a server validation error and keeps the editor open', async () => {
    apiFetch.mockImplementation((url, opts) => {
      if (!opts) return Promise.resolve({ webhooks: [EXISTING] })
      return Promise.reject(new Error('filterExpression has a syntax error — Unexpected end of expression'))
    })
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: /edit filter/i }))
    fireEvent.change(screen.getByLabelText('Gate expression'), { target: { value: 'event ==' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    expect(await screen.findByText(/syntax error/i)).toBeInTheDocument()
    expect(screen.getByLabelText('Gate expression')).toBeInTheDocument()
  })
})
