import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import ActivityPage from '../components/activity/ActivityPage'
import { apiFetch } from '../services/api'
import { useWorkspaceActivity } from '../hooks/useWorkspaceActivity'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))
vi.mock('../hooks/useWorkspaceActivity', () => ({ useWorkspaceActivity: vi.fn() }))

const PAGE1 = [
  {
    id: 'e2', event_type: 'workflow.deployed', entity_type: 'workflow', entity_id: 'wf1',
    entity_name: 'Webhook Alerter', actor_id: 'u1', actor_display_name: 'Olivia',
    metadata: { version: 1 }, created_at: '2026-06-19T10:02:00.000Z',
  },
  {
    id: 'e1', event_type: 'workflow.created', entity_type: 'workflow', entity_id: 'wf1',
    entity_name: 'Webhook Alerter', actor_id: 'u1', actor_display_name: 'Olivia',
    metadata: null, created_at: '2026-06-19T10:01:00.000Z',
  },
]
const PAGE2 = [
  {
    id: 'e0', event_type: 'execution.completed', entity_type: 'execution', entity_id: 'ex1',
    entity_name: 'Nightly Sync', actor_id: 'u1', actor_display_name: 'Olivia',
    metadata: { workflowId: 'wf9' }, created_at: '2026-06-19T09:00:00.000Z',
  },
]
const MEMBER_EVENT = {
  id: 'm1', event_type: 'member.invited', entity_type: 'member', entity_id: 'u2',
  entity_name: 'Marty', actor_id: 'u1', actor_display_name: 'Olivia',
  metadata: null, created_at: '2026-06-19T10:05:00.000Z',
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ActivityPage workspaceId="ws1" />
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  apiFetch.mockImplementation((url) => {
    if (url.includes('before=')) return Promise.resolve({ activity: PAGE2, hasMore: false })
    if (url.includes('category=members')) return Promise.resolve({ activity: [MEMBER_EVENT], hasMore: false })
    return Promise.resolve({ activity: PAGE1, hasMore: true })
  })
})

describe('ActivityPage', () => {
  it('loads and renders the feed for the workspace', async () => {
    const { container } = renderPage()
    await waitFor(() =>
      expect(container.textContent).toContain('deployed Webhook Alerter (v1)')
    )
    expect(container.textContent).toContain('created workflow Webhook Alerter')
    expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('/api/workspaces/ws1/activity'))
  })

  it('appends the next page via "Load more" using the before cursor', async () => {
    const { container } = renderPage()
    await screen.findByRole('button', { name: 'Load more' })

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))

    await waitFor(() => expect(container.textContent).toContain('ran Nightly Sync'))
    expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('before='))
    // The first page is still present.
    expect(container.textContent).toContain('created workflow Webhook Alerter')
  })

  it('refetches with the category filter when a tab is clicked', async () => {
    const { container } = renderPage()
    await waitFor(() => expect(container.textContent).toContain('Webhook Alerter'))

    fireEvent.click(screen.getByRole('button', { name: 'Members' }))

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('category=members'))
    )
    await waitFor(() =>
      expect(container.textContent).toContain('added Marty to the workspace')
    )
  })

  it('prepends a live event pushed over the socket', async () => {
    const { container } = renderPage()
    await waitFor(() => expect(container.textContent).toContain('Webhook Alerter'))

    // The hook is called with (workspaceId, handlers); grab the latest onEvent.
    const handlers = useWorkspaceActivity.mock.calls.at(-1)[1]
    act(() => {
      handlers.onEvent({
        id: 'live1', event_type: 'workflow.created', entity_type: 'workflow',
        entity_id: 'wf2', entity_name: 'Fresh Flow', actor_id: 'u1',
        actor_display_name: 'Olivia', metadata: null, created_at: '2026-06-19T11:00:00.000Z',
      })
    })

    await waitFor(() =>
      expect(container.textContent).toContain('created workflow Fresh Flow')
    )
  })

  it('shows the empty state when there is no activity', async () => {
    apiFetch.mockResolvedValue({ activity: [], hasMore: false })
    const { container } = renderPage()
    await waitFor(() => expect(container.textContent).toContain('No activity yet'))
  })
})
