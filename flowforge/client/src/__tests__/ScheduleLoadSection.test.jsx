import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

import ScheduleLoadSection from '../components/analytics/ScheduleLoadSection'
import { apiFetch } from '../services/api'

// The charts above this one are about what already happened. This is about what
// is going to — and the bar chart is the argument rather than decoration: a
// peak of five means one thing over an idle day and another over a day that
// already sits at four, and the number alone cannot tell them apart.

const flat = new Array(24).fill(0)
const spike = flat.map((_, h) => (h === 0 ? 5 : 0))

const report = (over = {}) => ({
  available: true,
  workspaceId: 'ws1',
  horizonDays: 7,
  schedules: [],
  peak: {
    concurrent: 5,
    at: '2026-09-03T00:00:00.000Z',
    byHourUtc: spike,
    workflows: [
      {
        workflowId: 'w1',
        name: 'Nightly reconcile',
        cron: '0 0 * * *',
        timeZone: null,
        durationMs: 2400000,
      },
      {
        workflowId: 'w2',
        name: 'Digest',
        cron: '0 0 * * *',
        timeZone: 'Asia/Tokyo',
        durationMs: 1200000,
      },
    ],
    ...over.peak,
  },
  suggestion: {
    workflowId: 'w1',
    name: 'Nightly reconcile',
    minutes: 20,
    peakBefore: 5,
    peakAfter: 3,
  },
  clock: { occurrences: 84, onTheHour: 72, atMidnight: 42, share: 0.857 },
  summary: {
    scheduled: 6,
    occurrences: 84,
    unmeasured: 0,
    lowerBound: false,
    capacity: null,
    overCapacity: null,
    ...over.summary,
  },
  unmeasured: [],
  ...over,
})

const setup = (payload = report()) => {
  apiFetch.mockResolvedValue(payload)
  return render(
    <MemoryRouter>
      <ScheduleLoadSection workspaceId="ws1" />
    </MemoryRouter>
  )
}

beforeEach(() => {
  apiFetch.mockReset()
})

describe('ScheduleLoadSection', () => {
  it('leads with the peak and when it lands', async () => {
    setup()
    expect(await screen.findByText(/At most/)).toBeInTheDocument()
    expect(screen.getByText('5')).toBeInTheDocument()
    expect(screen.getByText(/Thu 03 Sep, 00:00 UTC/)).toBeInTheDocument()
  })

  it('draws twenty-four hours, not just the peak', async () => {
    // The peak alone cannot distinguish a spike from a plateau, and those want
    // opposite responses.
    const { container } = setup()
    await screen.findByText(/At most/)
    expect(container.querySelectorAll('.sched__bar')).toHaveLength(24)
  })

  it('marks the hour the peak falls in so the chart and the headline agree', async () => {
    const { container } = setup()
    await screen.findByText(/At most/)
    const peaks = container.querySelectorAll('.sched__bar--peak')
    expect(peaks).toHaveLength(1)
    expect(container.querySelectorAll('.sched__bar-slot')[0]).toContainElement(peaks[0])
  })

  it('says how much of the schedule lands on a round number', async () => {
    setup()
    expect(
      await screen.findByText(/86% of scheduled runs start on the hour, 42 of them at midnight/)
    ).toBeInTheDocument()
  })

  it('names the one move that flattens the peak', async () => {
    setup()
    expect(await screen.findByText(/20 minutes later would drop the peak from 5 to 3/))
      .toBeInTheDocument()
  })

  it('shows the zone, because three identical crons need not be one instant', async () => {
    setup()
    expect(await screen.findByText('Asia/Tokyo')).toBeInTheDocument()
    expect(screen.getByText('UTC')).toBeInTheDocument()
  })

  it('links a colliding workflow to its canvas', async () => {
    setup()
    expect(await screen.findByRole('link', { name: 'Nightly reconcile' })).toHaveAttribute(
      'href',
      '/workflow/w1'
    )
  })

  it('says the peak is a floor when something was excluded', async () => {
    setup(
      report({
        summary: { unmeasured: 2, lowerBound: true },
        unmeasured: [
          { workflowId: 'w9', name: 'Weekly report', cron: '0 0 * * 1' },
          { workflowId: 'w8', name: 'Quarterly close', cron: '0 0 1 */3 *' },
        ],
      })
    )
    expect(await screen.findByText(/this peak is a floor/)).toBeInTheDocument()
    expect(screen.getByText(/Weekly report, Quarterly close/)).toBeInTheDocument()
  })

  it('tells nothing-scheduled from nothing-measured', async () => {
    const { unmount } = setup({ available: false, reason: 'no-schedules', unmeasured: [] })
    expect(await screen.findByText(/Nothing in this workspace runs on a schedule/)).toBeInTheDocument()
    unmount()

    setup({
      available: false,
      reason: 'nothing-measured',
      unmeasured: [{ workflowId: 'w1', name: 'Never run', cron: '0 0 * * *' }],
    })
    expect(await screen.findByText(/no occupancy to overlap/)).toBeInTheDocument()
  })

  it('reports a failed read rather than an empty chart', async () => {
    // A flat chart would read as "nothing is scheduled", which is the one thing
    // this panel must not say by accident.
    apiFetch.mockRejectedValue(new Error('nope'))
    render(
      <MemoryRouter>
        <ScheduleLoadSection workspaceId="ws1" />
      </MemoryRouter>
    )
    expect(await screen.findByText(/Unable to load — nope/)).toBeInTheDocument()
  })

  it('does not ask the analytics range for a question about the future', async () => {
    // A cron's next week does not depend on how far back you are looking.
    setup()
    await screen.findByText(/At most/)
    expect(apiFetch).toHaveBeenCalledWith('/api/workspaces/ws1/schedule')
  })
})
