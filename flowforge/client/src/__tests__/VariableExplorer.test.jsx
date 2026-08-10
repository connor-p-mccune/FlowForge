import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import VariableExplorer from '../components/canvas/VariableExplorer'
import { apiFetch } from '../services/api'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

const nodes = [
  { id: 'trig', type: 'trigger-webhook', data: { label: 'Order hook', config: {} } },
  { id: 'http', type: 'action-http', data: { label: 'Fetch order', config: {} } },
  { id: 'cond', type: 'condition', data: { label: 'Paid?', config: {} } },
  { id: 'sibling', type: 'action-slack', data: { label: 'Sibling', config: {} } },
  { id: 'down', type: 'output-log', data: { label: 'Downstream', config: {} } },
]

// trig → http → cond → down, with `sibling` also hanging off trig (a parallel
// branch — not upstream of cond).
const edges = [
  { id: 'e1', source: 'trig', target: 'http' },
  { id: 'e2', source: 'http', target: 'cond' },
  { id: 'e3', source: 'trig', target: 'sibling' },
  { id: 'e4', source: 'cond', target: 'down' },
]

const selected = nodes.find((n) => n.id === 'cond')

// What the server's inference returns for this graph.
const SCHEMA = {
  nodes: {
    trig: {
      input: { described: 'object' },
      output: {
        described: '{ triggered: boolean, … }',
        fields: [{ path: 'triggered', type: 'boolean', optional: false }],
      },
    },
    http: {
      input: { described: '{ triggered: boolean, … }' },
      output: {
        described: '{ status: number, body: any }',
        fields: [
          { path: 'status', type: 'number', optional: false },
          { path: 'body', type: 'any', optional: false },
        ],
      },
    },
  },
}

function open() {
  fireEvent.click(screen.getByText(/Insert data from upstream/))
}

describe('VariableExplorer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiFetch.mockResolvedValue(SCHEMA)
    Object.assign(navigator, { clipboard: { writeText: vi.fn() } })
  })

  const renderExplorer = (props = {}) =>
    render(
      <VariableExplorer
        node={selected}
        nodes={nodes}
        edges={edges}
        workflowId="wf-1"
        {...props}
      />
    )

  it('lists upstream nodes only — not siblings or downstream', () => {
    renderExplorer()
    expect(screen.getByText('Fetch order')).toBeInTheDocument()
    expect(screen.getByText('Order hook')).toBeInTheDocument()
    expect(screen.queryByText('Sibling')).not.toBeInTheDocument()
    expect(screen.queryByText('Downstream')).not.toBeInTheDocument()
  })

  it('asks the server for the live graph’s schema, not the saved one', async () => {
    renderExplorer()
    // Nothing is fetched until the picker is actually opened.
    expect(apiFetch).not.toHaveBeenCalled()
    open()
    await waitFor(() => expect(apiFetch).toHaveBeenCalled())
    expect(apiFetch).toHaveBeenCalledWith('/api/workflows/wf-1/types', {
      method: 'POST',
      body: { nodes, edges },
    })
  })

  it('shows each upstream node’s inferred shape and its fields with types', async () => {
    renderExplorer()
    open()
    expect(await screen.findByText('{ status: number, body: any }')).toBeInTheDocument()
    const statusChip = await screen.findByRole('button', { name: /\.status/ })
    expect(statusChip).toHaveTextContent('number')
    expect(await screen.findByRole('button', { name: /\.body/ })).toBeInTheDocument()
  })

  it('says an open shape may carry more than it lists', async () => {
    renderExplorer()
    open()
    expect(await screen.findByText(/plus whatever else the data carries/i)).toBeInTheDocument()
  })

  it('copies the {{id.field}} reference on click and confirms it', async () => {
    renderExplorer()
    open()
    fireEvent.click(await screen.findByRole('button', { name: /\.status/ }))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('{{http.status}}')
    expect(screen.getByRole('button', { name: '✓ Copied' })).toBeInTheDocument()
  })

  it('still lists the nodes when the analysis fails', async () => {
    apiFetch.mockRejectedValue(new Error('nope'))
    renderExplorer()
    open()
    expect(await screen.findByText(/Could not analyse the graph/i)).toBeInTheDocument()
    expect(screen.getByText('Fetch order')).toBeInTheDocument()
  })

  it('renders nothing when the node has no upstream', () => {
    const { container } = render(
      <VariableExplorer node={nodes[0]} nodes={nodes} edges={edges} workflowId="wf-1" />
    )
    expect(container).toBeEmptyDOMElement()
  })
})
