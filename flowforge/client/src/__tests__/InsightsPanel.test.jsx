import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

import InsightsPanel from '../components/canvas/InsightsPanel'
import { apiFetch } from '../services/api'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

const NODES = [
  { id: 'http-1', data: { label: 'Fetch orders' } },
  { id: 'log-1', data: { label: 'Log result' } },
]

const BUNDLE = {
  workflowId: 'wf1',
  window: { limit: 50, runs: 30, since: '2026-07-01', until: '2026-07-09' },
  counts: { total: 30, completed: 27, failed: 2, cancelled: 1, running: 0 },
  successRate: 27 / 29,
  sla: { maxDurationMs: 1500, minSuccessRate: 0.95, durationCompliant: false, successRateCompliant: true },
  throughput: { runs: 30, spanDays: 8, perDay: 3.75 },
  duration: { count: 27, min: 900, max: 20000, mean: 1200, stdev: 300, p50: 1000, p90: 1300, p95: 1800, p99: 3000 },
  trend: { direction: 'degrading', significant: true, tau: 0.42, z: 3.1, samples: 27, method: 'mann-kendall' },
  anomalyCount: 1,
  slowestSteps: [
    { nodeId: 'http-1', nodeType: 'action-http', runs: 27, avgDurationMs: 800, maxDurationMs: 1900 },
    { nodeId: 'log-1', nodeType: 'output-log', runs: 27, avgDurationMs: 5, maxDurationMs: 20 },
  ],
  recentRuns: [
    { id: 'r1', status: 'completed', durationMs: 20000, anomalyScore: 40, severity: 'severe', isAnomaly: true },
    { id: 'r2', status: 'completed', durationMs: 1000, anomalyScore: 0.1, severity: 'normal', isAnomaly: false },
    { id: 'r3', status: 'completed', durationMs: 1050, anomalyScore: 0.2, severity: 'normal', isAnomaly: false },
  ],
}

const FORECAST = {
  workflowId: 'wf1',
  available: true,
  criticalPath: ['t', 'http-1', 'log-1'],
  estimatedMs: 1350,
  estimatedP95Ms: 2100,
  bottleneck: { nodeId: 'http-1', nodeType: 'action-http', p50: 800, p95: 1900 },
  coverage: { nodesWithHistory: 2, workNodes: 2, ratio: 1 },
}

const REGRESSIONS = {
  workflowId: 'wf1',
  ok: false,
  analysed: true,
  runs: 60,
  changePoints: [
    {
      at: '2026-07-05T09:00:00.000Z',
      previousAt: '2026-07-05T08:00:00.000Z',
      direction: 'worse',
      pValue: 0.0004,
      before: { median: 210, runs: 30 },
      after: { median: 970, runs: 30 },
      delta: 760,
      ratio: 4.62,
      cause: 'deploy',
      deploys: [
        {
          version: 7,
          createdAt: '2026-07-05T08:20:00.000Z',
          createdBy: 'Ada',
          changed: {
            changedNodes: [{ nodeId: 'http-1', label: 'Fetch orders', changes: ['config.url'] }],
            addedNodes: [],
            removedNodes: [],
          },
        },
      ],
      steps: [{ nodeId: 'http-1', nodeType: 'action-http', before: 90, after: 850, delta: 760 }],
    },
  ],
}

// Resolve insights, forecast, and regressions to their own payloads; the panel
// fetches all three independently so one being unavailable hides only itself.
function mockByPath({ insights = BUNDLE, forecast = FORECAST, regressions = REGRESSIONS } = {}) {
  apiFetch.mockImplementation((path) => {
    if (path.endsWith('/forecast')) return Promise.resolve(forecast)
    if (path.endsWith('/regressions')) {
      return regressions instanceof Error
        ? Promise.reject(regressions)
        : Promise.resolve(regressions)
    }
    return Promise.resolve(insights)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

function setup(props = {}) {
  return render(
    <InsightsPanel workflowId="wf1" open onClose={props.onClose || vi.fn()} nodes={NODES} {...props} />
  )
}

describe('InsightsPanel', () => {
  it('renders nothing while closed and makes no request', () => {
    const { container } = render(<InsightsPanel workflowId="wf1" open={false} onClose={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('fetches and renders the headline stats and percentiles', async () => {
    apiFetch.mockResolvedValue(BUNDLE)
    setup()
    await waitFor(() => expect(screen.getByText('93.1%')).toBeInTheDocument()) // 27/29 success
    expect(apiFetch).toHaveBeenCalledWith('/api/workflows/wf1/insights')
    expect(screen.getByText('3.75')).toBeInTheDocument() // runs/day
    // Percentiles rendered in friendly units.
    expect(screen.getByText('P95')).toBeInTheDocument()
    expect(screen.getByText('1.8s')).toBeInTheDocument()
  })

  it('shows the anomaly count and marks the sparkline', async () => {
    apiFetch.mockResolvedValue(BUNDLE)
    const { container } = setup()
    await screen.findByText('93.1%')
    expect(screen.getByText('Anomalies')).toBeInTheDocument()
    // One anomalous run → one red dot on the sparkline.
    const dots = container.querySelectorAll('circle')
    expect(dots).toHaveLength(1)
  })

  it('shows a degrading trend indicator', async () => {
    apiFetch.mockResolvedValue(BUNDLE)
    setup()
    expect(await screen.findByText(/slower over time/i)).toBeInTheDocument()
  })

  it('shows a steady indicator for a flat trend', async () => {
    apiFetch.mockResolvedValue({ ...BUNDLE, trend: { direction: 'flat', significant: false, tau: 0.02, z: 0.3, samples: 27, method: 'mann-kendall' } })
    setup()
    expect(await screen.findByText(/steady/i)).toBeInTheDocument()
  })

  it('renders the SLA scorecard, flagging the breached target', async () => {
    apiFetch.mockResolvedValue(BUNDLE)
    setup()
    await screen.findByText('93.1%')
    const breach = screen.getByText(/p95 ≤/i).closest('li')
    expect(breach.className).toMatch(/breach/)
    const met = screen.getByText(/success ≥/i).closest('li')
    expect(met.className).toMatch(/ok/)
  })

  it('lists the slowest steps by their node label', async () => {
    apiFetch.mockResolvedValue(BUNDLE)
    setup()
    await screen.findByText('93.1%')
    expect(screen.getByText('Fetch orders')).toBeInTheDocument()
    expect(screen.getByText('Log result')).toBeInTheDocument()
  })

  it('renders the forecast section with the estimate and bottleneck', async () => {
    mockByPath()
    const { container } = setup()
    await screen.findByText('93.1%')
    expect(screen.getByText(/Forecast · next run/i)).toBeInTheDocument()
    expect(screen.getByText('1.4s')).toBeInTheDocument() // estimatedMs 1350
    expect(screen.getByText(/at p95/i)).toBeInTheDocument()
    // Bottleneck resolved to its node label, scoped to its own row.
    const bottleneck = container.querySelector('.insights__forecast-bottleneck')
    expect(bottleneck.textContent).toMatch(/Fetch orders/)
    expect(bottleneck.textContent).toMatch(/800ms/)
  })

  it('hides the forecast when it is unavailable', async () => {
    mockByPath({ forecast: { available: false, reason: 'cycle' } })
    setup()
    await screen.findByText('93.1%')
    expect(screen.queryByText(/Forecast · next run/i)).not.toBeInTheDocument()
  })

  it('shows an empty state for a workflow with no runs', async () => {
    apiFetch.mockResolvedValue({ ...BUNDLE, window: { ...BUNDLE.window, runs: 0 } })
    setup()
    expect(await screen.findByText(/No runs yet/i)).toBeInTheDocument()
  })

  it('names the step change and the deploy that landed with it', async () => {
    mockByPath()
    setup()
    expect(await screen.findByText(/What changed, and when/i)).toBeInTheDocument()
    expect(screen.getByText('210ms → 970ms')).toBeInTheDocument()
    expect(screen.getByText(/4\.6× slower/)).toBeInTheDocument()
    expect(screen.getByText(/Version 7/)).toBeInTheDocument()
    expect(screen.getByText(/changed Fetch orders \(config\.url\)/)).toBeInTheDocument()
    // The step that moved is resolved to its label, like the bottleneck row.
    expect(screen.getByText(/Fetch orders: 90ms → 850ms/)).toBeInTheDocument()
  })

  it('says nothing was deployed when nothing was — the finding, not a blank', async () => {
    mockByPath({
      regressions: {
        ...REGRESSIONS,
        changePoints: [{ ...REGRESSIONS.changePoints[0], cause: 'external', deploys: [] }],
      },
    })
    setup()
    expect(await screen.findByText(/Nothing was deployed in this window/i)).toBeInTheDocument()
  })

  it('hides the section for a workflow with no detected change', async () => {
    mockByPath({ regressions: { ...REGRESSIONS, analysed: true, changePoints: [] } })
    setup()
    await screen.findByText('93.1%')
    expect(screen.queryByText(/What changed, and when/i)).not.toBeInTheDocument()
  })

  it('still renders the rest of the panel when change detection is unavailable', async () => {
    mockByPath({ regressions: new Error('nope') })
    setup()
    expect(await screen.findByText('93.1%')).toBeInTheDocument()
    expect(screen.queryByText(/What changed, and when/i)).not.toBeInTheDocument()
  })

  it('surfaces a fetch error', async () => {
    apiFetch.mockRejectedValue(new Error('Workflow not found'))
    setup()
    expect(await screen.findByText('Workflow not found')).toBeInTheDocument()
  })
})
