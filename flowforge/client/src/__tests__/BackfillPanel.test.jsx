import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

import BackfillPanel from '../components/canvas/BackfillPanel'
import { ToastProvider } from '../hooks/useToast'
import { apiFetch } from '../services/api'

const PLAN = {
  cron: '0 9 * * *',
  timeZone: 'UTC',
  from: '2026-03-01T00:00:00.000Z',
  to: '2026-03-04T00:00:00.000Z',
  total: 3,
  skipped: 1,
  willRun: 2,
  occurrences: [
    { logicalDate: '2026-03-01T09:00:00.000Z', alreadyRan: true },
    { logicalDate: '2026-03-02T09:00:00.000Z', alreadyRan: false },
    { logicalDate: '2026-03-03T09:00:00.000Z', alreadyRan: false },
  ],
}

function mockApi({ plan = PLAN, batches = [], submit } = {}) {
  apiFetch.mockImplementation((url, options) => {
    if (url.includes('/backfills')) return Promise.resolve({ backfills: batches })
    if (options?.body?.preview) return Promise.resolve(plan)
    return Promise.resolve(
      submit || { backfillId: 'bf-1', created: 2, skipped: 1, priority: 'low' }
    )
  })
}

const setup = () =>
  render(
    <ToastProvider>
      <BackfillPanel workflowId="wf1" open onClose={vi.fn()} />
    </ToastProvider>
  )

describe('BackfillPanel', () => {
  beforeEach(() => {
    // Block body on purpose: mockReset() returns the mock, and an expression
    // body would hand it back to Vitest, which calls a returned function as a
    // teardown hook — invoking apiFetch() with no arguments after every test.
    apiFetch.mockReset()
  })

  it('does not offer to run anything before a plan exists', async () => {
    // Nobody should be able to create runs for a window whose size they have
    // not seen — the whole panel is arranged around that rule.
    mockApi()
    setup()
    // findBy* rather than getBy*: the panel loads its batch history on mount,
    // and asserting before that settles is what produces an act() warning.
    expect(await screen.findByRole('button', { name: /Run backfill/ })).toBeDisabled()
  })

  it('previews the window and shows the count prominently', async () => {
    mockApi()
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))

    expect(await screen.findByText(/2 runs/)).toBeInTheDocument()
    expect(screen.getByText(/from 3 occurrences · 1 already ran/)).toBeInTheDocument()
    expect(screen.getByText(/0 9 \* \* \* \[UTC\]/)).toBeInTheDocument()
    // Occurrences that already ran are shown, but struck through and tagged.
    expect(screen.getByText('already ran')).toBeInTheDocument()
  })

  it('enables submitting only after a preview, and sends the same window', async () => {
    mockApi()
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    const submit = await screen.findByRole('button', { name: /Run 2 backfill/ })
    expect(submit).toBeEnabled()

    fireEvent.click(submit)
    await waitFor(() => {
      const call = apiFetch.mock.calls.find(
        ([, opts]) => opts?.method === 'POST' && !opts?.body?.preview
      )
      expect(call).toBeTruthy()
      expect(call[1].body.skipExisting).toBe(true)
      expect(call[1].body.from).toMatch(/Z$/)
    })
  })

  it('invalidates the plan when the window changes', async () => {
    // A stale count sitting next to new dates is exactly how someone submits a
    // range they never previewed.
    mockApi()
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await screen.findByText(/2 runs/)

    fireEvent.change(screen.getByLabelText('Backfill window start'), {
      target: { value: '2026-01-01T00:00' },
    })
    expect(screen.queryByText(/2 runs/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Run backfill/ })).toBeDisabled()
  })

  it('surfaces a planning error instead of a count', async () => {
    apiFetch.mockImplementation((url) => {
      if (url.includes('/backfills')) return Promise.resolve({ backfills: [] })
      return Promise.reject(new Error('That window would create more than 1000 runs.'))
    })
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(await screen.findByText(/more than 1000 runs/)).toBeInTheDocument()
  })

  it('shows batch progress and offers to stop an unfinished one', async () => {
    mockApi({
      batches: [
        {
          backfillId: 'bf-9',
          total: 10,
          completed: 4,
          failed: 1,
          cancelled: 0,
          active: 5,
          firstLogicalDate: '2026-03-01T09:00:00.000Z',
          lastLogicalDate: '2026-03-10T09:00:00.000Z',
          submittedAt: '2026-03-11T00:00:00.000Z',
        },
      ],
    })
    setup()
    expect(await screen.findByText(/5\/10 settled/)).toBeInTheDocument()
    expect(screen.getByText(/1 failed/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
  })

  it('hides the stop control once a batch has fully settled', async () => {
    mockApi({
      batches: [
        {
          backfillId: 'bf-8',
          total: 3,
          completed: 3,
          failed: 0,
          cancelled: 0,
          active: 0,
          firstLogicalDate: '2026-03-01T09:00:00.000Z',
          lastLogicalDate: '2026-03-03T09:00:00.000Z',
          submittedAt: '2026-03-04T00:00:00.000Z',
        },
      ],
    })
    setup()
    expect(await screen.findByText(/3\/3 settled/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
  })
})
