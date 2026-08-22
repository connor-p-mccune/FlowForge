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
const NO_DRIFT = { workflowId: 'wf1', available: false, reason: 'not-found' }

function mockByPath({
  insights = BUNDLE,
  forecast = FORECAST,
  regressions = REGRESSIONS,
  drift = NO_DRIFT,
} = {}) {
  apiFetch.mockImplementation((path) => {
    if (path.endsWith('/forecast')) return Promise.resolve(forecast)
    if (path.endsWith('/drift')) return Promise.resolve(drift)
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

// The forecast is a longest path — the duration with a slot always free. The
// engine has EXEC_MAX_PARALLEL of them, so for a wide graph the two disagree,
// and the difference is time the canvas cannot account for.
describe('InsightsPanel — concurrency', () => {
  const CONTENDED = {
    ...FORECAST,
    concurrency: {
      cap: 2,
      makespanMs: 4000,
      makespanP95Ms: 6000,
      queuedMs: 4000,
      contention: 2,
      averageParallelism: 4,
      knee: { cap: 4, makespanMs: 2000, idealMakespanMs: 2000 },
      curve: [
        { cap: 1, makespanMs: 8000 },
        { cap: 2, makespanMs: 4000 },
        { cap: 4, makespanMs: 2000 },
      ],
      chain: [{ nodeId: 'http-1', waitedFor: 'slot', queuedMs: 2000, durationMs: 2000 }],
    },
  }

  it('reports the makespan under the cap beside the critical path', async () => {
    mockByPath({ forecast: CONTENDED })
    setup()
    expect(await screen.findByText(/Concurrency · 2 slots/)).toBeInTheDocument()
    expect(screen.getByText('4.0s')).toBeInTheDocument()
    expect(screen.getByText(/2\.00× the critical path/)).toBeInTheDocument()
  })

  it('names the queueing, the ceiling, and the knee', async () => {
    mockByPath({ forecast: CONTENDED })
    setup()
    expect(await screen.findByText(/4\.0s spent waiting for a slot/)).toBeInTheDocument()
    expect(screen.getByText(/can use 4\.0 slots at most/)).toBeInTheDocument()
    expect(screen.getByText(/4 slots would reach 2\.0s/)).toBeInTheDocument()
  })

  it('names the node whose wait the graph does not explain, by label', async () => {
    mockByPath({ forecast: CONTENDED })
    setup()
    await screen.findByText(/Concurrency · 2 slots/)
    expect(screen.getByText(/waits 2\.0s for\s+capacity, not for data/)).toBeInTheDocument()
    // Labelled, not identified by node id.
    expect(screen.getAllByText('Fetch orders').length).toBeGreaterThan(0)
  })

  it('draws the curve with the current cap marked', async () => {
    mockByPath({ forecast: CONTENDED })
    const { container } = setup()
    await screen.findByText(/Concurrency · 2 slots/)
    const curve = container.querySelector('svg[aria-label*="execution slots"]')
    expect(curve).toBeTruthy()
    expect(curve.querySelectorAll('circle')).toHaveLength(1)
  })

  it('stays silent when the cap costs the workflow nothing', async () => {
    mockByPath({
      forecast: {
        ...CONTENDED,
        concurrency: { ...CONTENDED.concurrency, contention: 1, queuedMs: 0 },
      },
    })
    setup()
    await screen.findByText('93.1%')
    expect(screen.queryByText(/Concurrency ·/)).not.toBeInTheDocument()
  })

  it('stays silent for a server that sends no concurrency block', async () => {
    mockByPath({ forecast: FORECAST })
    setup()
    await screen.findByText('93.1%')
    expect(screen.queryByText(/Concurrency ·/)).not.toBeInTheDocument()
  })
})

// The only section in this panel about the *data* rather than the run. It
// catches the failure the rest are blind to: every run completes, every step
// succeeds, every duration is unchanged, and a field stopped arriving.
describe('InsightsPanel — output drift', () => {
  const DRIFTED = {
    workflowId: 'wf1',
    available: true,
    monitoring: false,
    window: { recent: { runs: 50 }, baseline: { runs: 200 } },
    summary: { major: 1, minor: 1, nodesCompared: 2, nodesSkipped: 0, fieldsCompared: 14, fieldsSkipped: 3 },
    nodes: [
      {
        nodeId: 'http-1',
        nodeLabel: 'Fetch orders',
        nodeType: 'action-http',
        compared: 9,
        skipped: [],
        findings: [
          {
            nodeId: 'http-1',
            path: 'customer.email',
            kind: 'null-rate',
            severity: 'major',
            summary: 'customer.email is null in 41.0% of records, was 0.2%',
            detail: { test: 'two-proportion' },
          },
        ],
      },
      { nodeId: 'log-1', nodeLabel: 'Log result', nodeType: 'output-log', compared: 5, skipped: [], findings: [] },
    ],
  }

  // The node label also appears in "slowest steps" and the forecast's
  // bottleneck line, so these scope to the drift section rather than the
  // document — otherwise a passing assertion would prove nothing.
  const driftNodeNames = (container) =>
    [...container.querySelectorAll('.insights__drift-node-name')].map((el) => el.textContent)

  it('names the field, the node, and both sides of the change', async () => {
    mockByPath({ drift: DRIFTED })
    const { container } = setup()
    expect(await screen.findByText('customer.email')).toBeInTheDocument()
    expect(screen.getByText(/null in 41\.0% of records, was 0\.2%/)).toBeInTheDocument()
    expect(driftNodeNames(container)).toEqual(['Fetch orders'])
  })

  it('reports the windows compared and what it had to skip', async () => {
    mockByPath({ drift: DRIFTED })
    setup()
    expect(await screen.findByText(/Last 50 runs vs the 200 before them/)).toBeInTheDocument()
    expect(screen.getByText(/14 fields compared, 3 skipped/)).toBeInTheDocument()
  })

  it('marks severity without shouting about a minor finding', async () => {
    mockByPath({ drift: DRIFTED })
    const { container } = setup()
    await screen.findByText('customer.email')
    expect(container.querySelectorAll('.drift--major')).toHaveLength(1)
    expect(container.querySelectorAll('.drift--minor')).toHaveLength(0)
  })

  it('omits a node with nothing to report', async () => {
    mockByPath({ drift: DRIFTED })
    const { container } = setup()
    await screen.findByText('customer.email')
    expect(driftNodeNames(container)).not.toContain('Log result')
  })

  it('points at the setting when alerting is off and something drifted', async () => {
    mockByPath({ drift: DRIFTED })
    setup()
    expect(await screen.findByText(/Turn on/)).toBeInTheDocument()
  })

  it('says nothing changed rather than showing an empty section', async () => {
    mockByPath({
      drift: { ...DRIFTED, monitoring: true, summary: { ...DRIFTED.summary, major: 0, minor: 0 }, nodes: [] },
    })
    setup()
    expect(await screen.findByText(/No change in what this workflow produces/)).toBeInTheDocument()
  })

  it('says how much more history it needs', async () => {
    mockByPath({
      drift: { workflowId: 'wf1', available: false, reason: 'insufficient-history', needed: 30, have: 8 },
    })
    setup()
    expect(await screen.findByText(/Needs 30 completed runs/)).toBeInTheDocument()
  })

  it('renders the rest of the panel when drift is unavailable', async () => {
    mockByPath({ drift: NO_DRIFT })
    setup()
    expect(await screen.findByText('93.1%')).toBeInTheDocument()
    expect(screen.queryByText('Output drift')).not.toBeInTheDocument()
  })
})
