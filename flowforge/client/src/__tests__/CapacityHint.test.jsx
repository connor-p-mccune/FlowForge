import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

import CapacityHint from '../components/canvas/CapacityHint'
import { apiFetch } from '../services/api'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

const REPORT = {
  available: true,
  workflowId: 'wf1',
  name: 'Orders',
  cap: 4,
  measured: {
    runs: 336,
    windowDays: 7,
    arrivalsPerHour: 2,
    serviceMeanMs: 1800000,
    cvSquaredService: 1.1,
    cvSquaredArrival: 1,
    observedWaitMeanMs: 4200,
    sampled: { service: 336, wait: 336 },
    peakHour: { ratePerMs: 2 / 3600000, perHour: 2, runs: 2, startedAt: '2026-08-18T09:00:00.000Z' },
    peakDay: { ratePerMs: 2 / 3600000, perHour: 2, runs: 48, startedAt: '2026-08-18T00:00:00.000Z' },
  },
  current: {
    servers: 4,
    stable: true,
    utilisation: 0.5,
    headroom: 2,
    waitMeanMs: 4000,
    waitP95Ms: 15000,
  },
  calibration: { comparable: true, ratio: 0.95, verdict: 'agrees' },
  peak: {
    hour: { servers: 4, stable: true, utilisation: 0.5, headroom: 2, waitMeanMs: 4000, waitP95Ms: 15000 },
    day: { servers: 4, stable: true, utilisation: 0.5, headroom: 2, waitMeanMs: 4000, waitP95Ms: 15000 },
  },
  peakRecommendation: null,
  curve: [],
  recommendation: null,
  model: { name: 'Allen–Cunneen G/G/c', variabilityFactor: 1.05, mmcWaitMeanMs: 3800 },
}

const hint = (props = {}) => render(<CapacityHint workflowId="wf1" cap="4" {...props} />)

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('CapacityHint', () => {
  it('says what the cap buys, in the terms somebody is choosing it in', async () => {
    apiFetch.mockResolvedValue(REPORT)
    hint()
    vi.advanceTimersByTime(600)
    expect(await screen.findByText(/mean wait/)).toBeInTheDocument()
    expect(screen.getByText('4.0s')).toBeInTheDocument()
    expect(screen.getByText('2.0×')).toBeInTheDocument()
  })

  it('asks about the cap being typed, not the one that was saved', async () => {
    apiFetch.mockResolvedValue({ ...REPORT, cap: 9 })
    hint({ cap: '9' })
    vi.advanceTimersByTime(600)
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/workflows/wf1/capacity?cap=9'))
  })

  it('debounces, so a number field does not fire a request per keystroke', async () => {
    apiFetch.mockResolvedValue(REPORT)
    const { rerender } = hint({ cap: '1' })
    rerender(<CapacityHint workflowId="wf1" cap="12" />)
    vi.advanceTimersByTime(200)
    expect(apiFetch).not.toHaveBeenCalled()
    vi.advanceTimersByTime(600)
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1))
    expect(apiFetch).toHaveBeenCalledWith('/api/workflows/wf1/capacity?cap=12')
  })

  it('says plainly when the cap cannot keep up, rather than quoting a wait', async () => {
    apiFetch.mockResolvedValue({
      ...REPORT,
      current: { ...REPORT.current, stable: false, utilisation: 1.4, waitMeanMs: null },
    })
    hint()
    vi.advanceTimersByTime(600)
    expect(await screen.findByText(/cannot keep up/)).toBeInTheDocument()
    expect(screen.getByText(/backlog would grow without bound/)).toBeInTheDocument()
  })

  it('flags a cap with barely any headroom', async () => {
    apiFetch.mockResolvedValue({
      ...REPORT,
      current: { ...REPORT.current, headroom: 1.1, utilisation: 0.9 },
    })
    const { container } = hint()
    vi.advanceTimersByTime(600)
    await screen.findByText(/mean wait/)
    expect(container.querySelector('.capacity-hint--tight')).toBeTruthy()
  })

  it('attaches the caveat when the model failed its own check', async () => {
    apiFetch.mockResolvedValue({
      ...REPORT,
      calibration: { comparable: true, ratio: 0.2, verdict: 'under-predicts' },
    })
    hint()
    vi.advanceTimersByTime(600)
    expect(
      await screen.findByText(/something outside the queue is holding them up/)
    ).toBeInTheDocument()
  })

  it('explains too little history, since that is the one worth explaining', async () => {
    apiFetch.mockResolvedValue({
      available: false, reason: 'not-enough-runs', runs: 4, needed: 30, windowDays: 7,
    })
    hint()
    vi.advanceTimersByTime(600)
    expect(await screen.findByText(/4 runs in the last 7 days, 30 needed/)).toBeInTheDocument()
  })

  it('says nothing at all for a workflow with no cap', async () => {
    apiFetch.mockResolvedValue({ available: false, reason: 'no-cap' })
    const { container } = hint()
    vi.advanceTimersByTime(600)
    await waitFor(() => expect(apiFetch).toHaveBeenCalled())
    expect(container.querySelector('.capacity-hint')).toBeNull()
  })

  it('asks nothing while the field is empty', async () => {
    hint({ cap: '' })
    vi.advanceTimersByTime(600)
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('never blocks the form when the request fails', async () => {
    apiFetch.mockRejectedValue(new Error('offline'))
    const { container } = hint()
    vi.advanceTimersByTime(600)
    await waitFor(() => expect(apiFetch).toHaveBeenCalled())
    expect(container.querySelector('.capacity-hint')).toBeNull()
  })
})

// The mean is what the field is usually chosen against, and the peak is what
// actually breaks. Worth a sentence only when it says something the mean did
// not — a hint that always printed two numbers would train somebody to read one.
describe('CapacityHint — the busiest hour', () => {
  const bursty = (over = {}) => ({
    ...REPORT,
    measured: {
      ...REPORT.measured,
      peakHour: { ratePerMs: 60 / 3600000, perHour: 60, runs: 60, startedAt: '2026-08-18T09:00:00.000Z' },
    },
    peak: {
      ...REPORT.peak,
      hour: {
        servers: 4, stable: false, utilisation: 7.5, headroom: 0.13,
        waitMeanMs: null, waitP95Ms: null, ...over,
      },
    },
  })

  it('warns when a cap that is fine on average cannot absorb the peak', async () => {
    apiFetch.mockResolvedValue(bursty())
    hint()
    vi.advanceTimersByTime(600)
    expect(await screen.findByText(/mean wait/)).toBeInTheDocument()
    expect(screen.getByText(/At its busiest hour \(60 runs\/hour\) this cap cannot keep up/))
      .toBeInTheDocument()
  })

  it('quotes the wait at a peak the cap does survive', async () => {
    apiFetch.mockResolvedValue(
      bursty({ stable: true, utilisation: 0.9, headroom: 1.11, waitMeanMs: 45000 })
    )
    hint()
    vi.advanceTimersByTime(600)
    expect(await screen.findByText(/At its busiest hour \(60 runs\/hour\) that becomes a 45.0s wait/))
      .toBeInTheDocument()
  })

  it('stays quiet when the peak barely differs from the mean', async () => {
    apiFetch.mockResolvedValue(REPORT)
    hint()
    vi.advanceTimersByTime(600)
    await screen.findByText(/mean wait/)
    expect(screen.queryByText(/busiest hour/)).not.toBeInTheDocument()
  })
})

// A sub-workflow call runs inside the caller's slot and never queues here. The
// hint sits beside the field where the number is typed, which makes it the one
// place where "this number governs a tenth of the traffic" has to be said.
describe('CapacityHint - traffic the cap does not govern', () => {
  const governed = (over) => ({
    ...REPORT,
    governance: { governed: 336, called: 3000, share: 0.101, callers: [], ...over },
  })

  it('says what share of the traffic the quoted wait describes', async () => {
    apiFetch.mockResolvedValue(
      governed({ callers: [{ workflowId: 'wf2', name: 'Order webhook' }] })
    )
    hint()
    vi.advanceTimersByTime(600)
    expect(
      await screen.findByText(/describes 10% of the runs reaching this workflow/)
    ).toBeInTheDocument()
    expect(screen.getByText(/from Order webhook/)).toBeInTheDocument()
  })

  it('stays quiet when the cap governs everything', async () => {
    apiFetch.mockResolvedValue(governed({ called: 0, share: 1 }))
    hint()
    vi.advanceTimersByTime(600)
    await screen.findByText(/mean wait/)
    expect(screen.queryByText(/never queue here/)).not.toBeInTheDocument()
  })

  it('counts the callers rather than listing them once there are too many', async () => {
    apiFetch.mockResolvedValue(
      governed({ callers: [1, 2, 3, 4].map((n) => ({ workflowId: `w${n}`, name: `C${n}` })) })
    )
    hint()
    vi.advanceTimersByTime(600)
    expect(await screen.findByText(/from 4 other workflows/)).toBeInTheDocument()
  })

  it('says the field barely matters rather than asking for more history', async () => {
    // "Not enough runs" would send somebody to wait for traffic that is
    // already arriving and simply bypassing this number.
    apiFetch.mockResolvedValue({
      available: false,
      reason: 'not-governed',
      runs: 2,
      needed: 30,
      windowDays: 7,
      governance: {
        governed: 2,
        called: 400,
        share: 0.005,
        callers: [{ workflowId: 'wf2', name: 'Orders' }],
      },
    })
    hint()
    vi.advanceTimersByTime(600)
    expect(
      await screen.findByText(/This cap governs almost none of the traffic/)
    ).toBeInTheDocument()
    expect(screen.getByText(/it never queues here/)).toBeInTheDocument()
    expect(screen.queryByText(/Not enough history/)).not.toBeInTheDocument()
  })
})
