import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import LineagePanel from '../components/canvas/LineagePanel'
import { apiFetch } from '../services/api'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

const NODES = [
  { id: 'hook', type: 'trigger-webhook', position: { x: 0, y: 0 }, data: { label: 'Order webhook' } },
  { id: 'charge', type: 'action-http', position: { x: 0, y: 0 }, data: { label: 'Charge card' } },
]
const EDGES = [{ id: 'e1', source: 'hook', target: 'charge' }]

const MAP = {
  ok: true,
  nodes: [],
  sinks: [
    {
      nodeId: 'charge',
      label: 'Charge card',
      key: 'url',
      kind: 'http-url',
      sensitivity: 'high',
      what: 'the address this request is sent to',
      via: ['hook.url'],
      origins: ['webhook'],
    },
  ],
  secretReach: { STRIPE_KEY: [{ nodeId: 'charge', label: 'Charge card', where: 'headers' }] },
  findings: [
    {
      severity: 'warning',
      code: 'tainted-sink',
      message: 'Charge card: the request URL is built from the webhook payload',
      nodeId: 'charge',
    },
  ],
}

const TRACE = {
  ok: true,
  provenance: {
    nodeId: 'charge',
    label: 'Charge card',
    origins: [
      {
        kind: 'webhook',
        trust: 'untrusted',
        label: 'the webhook payload',
        detail: 'written by whoever holds the trigger URL',
      },
    ],
    outputOrigins: [{ kind: 'response', trust: 'external', label: 'an HTTP response' }],
    secrets: [],
    variables: [],
    chain: [
      {
        from: 'hook',
        fromLabel: 'Order webhook',
        to: 'charge',
        toLabel: 'Charge card',
        reference: 'hook.url',
        where: 'url',
      },
    ],
  },
  impact: {
    nodeId: 'charge',
    label: 'Charge card',
    affected: [
      {
        nodeId: 'mail',
        label: 'Receipt',
        nodeType: 'action-email',
        distance: 1,
        references: [{ reference: 'charge.body.id', where: 'body' }],
      },
    ],
    sinks: [
      {
        nodeId: 'charge',
        label: 'Charge card',
        key: 'url',
        sensitivity: 'high',
        what: 'the address this request is sent to',
      },
    ],
  },
}

beforeEach(() => {
  vi.clearAllMocks()
})

const panel = (props = {}) =>
  render(
    <LineagePanel
      workflowId="wf1"
      nodes={NODES}
      edges={EDGES}
      selectedNodeId={null}
      onClose={() => {}}
      onSelectNode={() => {}}
      {...props}
    />
  )

describe('LineagePanel', () => {
  it('shows the graph map: findings, sinks, and secret reach', async () => {
    apiFetch.mockResolvedValue(MAP)
    panel()
    await waitFor(() => expect(screen.getByText(/built from the webhook payload/)).toBeInTheDocument())
    expect(screen.getByText('the address this request is sent to')).toBeInTheDocument()
    expect(screen.getByText('STRIPE_KEY')).toBeInTheDocument()
    expect(screen.getByText('high')).toBeInTheDocument()
  })

  it('asks the server for one node when a node is selected', async () => {
    apiFetch.mockResolvedValue(TRACE)
    panel({ selectedNodeId: 'charge' })
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/workflows/wf1/lineage?node=charge',
        expect.objectContaining({ method: 'POST' })
      )
    )
    expect(await screen.findByText('What feeds Charge card')).toBeInTheDocument()
    expect(screen.getByText('What breaks if it changes')).toBeInTheDocument()
  })

  it('names the trust level in words, not colour alone', async () => {
    apiFetch.mockResolvedValue(TRACE)
    panel({ selectedNodeId: 'charge' })
    expect(await screen.findByText('untrusted')).toBeInTheDocument()
    expect(screen.getByText('the webhook payload')).toBeInTheDocument()
    expect(screen.getByText(/whoever holds the trigger URL/)).toBeInTheDocument()
  })

  it('separates what feeds a node from what it emits when they differ', async () => {
    apiFetch.mockResolvedValue(TRACE)
    panel({ selectedNodeId: 'charge' })
    // The HTTP node's input traces to a webhook; its output is the far side's
    // answer. Conflating the two misreads the finding entirely.
    expect(await screen.findByText(/Its own output is/)).toBeInTheDocument()
    expect(screen.getByText(/an HTTP response/)).toBeInTheDocument()
  })

  it('lets you click through the chain to re-select nodes on the canvas', async () => {
    apiFetch.mockResolvedValue(TRACE)
    const onSelectNode = vi.fn()
    panel({ selectedNodeId: 'charge', onSelectNode })
    fireEvent.click(await screen.findByRole('button', { name: 'Order webhook' }))
    expect(onSelectNode).toHaveBeenCalledWith('hook')
    fireEvent.click(screen.getByRole('button', { name: 'Receipt' }))
    expect(onSelectNode).toHaveBeenCalledWith('mail')
  })

  it('reports a cycle rather than rendering an empty panel', async () => {
    apiFetch.mockResolvedValue({ ok: false, reason: 'cycle' })
    panel()
    expect(await screen.findByText(/has a cycle/)).toBeInTheDocument()
  })

  it('says so when nothing leaves the workflow', async () => {
    apiFetch.mockResolvedValue({ ok: true, nodes: [], sinks: [], secretReach: {}, findings: [] })
    panel()
    expect(await screen.findByText(/Nothing leaves this workflow/)).toBeInTheDocument()
  })
})

// Lineage says where data *leaves*; the effect report says under what
// conditions. The two halves of the question somebody has open before a deploy,
// which is why they share a panel.
describe('LineagePanel — what a run can do', () => {
  const EFFECTS = {
    workflowId: 'wf1',
    available: true,
    effects: [
      {
        nodeId: 'score', label: 'Fraud score', type: 'ai-classify', kind: 'model',
        target: 'gpt-4o-mini', always: true, conditions: [],
      },
      {
        nodeId: 'charge', label: 'Charge card', type: 'action-http', kind: 'http',
        target: 'api.acme.com', always: false,
        conditions: [{ nodeId: 'approve', label: 'Approve', type: 'approval', outcome: 'true' }],
      },
    ],
    decisions: [],
    summary: { total: 2, unconditional: 1, gated: 1, dynamicTargets: 0 },
  }

  // Key on the path: the panel fires two independent reads, and a single
  // mockResolvedValue would answer both with the same body.
  const mockByPath = (effects = EFFECTS) => {
    apiFetch.mockImplementation((path) =>
      Promise.resolve(path.endsWith('/effects') ? effects : MAP)
    )
  }

  it('lists each effect with what it reaches and what gates it', async () => {
    mockByPath()
    panel()
    expect(await screen.findByText(/What a run can do/)).toBeInTheDocument()
    expect(screen.getByText(/api\.acme\.com — Approve = true/)).toBeInTheDocument()
  })

  it('says plainly when something happens on every run', async () => {
    // The sentence a reviewer needs before any of the others — and what a gate
    // somebody routed around looks like.
    mockByPath()
    panel()
    expect(await screen.findByText(/gpt-4o-mini — on every run/)).toBeInTheDocument()
  })

  it('names a destination the graph does not fix rather than guessing', async () => {
    mockByPath({
      ...EFFECTS,
      effects: [{ ...EFFECTS.effects[0], target: null }],
    })
    panel()
    expect(await screen.findByText(/destination not fixed by the graph/)).toBeInTheDocument()
  })

  it('renders the dataflow even when the effect report is unavailable', async () => {
    mockByPath({ workflowId: 'wf1', available: false, reason: 'cycle' })
    panel()
    await waitFor(() => expect(screen.getByText(/built from the webhook payload/)).toBeInTheDocument())
    expect(screen.queryByText(/What a run can do/)).not.toBeInTheDocument()
  })

  it('asks about the graph on screen, not the one that was saved', async () => {
    mockByPath()
    panel()
    await screen.findByText(/What a run can do/)
    const call = apiFetch.mock.calls.find(([path]) => path.endsWith('/effects'))
    expect(call[1].method).toBe('POST')
    expect(call[1].body.nodes.map((n) => n.id)).toEqual(['hook', 'charge'])
  })
})

// A sub-workflow node is one box on the canvas and an entire other workflow at
// run time. The panel says so, because a reviewer reading "Charge card" in a
// report about Orders needs to know it happens somewhere else.
describe('LineagePanel — across the sub-workflow boundary', () => {
  const SHALLOW = {
    workflowId: 'wf1',
    available: true,
    effects: [
      {
        nodeId: 'score', label: 'Fraud score', type: 'ai-classify', kind: 'model',
        target: 'gpt-4o-mini', always: true, conditions: [],
      },
    ],
    decisions: [],
    summary: { total: 1, unconditional: 1, gated: 0, dynamicTargets: 0 },
  }

  const REACH = {
    available: true,
    workflowId: 'wf1',
    effects: [
      {
        nodeId: 'charge', label: 'Charge card', type: 'action-http', kind: 'http',
        target: 'api.acme.com', always: false,
        workflowId: 'wf2', workflowName: 'Fulfilment',
        via: [{ workflowId: 'wf2', name: 'Fulfilment', nodeId: 'call', label: 'Fulfil order' }],
        conditions: [
          { label: 'Approve order', outcome: 'true', workflowName: 'Orders' },
          { label: 'In stock?', outcome: 'true', workflowName: 'Fulfilment' },
        ],
      },
    ],
    unresolved: [],
    summary: { total: 1, direct: 0, inherited: 1, unconditional: 0, workflows: 1, deepest: 1 },
  }

  const mockAll = ({ reach = REACH, effects = SHALLOW } = {}) => {
    apiFetch.mockImplementation((path) => {
      if (path.endsWith('/reach')) return Promise.resolve(reach)
      if (path.endsWith('/effects')) return Promise.resolve(effects)
      return Promise.resolve(MAP)
    })
  }

  it('shows an effect that happens inside a workflow this one calls', async () => {
    mockAll()
    panel()
    expect(
      await screen.findByText(/api\.acme\.com — Approve order = true and In stock\? = true/)
    ).toBeInTheDocument()
    expect(screen.getByText(/via Fulfilment/)).toBeInTheDocument()
  })

  it('says how much of what a run does is not on this canvas', async () => {
    mockAll()
    panel()
    expect(
      await screen.findByText(/1 of these 1 happen inside 1 other workflow this one calls/)
    ).toBeInTheDocument()
  })

  it('does not offer a link to a node that is not on this canvas', async () => {
    // Selecting it would silently do nothing, which is worse than not offering.
    // Scoped to the effect's own row: the dataflow map above lists a sink with
    // the same label, and it *is* on this canvas.
    mockAll()
    const { container } = panel()
    await screen.findByText(/via Fulfilment/)
    const row = [...container.querySelectorAll('li')].find((li) =>
      li.textContent.includes('via Fulfilment')
    )
    expect(row.querySelector('button')).toBeDisabled()
  })

  it('falls back to the per-graph report when nothing is inherited', async () => {
    // Showing both would be showing the same effects twice.
    mockAll({ reach: { ...REACH, summary: { ...REACH.summary, inherited: 0, direct: 1 } } })
    panel()
    expect(await screen.findByText(/gpt-4o-mini — on every run/)).toBeInTheDocument()
    expect(screen.queryByText(/happen inside/)).not.toBeInTheDocument()
  })

  it('still renders the effects when the transitive read fails', async () => {
    // Two independent reads: neither should be able to hide the other.
    apiFetch.mockImplementation((path) => {
      if (path.endsWith('/reach')) return Promise.reject(new Error('nope'))
      if (path.endsWith('/effects')) return Promise.resolve(SHALLOW)
      return Promise.resolve(MAP)
    })
    panel()
    expect(await screen.findByText(/What a run can do/)).toBeInTheDocument()
  })
})
