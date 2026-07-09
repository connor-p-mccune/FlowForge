import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import IssuesPanel from '../components/canvas/IssuesPanel'
import { apiFetch } from '../services/api'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

const nodes = [
  {
    id: 'n1',
    type: 'action-http',
    position: { x: 0, y: 0 },
    data: { label: 'Call API', config: { url: '' } },
    selected: true, // volatile — must not reach the server
  },
]
const edges = []

function renderPanel({ onSelectNode = vi.fn(), onClose = vi.fn() } = {}) {
  render(
    <IssuesPanel
      workflowId="wf-1"
      nodes={nodes}
      edges={edges}
      onClose={onClose}
      onSelectNode={onSelectNode}
    />
  )
  return { onSelectNode, onClose }
}

describe('IssuesPanel', () => {
  beforeEach(() => {
    apiFetch.mockReset()
  })

  it('lints the live canvas graph (volatile props stripped)', async () => {
    apiFetch.mockResolvedValue({ issues: [], summary: { errors: 0, warnings: 0 } })
    renderPanel()

    await waitFor(() => expect(apiFetch).toHaveBeenCalled())
    const [url, opts] = apiFetch.mock.calls[0]
    expect(url).toBe('/api/workflows/wf-1/lint')
    expect(opts.method).toBe('POST')
    expect(opts.body.nodes[0]).not.toHaveProperty('selected')
    expect(opts.body.nodes[0].id).toBe('n1')
  })

  it('shows the all-clear when there are no issues', async () => {
    apiFetch.mockResolvedValue({ issues: [], summary: { errors: 0, warnings: 0 } })
    renderPanel()
    expect(await screen.findByText(/no issues found/i)).toBeInTheDocument()
  })

  it('lists issues with severity counts and node click-through', async () => {
    const onSelectNode = vi.fn()
    apiFetch.mockResolvedValue({
      issues: [
        { severity: 'error', code: 'missing-config', message: 'Call API: a URL is required', nodeId: 'n1' },
        { severity: 'warning', code: 'no-trigger', message: 'The workflow has no trigger node', nodeId: null },
      ],
      summary: { errors: 1, warnings: 1 },
    })
    renderPanel({ onSelectNode })

    expect(await screen.findByText('1 error')).toBeInTheDocument()
    expect(screen.getByText('1 warning')).toBeInTheDocument()

    // The node-bound issue is a button; clicking selects the node.
    fireEvent.click(screen.getByRole('button', { name: /a URL is required/i }))
    expect(onSelectNode).toHaveBeenCalledWith('n1')

    // The graph-level issue is plain text, not clickable.
    expect(
      screen.queryByRole('button', { name: /no trigger node/i })
    ).not.toBeInTheDocument()
    expect(screen.getByText(/no trigger node/i)).toBeInTheDocument()
  })

  it('surfaces lint failures', async () => {
    apiFetch.mockRejectedValue(new Error('Workflow not found'))
    renderPanel()
    expect(await screen.findByText('Workflow not found')).toBeInTheDocument()
  })
})
