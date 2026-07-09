import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import VariableExplorer from '../components/canvas/VariableExplorer'

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

describe('VariableExplorer', () => {
  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn() } })
  })

  it('lists upstream nodes only — not siblings or downstream', () => {
    render(<VariableExplorer node={selected} nodes={nodes} edges={edges} />)
    expect(screen.getByText('Fetch order')).toBeInTheDocument()
    expect(screen.getByText('Order hook')).toBeInTheDocument()
    expect(screen.queryByText('Sibling')).not.toBeInTheDocument()
    expect(screen.queryByText('Downstream')).not.toBeInTheDocument()
  })

  it('offers the known output fields for each upstream type', () => {
    render(<VariableExplorer node={selected} nodes={nodes} edges={edges} />)
    // action-http emits status/body; the webhook trigger notes its dynamic body.
    expect(screen.getByRole('button', { name: '.status' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '.body' })).toBeInTheDocument()
    expect(screen.getByText(/every field of the webhook POST body/i)).toBeInTheDocument()
  })

  it('copies the {{id.field}} reference on click and confirms it', () => {
    render(<VariableExplorer node={selected} nodes={nodes} edges={edges} />)
    fireEvent.click(screen.getByRole('button', { name: '.status' }))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('{{http.status}}')
    expect(screen.getByRole('button', { name: '✓ Copied' })).toBeInTheDocument()
  })

  it('renders nothing when the node has no upstream', () => {
    const { container } = render(
      <VariableExplorer node={nodes[0]} nodes={nodes} edges={edges} />
    )
    expect(container).toBeEmptyDOMElement()
  })
})
