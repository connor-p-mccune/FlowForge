import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

import StatusPage from '../components/status/StatusPage'
import StatusPageSection from '../components/analytics/StatusPageSection'
import { apiFetch } from '../services/api'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))
const toast = { success: vi.fn(), error: vi.fn() }
vi.mock('../hooks/useToast', () => ({ useToast: () => toast }))

const PAGE = {
  workspace: 'Acme Ops',
  generatedAt: '2026-07-17T10:00:00.000Z',
  workflows: [
    {
      name: 'Nightly ETL',
      runs: [
        { status: 'completed', durationMs: 2000, finishedAt: '2026-07-17T09:00:00Z' },
        { status: 'failed', durationMs: 500, finishedAt: '2026-07-17T09:30:00Z' },
        { status: 'completed', durationMs: 4000, finishedAt: '2026-07-17T09:59:00Z' },
      ],
      successRate: 2 / 3,
      p50DurationMs: 3000,
      lastRunStatus: 'completed',
      lastRunAt: '2026-07-17T09:59:00.000Z',
    },
    {
      name: 'Pager escalation',
      runs: [{ status: 'failed', durationMs: 100, finishedAt: '2026-07-17T08:00:00Z' }],
      successRate: 0,
      p50DurationMs: null,
      lastRunStatus: 'failed',
      lastRunAt: '2026-07-17T08:00:00.000Z',
    },
  ],
}

function renderStatus(token = 'tok-abc') {
  return render(
    <MemoryRouter initialEntries={[`/status/${token}`]}>
      <Routes>
        <Route path="/status/:token" element={<StatusPage />} />
      </Routes>
    </MemoryRouter>
  )
}

beforeEach(() => vi.clearAllMocks())

describe('StatusPage (public)', () => {
  it('renders workflow health, uptime bars, and the overall banner', async () => {
    apiFetch.mockResolvedValue(PAGE)
    renderStatus()

    expect(await screen.findByText('Acme Ops')).toBeInTheDocument()
    expect(apiFetch).toHaveBeenCalledWith('/api/status/tok-abc')

    // One workflow failing → the overall banner says so.
    expect(screen.getByText('1 workflow failing')).toBeInTheDocument()
    expect(screen.getByText('Nightly ETL')).toBeInTheDocument()
    expect(screen.getByText('Operational')).toBeInTheDocument()
    expect(screen.getByText('Failing')).toBeInTheDocument()
    expect(screen.getByText('67% success')).toBeInTheDocument()
    expect(screen.getByText('typical 3.0s')).toBeInTheDocument()

    // One bar per run, colored by status.
    const etlBars = screen
      .getByLabelText('Recent runs of Nightly ETL, oldest first')
      .querySelectorAll('.status-page__bar')
    expect(etlBars).toHaveLength(3)
    expect(etlBars[1].className).toContain('status-page__bar--failed')
  })

  it('celebrates when everything is operational', async () => {
    apiFetch.mockResolvedValue({
      ...PAGE,
      workflows: [PAGE.workflows[0]],
    })
    renderStatus()
    expect(await screen.findByText('All workflows operational')).toBeInTheDocument()
  })

  it('shows a friendly unavailable state for a dead link', async () => {
    apiFetch.mockRejectedValue(new Error('Not found'))
    renderStatus('gone')
    expect(await screen.findByText(/status page unavailable/i)).toBeInTheDocument()
    expect(screen.getByText(/rotated or taken down/i)).toBeInTheDocument()
  })
})

describe('StatusPageSection (analytics sharing card)', () => {
  it('publishes a page and shows the copyable URL', async () => {
    apiFetch.mockImplementation((path, opts) => {
      if (!opts) return Promise.resolve({ token: null })
      if (opts.method === 'POST') return Promise.resolve({ token: 'fresh-token-1234567890abcd' })
      return Promise.reject(new Error(`unexpected ${path}`))
    })
    render(<StatusPageSection workspaceId="ws1" />)

    fireEvent.click(await screen.findByRole('button', { name: /publish status page/i }))
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/workspaces/ws1/status-page', { method: 'POST' })
    )
    expect(screen.getByTestId('status-page-url').textContent).toContain('/status/fresh-token-1234567890abcd')
    expect(screen.getByRole('button', { name: /rotate link/i })).toBeInTheDocument()
  })

  it('rotates and takes down an existing page', async () => {
    apiFetch.mockImplementation((path, opts) => {
      if (!opts) return Promise.resolve({ token: 'existing-token' })
      if (opts.method === 'POST') return Promise.resolve({ token: 'rotated-token' })
      if (opts.method === 'DELETE') return Promise.resolve({})
      return Promise.reject(new Error(`unexpected ${path}`))
    })
    render(<StatusPageSection workspaceId="ws1" />)

    expect((await screen.findByTestId('status-page-url')).textContent).toContain('existing-token')

    fireEvent.click(screen.getByRole('button', { name: /rotate link/i }))
    await waitFor(() =>
      expect(screen.getByTestId('status-page-url').textContent).toContain('rotated-token')
    )
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/rotated/i))

    fireEvent.click(screen.getByRole('button', { name: /take down/i }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /publish status page/i })).toBeInTheDocument()
    )
  })

  it('surfaces the server refusal for non-owners as a toast', async () => {
    apiFetch.mockImplementation((path, opts) => {
      if (!opts) return Promise.resolve({ token: null })
      return Promise.reject(new Error('Only a workspace owner can manage the status page'))
    })
    render(<StatusPageSection workspaceId="ws1" />)

    fireEvent.click(await screen.findByRole('button', { name: /publish status page/i }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Only a workspace owner can manage the status page')
    )
  })
})
