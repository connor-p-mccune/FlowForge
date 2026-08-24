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
