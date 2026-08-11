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
