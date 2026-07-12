import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import NodeTester from '../components/canvas/NodeTester'
import { apiFetch } from '../services/api'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

const node = (type, config = {}) => ({ id: 'n1', type, data: { label: 'n', config } })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('NodeTester', () => {
  it('renders nothing without a workflowId (shared panel in unit tests)', () => {
    const { container } = render(<NodeTester node={node('transform')} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing for engine-only node types', () => {
    for (const type of ['approval', 'sub-workflow', 'for-each']) {
      const { container } = render(<NodeTester workflowId="wf1" node={node(type)} />)
      expect(container).toBeEmptyDOMElement()
    }
  })

  it('runs a dry test and shows the succeeded output', async () => {
    apiFetch.mockResolvedValue({
      status: 'succeeded',
      dryRun: true,
      durationMs: 3,
      output: { greeting: 'hi' },
    })
    render(<NodeTester workflowId="wf1" node={node('transform', { template: '{}' })} />)

    fireEvent.click(screen.getByRole('button', { name: /test this node/i }))
    fireEvent.click(screen.getByRole('button', { name: /run node/i }))

    await screen.findByText('succeeded')
    expect(apiFetch).toHaveBeenCalledWith('/api/workflows/wf1/test-node', {
      method: 'POST',
      body: { node: node('transform', { template: '{}' }), input: undefined, live: false },
    })
    expect(screen.getByText('dry run')).toBeInTheDocument()
    expect(screen.getByText(/"greeting": "hi"/)).toBeInTheDocument()
  })

  it('parses sample input JSON and forwards it', async () => {
    apiFetch.mockResolvedValue({ status: 'succeeded', dryRun: true, durationMs: 1, output: {} })
    render(<NodeTester workflowId="wf1" node={node('transform')} />)

    fireEvent.click(screen.getByRole('button', { name: /test this node/i }))
    fireEvent.change(screen.getByPlaceholderText(/"name": "Ada"/), {
      target: { value: '{"name": "Ada"}' },
    })
    fireEvent.click(screen.getByRole('button', { name: /run node/i }))

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/workflows/wf1/test-node', {
        method: 'POST',
        body: expect.objectContaining({ input: { name: 'Ada' } }),
      })
    )
  })

  it('rejects malformed sample input without calling the API', async () => {
    render(<NodeTester workflowId="wf1" node={node('transform')} />)
    fireEvent.click(screen.getByRole('button', { name: /test this node/i }))
    fireEvent.change(screen.getByPlaceholderText(/"name": "Ada"/), {
      target: { value: '{not json' },
    })
    fireEvent.click(screen.getByRole('button', { name: /run node/i }))

    expect(await screen.findByText(/must be valid JSON/i)).toBeInTheDocument()
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('opts into firing real actions with the live checkbox', async () => {
    apiFetch.mockResolvedValue({ status: 'succeeded', dryRun: false, durationMs: 5, output: {} })
    render(<NodeTester workflowId="wf1" node={node('action-http', { url: 'http://x' })} />)

    fireEvent.click(screen.getByRole('button', { name: /test this node/i }))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: /run node/i }))

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/workflows/wf1/test-node', {
        method: 'POST',
        body: expect.objectContaining({ live: true }),
      })
    )
  })

  it('shows a failed verdict with the node error', async () => {
    apiFetch.mockResolvedValue({
      status: 'failed',
      dryRun: true,
      durationMs: 2,
      error: 'HTTP node: url is required',
    })
    render(<NodeTester workflowId="wf1" node={node('action-http')} />)

    fireEvent.click(screen.getByRole('button', { name: /test this node/i }))
    fireEvent.click(screen.getByRole('button', { name: /run node/i }))

    await screen.findByText('failed')
    expect(screen.getByText(/url is required/)).toBeInTheDocument()
  })

  it('surfaces a request-level error', async () => {
    apiFetch.mockRejectedValue(new Error('Workflow not found'))
    render(<NodeTester workflowId="wf1" node={node('transform')} />)

    fireEvent.click(screen.getByRole('button', { name: /test this node/i }))
    fireEvent.click(screen.getByRole('button', { name: /run node/i }))

    expect(await screen.findByText('Workflow not found')).toBeInTheDocument()
  })
})
