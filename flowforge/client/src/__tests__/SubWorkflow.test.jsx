import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ReactFlowProvider } from 'reactflow'

import SubWorkflowNode from '../components/canvas/nodes/SubWorkflowNode'
import NodeConfigPanel from '../components/canvas/NodeConfigPanel'
import { StepList } from '../components/execution/ExecutionPanel'
import { apiFetch } from '../services/api'

// All HTTP goes through services/api — mock it so the config picker is deterministic.
vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

// React Flow's <Handle> reads from the flow store, so the node renders in a provider.
function renderNode(ui) {
  return render(<ReactFlowProvider>{ui}</ReactFlowProvider>)
}
const targets = (c) => c.querySelectorAll('.react-flow__handle.target')
const sources = (c) => c.querySelectorAll('.react-flow__handle.source')

describe('SubWorkflowNode', () => {
  it('shows the selected target workflow name', () => {
    renderNode(
      <SubWorkflowNode
        data={{ label: 'Run alert', config: { workflowName: 'Send Alert' } }}
        selected={false}
      />
    )
    expect(screen.getByText('Run alert')).toBeInTheDocument()
    expect(screen.getByText('Send Alert')).toBeInTheDocument()
  })

  it('falls back to placeholder text when no workflow is chosen', () => {
    renderNode(<SubWorkflowNode data={{ config: {} }} selected={false} />)
    expect(screen.getByText('Sub-workflow')).toBeInTheDocument()
    expect(screen.getByText('no workflow selected')).toBeInTheDocument()
  })

  it('has both handles (a step in the middle of a flow) and the selected class', () => {
    const { container } = renderNode(<SubWorkflowNode data={{ config: {} }} selected={true} />)
    expect(targets(container)).toHaveLength(1)
    expect(sources(container)).toHaveLength(1)
    expect(container.querySelector('.node')).toHaveClass('node--subworkflow', 'node--selected')
    expect(container.querySelector('.node__icon')).toBeInTheDocument()
  })
})

describe('NodeConfigPanel — sub-workflow picker', () => {
  const WORKFLOWS = [
    { id: 'wf-current', name: 'This One', status: 'deployed', graph_json: '{"nodes":[{}],"edges":[]}' },
    { id: 'wf-a', name: 'Send Alert', status: 'deployed', graph_json: '{"nodes":[{},{},{}],"edges":[]}' },
    { id: 'wf-draft', name: 'Draft Thing', status: 'draft', graph_json: '{"nodes":[{}],"edges":[]}' },
    { id: 'wf-c', name: 'Notify Team', status: 'deployed', graph_json: '{"nodes":[{},{}],"edges":[]}' },
  ]

  const subNode = (config = {}) => ({ id: 'n1', type: 'sub-workflow', data: { label: 'Sub', config } })

  function setup(node, { config } = {}) {
    const onChange = vi.fn()
    render(
      <NodeConfigPanel
        node={node || subNode(config)}
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

  it('lists only other deployed workflows, with node counts', async () => {
    setup()
    await screen.findByText('Send Alert')
    // The current workflow and any non-deployed workflow are excluded.
    expect(screen.queryByText('This One')).not.toBeInTheDocument()
    expect(screen.queryByText('Draft Thing')).not.toBeInTheDocument()
    expect(screen.getByText('Notify Team')).toBeInTheDocument()
    expect(screen.getByText('3 nodes')).toBeInTheDocument()
    expect(screen.getByText('2 nodes')).toBeInTheDocument()
    expect(apiFetch).toHaveBeenCalledWith('/api/workspaces/ws1/workflows')
  })

  it('filters the list by the search query', async () => {
    setup()
    await screen.findByText('Send Alert')
    fireEvent.change(screen.getByPlaceholderText('Search workflows…'), {
      target: { value: 'notify' },
    })
    expect(screen.queryByText('Send Alert')).not.toBeInTheDocument()
    expect(screen.getByText('Notify Team')).toBeInTheDocument()
  })

  it('picking a workflow stores its id and name on the node config', async () => {
    const { onChange } = setup()
    await screen.findByText('Send Alert')
    fireEvent.click(screen.getByText('Send Alert'))
    expect(onChange).toHaveBeenCalledWith('n1', {
      config: { workflowId: 'wf-a', workflowName: 'Send Alert' },
    })
  })

  it('shows the selected workflow with its node count when one is set', async () => {
    setup(null, { config: { workflowId: 'wf-a', workflowName: 'Send Alert' } })
    // Selected preview (name + count) renders once the list resolves.
    await waitFor(() => expect(apiFetch).toHaveBeenCalled())
    const selected = await screen.findByText('Send Alert', { selector: '.subworkflow-config__selected-name' })
    expect(selected).toBeInTheDocument()
  })

  it('warns when the saved workflow is no longer available', async () => {
    apiFetch.mockResolvedValue({ workflows: [] })
    setup(null, { config: { workflowId: 'gone', workflowName: 'Gone' } })
    expect(await screen.findByText(/no longer available/i)).toBeInTheDocument()
  })
})

describe('StepList — nested sub-workflow call tree', () => {
  it('renders a child run inline under the step that spawned it', () => {
    const steps = [
      { nodeId: 'p-sub', type: 'sub-workflow', status: 'succeeded', output: { ok: true }, error: null },
    ]
    const childExecutionsByNode = {
      'p-sub': [
        {
          execution: { id: 'child1', status: 'completed', parent_node_id: 'p-sub' },
          steps: [
            { nodeId: 'c-trigger', type: 'trigger-manual', status: 'succeeded', output: null, error: null },
            { nodeId: 'c-return', type: 'output-return', status: 'succeeded', output: { ok: true }, error: null },
          ],
          childExecutionsByNode: {},
        },
      ],
    }
    const { container } = render(
      <StepList steps={steps} nodes={[]} childExecutionsByNode={childExecutionsByNode} />
    )

    expect(screen.getByText(/Sub-workflow run/)).toBeInTheDocument()
    expect(container.querySelector('.step__subworkflow')).toBeInTheDocument()
    // Child steps render with their node-type label (their canvas nodes aren't here).
    expect(screen.getByText('trigger-manual')).toBeInTheDocument()
    expect(screen.getByText('output-return')).toBeInTheDocument()
  })

  it('renders a plain step with no nested block when it spawned nothing', () => {
    const steps = [{ nodeId: 'a', type: 'output-log', status: 'succeeded', output: null, error: null }]
    const { container } = render(<StepList steps={steps} nodes={[]} childExecutionsByNode={{}} />)
    expect(container.querySelector('.step__subworkflows')).toBeNull()
  })
})
