import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import ExecutionHistory from '../components/execution/ExecutionHistory'
import { apiFetch } from '../services/api'

// All HTTP goes through services/api — mock it so the test controls responses.
vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

const WF_UPDATED = '2026-06-17T10:00:00.000Z'

// exA: a webhook run from *before* the workflow was last edited → modified-since.
// exB: a manual run from *after* the last edit → not modified.
const EXECS = [
  {
    id: 'exA',
    status: 'completed',
    trigger_type: 'webhook',
    triggered_by: null,
    created_at: '2026-06-16T09:00:00.000Z',
    started_at: '2026-06-16T09:00:00.000Z',
    finished_at: '2026-06-16T09:00:01.000Z',
  },
  {
    id: 'exB',
    status: 'failed',
    trigger_type: 'manual',
    triggered_by: 'u1',
    created_at: '2026-06-17T11:00:00.000Z',
    started_at: null,
    finished_at: null,
  },
]

const REPLAY_EXEC = { id: 'exNew', status: 'pending', trigger_type: 'replay' }

function mockApi() {
  apiFetch.mockImplementation((path) => {
    if (path.endsWith('/replay')) return Promise.resolve({ execution: REPLAY_EXEC })
    if (path === '/api/workflows/wf1/executions') {
      return Promise.resolve({ executions: EXECS, workflowUpdatedAt: WF_UPDATED })
    }
    if (path === '/api/executions/exA') {
      return Promise.resolve({ execution: EXECS[0], steps: [] })
    }
    return Promise.reject(new Error(`unexpected request: ${path}`))
  })
}

function setup() {
  return render(<ExecutionHistory workflowId="wf1" nodes={[]} />)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockApi()
})

describe('ExecutionHistory replay', () => {
  it('renders a Replay button on each past run', async () => {
    setup()
    await screen.findByText('completed')
    expect(screen.getAllByRole('button', { name: 'Replay this run' })).toHaveLength(2)
    expect(apiFetch).toHaveBeenCalledWith('/api/workflows/wf1/executions')
  })

  it('confirms with the webhook label and warns when the workflow changed since', async () => {
    setup()
    await screen.findByText('completed')
    fireEvent.click(screen.getAllByRole('button', { name: 'Replay this run' })[0])

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('Re-run this workflow with the original webhook trigger data?')
    expect(dialog).toHaveTextContent(/this workflow has been modified since this execution/i)
  })

  it('confirms with the manual label and no warning for an unchanged run', async () => {
    setup()
    await screen.findByText('failed')
    fireEvent.click(screen.getAllByRole('button', { name: 'Replay this run' })[1])

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('Re-run this workflow with the original manual trigger data?')
    expect(dialog).not.toHaveTextContent(/has been modified/i)
  })

  it('replays on confirm: posts to the replay endpoint and refreshes the list', async () => {
    setup()
    await screen.findByText('completed')
    fireEvent.click(screen.getAllByRole('button', { name: 'Replay this run' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/executions/exA/replay', { method: 'POST' })
    )
    // List re-fetched (initial load + post-replay refresh).
    const listCalls = apiFetch.mock.calls.filter(([p]) => p === '/api/workflows/wf1/executions')
    expect(listCalls.length).toBeGreaterThanOrEqual(2)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('cancelling the confirmation replays nothing', async () => {
    setup()
    await screen.findByText('completed')
    fireEvent.click(screen.getAllByRole('button', { name: 'Replay this run' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(apiFetch).not.toHaveBeenCalledWith(
      '/api/executions/exA/replay',
      expect.anything()
    )
  })

  it('offers Replay from the execution detail view too', async () => {
    setup()
    await screen.findByText('completed')
    // Open a run's detail by clicking its row (the status badge sits inside it).
    fireEvent.click(screen.getByText('completed'))

    await screen.findByText('← All runs')
    const replay = screen.getByRole('button', { name: 'Replay this run' })
    fireEvent.click(replay)
    expect(screen.getByRole('dialog')).toHaveTextContent(/original webhook trigger data/)
  })
})
