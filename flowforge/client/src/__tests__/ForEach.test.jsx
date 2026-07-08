import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ReactFlowProvider } from 'reactflow'

import ForEachNode from '../components/canvas/nodes/ForEachNode'
import NodeConfigPanel from '../components/canvas/NodeConfigPanel'
import { NODE_DEFS, TOOLBAR_BUTTONS } from '../components/canvas/nodeDefs'
import { nodeTypes } from '../components/canvas/nodeTypes'
import { apiFetch } from '../services/api'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

function renderNode(ui) {
  return render(<ReactFlowProvider>{ui}</ReactFlowProvider>)
}

describe('ForEachNode', () => {
  it('shows the target workflow with a per-item hint', () => {
    renderNode(
      <ForEachNode
        data={{ label: 'Notify each user', config: { workflowName: 'Send Alert' } }}
        selected={false}
      />
    )
    expect(screen.getByText('Notify each user')).toBeInTheDocument()
    expect(screen.getByText('Send Alert · per item')).toBeInTheDocument()
  })

  it('falls back to placeholder text and carries its own styling class', () => {
    const { container } = renderNode(<ForEachNode data={{ config: {} }} selected={true} />)
    expect(screen.getByText('For Each')).toBeInTheDocument()
    expect(screen.getByText('no workflow selected')).toBeInTheDocument()
    expect(container.querySelector('.node')).toHaveClass('node--foreach', 'node--selected')
  })

  it('is registered in the node defs, toolbar, and type map', () => {
    expect(NODE_DEFS['for-each']).toMatchObject({
      label: 'For Each',
      config: { items: '', workflowId: '', continueOnError: false },
    })
    expect(TOOLBAR_BUTTONS.some((b) => b.type === 'for-each')).toBe(true)
    expect(nodeTypes['for-each']).toBe(ForEachNode)
  })
})

describe('NodeConfigPanel — for-each', () => {
  const WORKFLOWS = [
    { id: 'wf-a', name: 'Send Alert', status: 'deployed', graph_json: '{"nodes":[{}],"edges":[]}' },
  ]

  const forEachNode = (config = {}) => ({
    id: 'n1',
    type: 'for-each',
    data: { label: 'For Each', config },
  })

  function setup(config) {
    const onChange = vi.fn()
    render(
      <NodeConfigPanel
        node={forEachNode(config)}
        onChange={onChange}
        onClose={vi.fn()}
        onDelete={vi.fn()}
        workspaceId="ws1"
        currentWorkflowId="wf-current"
      />
    )
    return { onChange }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    apiFetch.mockResolvedValue({ workflows: WORKFLOWS })
  })

  it('edits the items template', async () => {
    const { onChange } = setup({ items: '' })
    await screen.findByText('Send Alert')
    fireEvent.change(screen.getByPlaceholderText(/\["a", "b", "c"\]/), {
      target: { value: '{{x.users}}' },
    })
    expect(onChange).toHaveBeenCalledWith('n1', {
      config: expect.objectContaining({ items: '{{x.users}}' }),
    })
  })

  it('picks a target workflow through the shared picker', async () => {
    const { onChange } = setup({ items: '[1]' })
    fireEvent.click(await screen.findByText('Send Alert'))
    expect(onChange).toHaveBeenCalledWith('n1', {
      config: expect.objectContaining({ workflowId: 'wf-a', workflowName: 'Send Alert' }),
    })
  })

  it('toggles continue-on-error', async () => {
    const { onChange } = setup({ items: '[1]', continueOnError: false })
    await screen.findByText('Send Alert')
    fireEvent.click(screen.getByRole('checkbox'))
    expect(onChange).toHaveBeenCalledWith('n1', {
      config: expect.objectContaining({ continueOnError: true }),
    })
  })

  it('documents the per-item payload fields', async () => {
    const { container } = render(
      <NodeConfigPanel
        node={forEachNode({})}
        onChange={vi.fn()}
        onClose={vi.fn()}
        onDelete={vi.fn()}
        workspaceId="ws1"
        currentWorkflowId="wf-current"
      />
    )
    await screen.findByText('Send Alert')
    expect(container.textContent).toContain('{{trigger-id.item}}')
    expect(container.textContent).toContain('.results}}')
  })
})
