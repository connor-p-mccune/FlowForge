import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import CanaryPanel from '../components/canvas/CanaryPanel'
import { apiFetch } from '../services/api'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))
vi.mock('../hooks/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}))

const INACTIVE = { workflowId: 'wf-1', active: false }

const RUNNING = {
  workflowId: 'wf-1',
  active: true,
  state: 'running',
  percent: 10,
  auto: true,
  minRuns: 20,
  verdict: 'healthy',
  reason: '40 canary runs with no detectable regression',
  canary: {
    runs: 40,
    failures: 0,
    failureRate: 0,
    failureRateInterval: { point: 0, lower: 0, upper: 0.087 },
    durations: [1000, 1100, 1200],
  },
  stable: {
    runs: 400,
    failures: 8,
    failureRate: 0.02,
    failureRateInterval: { point: 0.02, lower: 0.01, upper: 0.039 },
    durations: [1000, 1050, 1100],
  },
  successTest: { pValue: 0.83, significant: false },
  durationTest: { pValue: 0.44, significant: false },
}

describe('CanaryPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiFetch.mockResolvedValue(INACTIVE)
  })

  it('renders nothing when closed', () => {
    const { container } = render(<CanaryPanel workflowId="wf-1" open={false} onClose={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('offers to start a canary when none is running', async () => {
    render(<CanaryPanel workflowId="wf-1" open onClose={() => {}} />)
    expect(await screen.findByRole('button', { name: 'Start canary' })).toBeInTheDocument()
    expect(screen.getByText(/last deployed version/)).toBeInTheDocument()
  })

  it('starts a canary at the chosen percentage', async () => {
    render(<CanaryPanel workflowId="wf-1" open onClose={() => {}} />)
    const slider = await screen.findByRole('slider')
    fireEvent.change(slider, { target: { value: '25' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start canary' }))
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/workflows/wf-1/canary', {
        method: 'POST',
        body: { percent: 25 },
      })
    )
  })

  it('states which definition each arm is running — the non-obvious part', async () => {
    apiFetch.mockResolvedValue(RUNNING)
    render(<CanaryPanel workflowId="wf-1" open onClose={() => {}} />)
    expect(await screen.findByText(/of runs execute/)).toBeInTheDocument()
    expect(screen.getByText('your canvas')).toBeInTheDocument()
    expect(screen.getByText('deployed version')).toBeInTheDocument()
  })

  it('shows the verdict and both arms’ numbers', async () => {
    apiFetch.mockResolvedValue(RUNNING)
    render(<CanaryPanel workflowId="wf-1" open onClose={() => {}} />)
    expect(await screen.findByText('No regression detected')).toBeInTheDocument()
    expect(screen.getByText('40')).toBeInTheDocument()
    expect(screen.getByText('400')).toBeInTheDocument()
  })

  it('bounds a zero failure rate instead of implying certainty', async () => {
    apiFetch.mockResolvedValue(RUNNING)
    render(<CanaryPanel workflowId="wf-1" open onClose={() => {}} />)
    // 0% failures out of 40 runs still carries its Wilson upper bound.
    expect(await screen.findByText(/≤ 8\.7%/)).toBeInTheDocument()
  })

  it('reports both statistical tests with their p-values', async () => {
    apiFetch.mockResolvedValue(RUNNING)
    render(<CanaryPanel workflowId="wf-1" open onClose={() => {}} />)
    expect(await screen.findByText(/Failure rate: p = 0\.830/)).toBeInTheDocument()
    expect(screen.getByText(/Duration: p = 0\.440/)).toBeInTheDocument()
  })

  it('promotes, rolls back, and ends through the right endpoints', async () => {
    apiFetch.mockResolvedValue(RUNNING)
    render(<CanaryPanel workflowId="wf-1" open onClose={() => {}} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Promote' }))
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/workflows/wf-1/canary/promote', {
        method: 'POST',
        body: undefined,
      })
    )

    fireEvent.click(screen.getByRole('button', { name: 'Roll back' }))
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/workflows/wf-1/canary/rollback', {
        method: 'POST',
        body: {},
      })
    )

    fireEvent.click(screen.getByRole('button', { name: 'End' }))
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/workflows/wf-1/canary', {
        method: 'DELETE',
        body: undefined,
      })
    )
  })

  it('explains a rolled-back canary and that the canvas is intact', async () => {
    apiFetch.mockResolvedValue({
      ...RUNNING,
      state: 'rolled_back',
      percent: 0,
      verdict: 'degraded',
      reason: 'canary failure rate 50.0% vs 2.0% (p = 0.0001)',
    })
    render(<CanaryPanel workflowId="wf-1" open onClose={() => {}} />)
    expect(await screen.findByText('Regression detected')).toBeInTheDocument()
    expect(screen.getByText(/canvas still has the edits/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Roll back' })).toBeDisabled()
  })

  it('says when automation is off, so nobody waits for a promotion that will not come', async () => {
    apiFetch.mockResolvedValue({ ...RUNNING, auto: false })
    render(<CanaryPanel workflowId="wf-1" open onClose={() => {}} />)
    expect(await screen.findByText(/Automation is off/)).toBeInTheDocument()
  })

  it('surfaces a load error rather than rendering an empty panel', async () => {
    apiFetch.mockRejectedValue(new Error('Workflow not found'))
    render(<CanaryPanel workflowId="wf-1" open onClose={() => {}} />)
    expect(await screen.findByText('Workflow not found')).toBeInTheDocument()
  })
})
