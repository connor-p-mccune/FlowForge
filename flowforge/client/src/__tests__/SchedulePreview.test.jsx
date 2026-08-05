import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

// Mock the API module for this file only, so the schedule preview's debounced
// POST /api/schedule/preview is observable without a real server.
vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

import NodeConfigPanel from '../components/canvas/NodeConfigPanel'
import { apiFetch } from '../services/api'

const scheduleNode = (cron, timezone) => ({
  id: 'n1',
  type: 'trigger-schedule',
  data: { label: 'Schedule', config: { cron, ...(timezone ? { timezone } : {}) } },
})

function setup(node) {
  return render(
    <NodeConfigPanel node={node} onChange={vi.fn()} onClose={vi.fn()} onDelete={vi.fn()} />
  )
}

describe('SchedulePreview (next-run times under the cron field)', () => {
  beforeEach(() => {
    apiFetch.mockReset()
  })

  it('fetches and renders the upcoming fire times for a valid cron', async () => {
    apiFetch.mockResolvedValue({
      cron: '0 9 * * *',
      reachable: true,
      nextRuns: ['2026-01-15T09:00:00.000Z', '2026-01-16T09:00:00.000Z'],
    })
    setup(scheduleNode('0 9 * * *'))

    // The preview debounces then posts the expression to the preview endpoint.
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/schedule/preview',
        expect.objectContaining({ method: 'POST', body: { cron: '0 9 * * *', count: 3 } })
      )
    )
    expect(await screen.findByText(/Jan 15, 09:00 UTC/)).toBeInTheDocument()
    expect(screen.getByText(/Jan 16, 09:00 UTC/)).toBeInTheDocument()
  })

  it('shows a "never fires" note for a valid but unreachable schedule', async () => {
    apiFetch.mockResolvedValue({ cron: '0 0 30 2 *', reachable: false, nextRuns: [] })
    setup(scheduleNode('0 0 30 2 *'))
    expect(await screen.findByText(/never fires/i)).toBeInTheDocument()
  })

  it('does not call the preview endpoint for a blank expression', async () => {
    setup(scheduleNode(''))
    // Give the debounce window a chance to (not) fire.
    await new Promise((r) => setTimeout(r, 500))
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('sends the node’s time zone and renders local time with its offset', async () => {
    apiFetch.mockResolvedValue({
      cron: '0 9 * * *',
      timeZone: 'America/New_York',
      reachable: true,
      nextRuns: ['2026-01-15T14:00:00.000Z'],
      nextRunsLocal: [
        { utc: '2026-01-15T14:00:00.000Z', local: '2026-01-15 09:00', offset: 'UTC-05:00' },
      ],
    })
    setup(scheduleNode('0 9 * * *', 'America/New_York'))

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/schedule/preview',
        expect.objectContaining({
          body: { cron: '0 9 * * *', count: 3, timezone: 'America/New_York' },
        })
      )
    )
    expect(await screen.findByText(/2026-01-15 09:00 UTC-05:00/)).toBeInTheDocument()
  })

  it('flags a daylight-saving change falling inside the previewed runs', async () => {
    // Same local hour, two different offsets — the schedule holding, not
    // drifting. Without the note the shifting UTC column reads as a bug.
    apiFetch.mockResolvedValue({
      cron: '0 9 * * *',
      timeZone: 'America/New_York',
      reachable: true,
      nextRuns: ['2026-03-07T14:00:00.000Z', '2026-03-08T13:00:00.000Z'],
      nextRunsLocal: [
        { utc: '2026-03-07T14:00:00.000Z', local: '2026-03-07 09:00', offset: 'UTC-05:00' },
        { utc: '2026-03-08T13:00:00.000Z', local: '2026-03-08 09:00', offset: 'UTC-04:00' },
      ],
    })
    setup(scheduleNode('0 9 * * *', 'America/New_York'))
    expect(await screen.findByText(/daylight-saving change/i)).toBeInTheDocument()
  })

  it('does not flag anything when every previewed run shares an offset', async () => {
    apiFetch.mockResolvedValue({
      cron: '0 9 * * *',
      timeZone: 'America/New_York',
      reachable: true,
      nextRuns: ['2026-01-15T14:00:00.000Z', '2026-01-16T14:00:00.000Z'],
      nextRunsLocal: [
        { utc: '2026-01-15T14:00:00.000Z', local: '2026-01-15 09:00', offset: 'UTC-05:00' },
        { utc: '2026-01-16T14:00:00.000Z', local: '2026-01-16 09:00', offset: 'UTC-05:00' },
      ],
    })
    setup(scheduleNode('0 9 * * *', 'America/New_York'))
    expect(await screen.findByText(/2026-01-15 09:00/)).toBeInTheDocument()
    expect(screen.queryByText(/daylight-saving change/i)).not.toBeInTheDocument()
  })
})
