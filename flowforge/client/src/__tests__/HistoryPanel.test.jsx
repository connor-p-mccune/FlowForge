import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import HistoryPanel from '../components/canvas/HistoryPanel'
import { apiFetch } from '../services/api'

// All HTTP goes through services/api — mock it so the test controls responses.
vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

// The version preview renders a full <ReactFlow>; stub the library so what's
// under test is the panel's own behaviour (list, preview fetch, confirm,
// restore), not React Flow's rendering. The stub echoes the node count so the
// preview is observable.
vi.mock('reactflow', () => ({
  __esModule: true,
  default: ({ nodes = [] }) => <div data-testid="graph-preview">{nodes.length} nodes</div>,
  Background: () => null,
  ReactFlowProvider: ({ children }) => children,
  Handle: () => null,
  Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
}))

const VERSIONS = [
  { id: 'v2', version: 2, created_at: '2026-06-17T10:00:00.000Z', created_by_name: 'Alice' },
  { id: 'v1', version: 1, created_at: '2026-06-16T09:00:00.000Z', created_by_name: null },
]

const RESTORED = { id: 'wf1', name: 'WF', graph_json: '{"nodes":[],"edges":[]}' }

function mockApi({ versions = VERSIONS, graphData = { nodes: [{ id: 'a' }, { id: 'b' }], edges: [] } } = {}) {
  apiFetch.mockImplementation((path) => {
    if (path.endsWith('/restore')) return Promise.resolve({ workflow: RESTORED })
    if (/\/versions\/[^/]+$/.test(path)) return Promise.resolve({ version: 2, graph_data: graphData })
    if (path.endsWith('/versions')) return Promise.resolve({ versions })
    return Promise.reject(new Error(`unexpected request: ${path}`))
  })
}

function setup(props = {}) {
  const handlers = { onClose: vi.fn(), onRestored: vi.fn() }
  const utils = render(
    <HistoryPanel workflowId="wf1" open reloadSignal={0} {...handlers} {...props} />
  )
  return { ...handlers, ...utils }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockApi()
})

describe('HistoryPanel', () => {
  it('renders nothing and fetches nothing when closed', () => {
    const { container } = setup({ open: false })
    expect(container).toBeEmptyDOMElement()
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('lists versions newest-first with who deployed each', async () => {
    setup()
    expect(await screen.findByText('Version 2')).toBeInTheDocument()
    expect(screen.getByText('Version 1')).toBeInTheDocument()
    expect(screen.getByText('by Alice')).toBeInTheDocument()
    expect(screen.getByText('by Unknown')).toBeInTheDocument()
    expect(apiFetch).toHaveBeenCalledWith('/api/workflows/wf1/versions')
  })

  it('shows an empty state when there are no versions', async () => {
    mockApi({ versions: [] })
    setup()
    expect(await screen.findByText(/No versions yet/)).toBeInTheDocument()
  })

  it('fetches and renders a read-only preview when Preview is clicked', async () => {
    setup()
    await screen.findByText('Version 2')
    fireEvent.click(screen.getAllByRole('button', { name: 'Preview' })[0])
    expect(await screen.findByTestId('graph-preview')).toHaveTextContent('2 nodes')
    expect(apiFetch).toHaveBeenCalledWith('/api/workflows/wf1/versions/v2')
  })

  it('asks for confirmation with the exact rollback message before restoring', async () => {
    setup()
    await screen.findByText('Version 2')
    fireEvent.click(screen.getAllByRole('button', { name: 'Restore' })[0])
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent.replace(/\s+/g, ' ').trim()).toContain(
      'This will replace your current workflow with version 2. Your current state will be saved as a new version first.'
    )
  })

  it('restores on confirm: posts to the restore endpoint, calls onRestored, closes the dialog', async () => {
    const { onRestored } = setup()
    await screen.findByText('Version 2')
    fireEvent.click(screen.getAllByRole('button', { name: 'Restore' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Restore version 2' }))
    await waitFor(() => expect(onRestored).toHaveBeenCalledWith(RESTORED))
    expect(apiFetch).toHaveBeenCalledWith('/api/workflows/wf1/versions/v2/restore', { method: 'POST' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('cancelling the confirmation restores nothing', async () => {
    const { onRestored } = setup()
    await screen.findByText('Version 2')
    fireEvent.click(screen.getAllByRole('button', { name: 'Restore' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onRestored).not.toHaveBeenCalled()
    expect(apiFetch).toHaveBeenCalledTimes(1) // only the initial version-list load
  })
})
