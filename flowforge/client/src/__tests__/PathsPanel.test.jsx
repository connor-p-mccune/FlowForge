import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import PathsPanel from '../components/canvas/PathsPanel'
import { apiFetch } from '../services/api'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

const NODES = [
  { id: 'hook', type: 'trigger-webhook', position: { x: 0, y: 0 }, data: { label: 'Order webhook' } },
  { id: 'route', type: 'switch', position: { x: 0, y: 0 }, data: { label: 'Route' } },
  { id: 'a', type: 'output-log', position: { x: 0, y: 0 }, data: { label: 'Refund path' } },
]
const EDGES = [
  { id: 'e1', source: 'hook', target: 'route' },
  { id: 'e2', source: 'route', target: 'a', sourceHandle: 'refund' },
]

const branch = (outcome, extra = {}) => ({
  nodeId: 'route',
  label: 'Route',
  nodeType: 'switch',
  outcome,
  wired: 1,
  status: 'reachable',
  witness: { triggerData: { kind: outcome }, assumptions: [] },
  generatable: true,
  blockers: [],
  conflict: null,
  ...extra,
})

const CLEAN = {
  analysed: true,
  truncated: false,
  branches: [branch('refund'), branch('order')],
  findings: [],
  scenarios: [],
  coverage: { branches: 2, reachable: 2, generatable: 2 },
}

const DEAD = {
  ...CLEAN,
  branches: [
    branch('wide'),
    branch('narrow', {
      status: 'unreachable',
      witness: null,
      generatable: false,
      conflict: ['Route → wide'],
    }),
  ],
  findings: [{ severity: 'error', code: 'unreachable-branch', message: 'dead', nodeId: 'route' }],
  coverage: { branches: 2, reachable: 1, generatable: 1 },
}

const GATED = {
  ...CLEAN,
  branches: [
    branch('true'),
    branch('false', {
      generatable: false,
      blockers: ['test mode always takes the other side of Approve'],
    }),
  ],
  coverage: { branches: 2, reachable: 2, generatable: 1 },
}

function renderPanel(report, props = {}) {
  apiFetch.mockImplementation((url) => {
    if (url.endsWith('/paths')) return Promise.resolve(report)
    return Promise.resolve({ created: 2, updated: 0, uncovered: [], tests: [] })
  })
  return render(
    <PathsPanel
      workflowId="wf-1"
      nodes={NODES}
      edges={EDGES}
      onClose={() => {}}
      onSelectNode={() => {}}
      {...props}
    />
  )
}

beforeEach(() => {
  apiFetch.mockReset()
})

describe('PathsPanel', () => {
  it('analyses the canvas on screen, not the saved graph', async () => {
    renderPanel(CLEAN)
    await waitFor(() => expect(apiFetch).toHaveBeenCalled())
    const [url, options] = apiFetch.mock.calls[0]
    expect(url).toBe('/api/workflows/wf-1/paths')
    expect(options.method).toBe('POST')
    expect(options.body.nodes).toHaveLength(3)
  })

  it('shows every branch with the payload that drives it', async () => {
    renderPanel(CLEAN)
    expect(await screen.findByText('refund')).toBeInTheDocument()
    expect(screen.getByText('order')).toBeInTheDocument()
    expect(screen.getByText('{"kind":"refund"}')).toBeInTheDocument()
    expect(screen.getByText('all live')).toBeInTheDocument()
  })

  it('calls out a dead branch and what it contradicts', async () => {
    renderPanel(DEAD)
    expect(await screen.findByText('1 dead')).toBeInTheDocument()
    expect(screen.getByText(/contradicts Route → wide/)).toBeInTheDocument()
    // The verdict never rests on colour alone.
    expect(screen.getByText('No input reaches this')).toBeInTheDocument()
  })

  it('says why a live branch cannot be covered by a generated test', async () => {
    renderPanel(GATED)
    expect(
      await screen.findByText('test mode always takes the other side of Approve')
    ).toBeInTheDocument()
    expect(screen.getByText(/1 drivable from a trigger payload/)).toBeInTheDocument()
  })

  it('writes the generated scenarios into the suite', async () => {
    const onToast = vi.fn()
    renderPanel(CLEAN, { onToast })
    const button = await screen.findByRole('button', {
      name: /Write 2 scenarios into the suite/,
    })
    fireEvent.click(button)
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/workflows/wf-1/tests/generate',
        expect.objectContaining({ method: 'POST' })
      )
    )
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('2 scenarios in the suite (2 new)', 'success'))
  })

  it('offers nothing to write when no branch can be driven', async () => {
    renderPanel({ ...CLEAN, coverage: { branches: 2, reachable: 2, generatable: 0 } })
    const button = await screen.findByRole('button', { name: /Write 0 scenarios/ })
    expect(button).toBeDisabled()
  })

  it('reports a graph that admits no execution instead of showing nothing', async () => {
    renderPanel({ analysed: false, reason: 'cycle', branches: [], findings: [] })
    expect(await screen.findByText(/contains a cycle/)).toBeInTheDocument()
  })

  it('says a workflow with no decisions has nothing to analyse', async () => {
    renderPanel({
      analysed: true,
      branches: [],
      findings: [],
      coverage: { branches: 0, reachable: 0, generatable: 0 },
    })
    expect(await screen.findByText(/makes no decisions/)).toBeInTheDocument()
  })

  it('says so when the search did not finish, rather than looking clean', async () => {
    renderPanel({ ...CLEAN, truncated: true })
    expect(await screen.findByText(/hit its bound/)).toBeInTheDocument()
  })

  it('surfaces an error instead of an empty panel', async () => {
    apiFetch.mockRejectedValue(new Error('nope'))
    render(
      <PathsPanel workflowId="wf-1" nodes={NODES} edges={EDGES} onClose={() => {}} onSelectNode={() => {}} />
    )
    expect(await screen.findByText('nope')).toBeInTheDocument()
  })
})
