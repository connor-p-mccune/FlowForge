import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import WebhooksPage from '../components/webhooks/WebhooksPage'
import { apiFetch } from '../services/api'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

const toast = { success: vi.fn(), error: vi.fn() }
vi.mock('../hooks/useToast', () => ({ useToast: () => toast }))

const SUBSCRIPTIONS = [
  {
    id: 'sub-1',
    workspaceId: 'ws1',
    url: 'https://ci.example.com/hooks',
    description: 'CI alerts',
    events: ['execution.*'],
    isActive: true,
    createdAt: '2026-07-01T10:00:00.000Z',
    createdByName: 'Olivia',
    deliveredCount: 12,
    failedCount: 2,
  },
]

const DELIVERIES = [
  {
    id: 'del-1', event_type: 'execution.failed', status: 'failed', attempts: 5,
    response_status: 500, error: 'HTTP 500', created_at: '2026-07-08T10:00:00.000Z',
    delivered_at: null, next_attempt_at: null,
  },
  {
    id: 'del-2', event_type: 'execution.completed', status: 'delivered', attempts: 1,
    response_status: 200, error: null, created_at: '2026-07-08T09:00:00.000Z',
    delivered_at: '2026-07-08T09:00:01.000Z', next_attempt_at: null,
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  apiFetch.mockImplementation((url, options = {}) => {
    if (!options.method && url.endsWith('/subscriptions')) {
      return Promise.resolve({ subscriptions: SUBSCRIPTIONS })
    }
    if (!options.method && url.endsWith('/deliveries')) {
      return Promise.resolve({ deliveries: DELIVERIES })
    }
    if (options.method === 'POST' && url.endsWith('/subscriptions')) {
      return Promise.resolve({
        subscription: {
          id: 'sub-new',
          workspaceId: 'ws1',
          url: options.body.url,
          description: options.body.description ?? null,
          events: options.body.events,
          isActive: true,
          createdAt: 'x',
          createdByName: 'Olivia',
          secret: 'whsec_shownonce',
        },
      })
    }
    if (options.method === 'POST' && url.endsWith('/test')) {
      return Promise.resolve({ delivery: { id: 'ping-1', event_type: 'ping', status: 'delivered' } })
    }
    if (options.method === 'POST' && url.endsWith('/redeliver')) {
      return Promise.resolve({ delivery: { ...DELIVERIES[0], status: 'delivered', response_status: 200, error: null } })
    }
    if (options.method === 'PATCH') {
      return Promise.resolve({ subscription: { ...SUBSCRIPTIONS[0], isActive: options.body.isActive } })
    }
    if (options.method === 'DELETE') return Promise.resolve({ ok: true })
    return Promise.reject(new Error(`unexpected ${options.method} ${url}`))
  })
})

describe('WebhooksPage', () => {
  it('lists subscriptions with status, event chips, and delivery counts', async () => {
    const { container } = render(<WebhooksPage workspaceId="ws1" />)
    await screen.findByText('https://ci.example.com/hooks')
    expect(apiFetch).toHaveBeenCalledWith('/api/workspaces/ws1/subscriptions')
    expect(screen.getByText('active')).toBeInTheDocument()
    expect(screen.getByText('execution.*')).toBeInTheDocument()
    expect(screen.getByText('12 delivered')).toBeInTheDocument()
    expect(screen.getByText('2 failed')).toBeInTheDocument()
    // The signing secret never appears in a listing.
    expect(container.textContent).not.toContain('whsec_')
  })

  it('creates a subscription and reveals the signing secret once', async () => {
    render(<WebhooksPage workspaceId="ws1" />)
    await screen.findByText('https://ci.example.com/hooks')

    fireEvent.change(screen.getByPlaceholderText('https://ci.example.com/hooks/flowforge'), {
      target: { value: 'https://new.example.com/hook' },
    })
    fireEvent.change(screen.getByPlaceholderText('execution.*, workflow.deployed'), {
      target: { value: 'workflow.deployed, execution.failed' },
    })
    fireEvent.click(screen.getByRole('button', { name: /add webhook/i }))

    await screen.findByText('whsec_shownonce')
    expect(apiFetch).toHaveBeenCalledWith('/api/workspaces/ws1/subscriptions', {
      method: 'POST',
      body: {
        url: 'https://new.example.com/hook',
        events: ['workflow.deployed', 'execution.failed'],
        description: undefined,
      },
    })
    // Dismissing the reveal removes the secret from the page for good.
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByText('whsec_shownonce')).not.toBeInTheDocument()
  })

  it('pauses a subscription via PATCH', async () => {
    render(<WebhooksPage workspaceId="ws1" />)
    await screen.findByText('https://ci.example.com/hooks')

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/workspaces/ws1/subscriptions/sub-1', {
        method: 'PATCH',
        body: { isActive: false },
      })
    )
    await screen.findByText('paused')
  })

  it('deletes after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<WebhooksPage workspaceId="ws1" />)
    await screen.findByText('https://ci.example.com/hooks')

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/workspaces/ws1/subscriptions/sub-1', {
        method: 'DELETE',
      })
    )
    expect(screen.queryByText('https://ci.example.com/hooks')).not.toBeInTheDocument()
  })

  it('shows the delivery log and redelivers a failed delivery', async () => {
    render(<WebhooksPage workspaceId="ws1" />)
    await screen.findByText('https://ci.example.com/hooks')

    fireEvent.click(screen.getByRole('button', { name: 'Deliveries' }))
    await screen.findByText('execution.failed')
    expect(screen.getByText('delivered')).toBeInTheDocument()
    // Only the non-delivered row offers Redeliver.
    const redeliver = screen.getAllByRole('button', { name: 'Redeliver' })
    expect(redeliver).toHaveLength(1)

    fireEvent.click(redeliver[0])
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/workspaces/ws1/subscriptions/sub-1/deliveries/del-1/redeliver',
        { method: 'POST' }
      )
    )
    // The row updates in place — no Redeliver button remains.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Redeliver' })).not.toBeInTheDocument()
    )
  })

  it('sends a test ping', async () => {
    render(<WebhooksPage workspaceId="ws1" />)
    await screen.findByText('https://ci.example.com/hooks')

    fireEvent.click(screen.getByRole('button', { name: 'Send test' }))
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/workspaces/ws1/subscriptions/sub-1/test', {
        method: 'POST',
      })
    )
    expect(toast.success).toHaveBeenCalled()
  })
})
