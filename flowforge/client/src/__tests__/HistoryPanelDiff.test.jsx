import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import HistoryPanel from '../components/canvas/HistoryPanel'
import { apiFetch } from '../services/api'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

const version = {
  id: 'v1',
  version: 1,
  created_at: '2026-07-01T10:00:00.000Z',
  created_by_name: 'Ada',
}

// The stored version: trigger → log.
const versionGraph = {
  nodes: [
    { id: 't1', type: 'trigger-manual', position: { x: 0, y: 0 }, data: { label: 'Start', config: {} } },
    { id: 'o1', type: 'output-log', position: { x: 0, y: 100 }, data: { label: 'Log', config: { message: 'hi' } } },
  ],
  edges: [{ id: 'e1', source: 't1', target: 'o1', sourceHandle: null, targetHandle: null }],
}

// The live canvas: log message edited + an HTTP node added.
const currentNodes = [
  { id: 't1', type: 'trigger-manual', position: { x: 0, y: 0 }, data: { label: 'Start', config: {} } },
  { id: 'o1', type: 'output-log', position: { x: 0, y: 100 }, data: { label: 'Log', config: { message: 'edited' } } },
  { id: 'h1', type: 'action-http', position: { x: 0, y: 200 }, data: { label: 'Call API', config: { url: 'https://x.example' } } },
]
const currentEdges = [
  { id: 'e1', source: 't1', target: 'o1', sourceHandle: null, targetHandle: null },
  { id: 'e2', source: 'o1', target: 'h1', sourceHandle: null, targetHandle: null },
]

function mockApi() {
  apiFetch.mockImplementation((url) => {
    if (url.endsWith('/versions')) return Promise.resolve({ versions: [version] })
    if (url.includes('/versions/v1')) return Promise.resolve({ version: 1, graph_data: versionGraph })
    return Promise.reject(new Error(`unexpected ${url}`))
  })
}

describe('HistoryPanel diff view', () => {
  beforeEach(() => {
    apiFetch.mockReset()
    mockApi()
  })

  function renderPanel() {
    render(
      <HistoryPanel
        workflowId="wf-1"
        open
        reloadSignal={0}
        onClose={vi.fn()}
        onRestored={vi.fn()}
        currentNodes={currentNodes}
        currentEdges={currentEdges}
      />
    )
  }

  it('diffs a version against the live canvas', async () => {
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'Diff' }))

    await waitFor(() =>
      expect(screen.getByText(/changes on the canvas since this version/i)).toBeInTheDocument()
    )
    // Summary chips: one node added, one changed, one connection added.
    expect(screen.getByText('+1 node')).toBeInTheDocument()
    expect(screen.getByText('~1 changed')).toBeInTheDocument()
    expect(screen.getByText('+1 connection')).toBeInTheDocument()
    // Detail rows.
    expect(screen.getByText('+ Call API')).toBeInTheDocument()
    expect(screen.getByText(/~ Log/)).toBeInTheDocument()
    expect(screen.getByText(/config\.message/)).toBeInTheDocument()
    expect(screen.getByText('+ Log → Call API')).toBeInTheDocument()
  })

  it('says so when the canvas matches the version', async () => {
    apiFetch.mockImplementation((url) => {
      if (url.endsWith('/versions')) return Promise.resolve({ versions: [version] })
      if (url.includes('/versions/v1')) {
        return Promise.resolve({
          version: 1,
          graph_data: { nodes: currentNodes, edges: currentEdges },
        })
      }
      return Promise.reject(new Error(`unexpected ${url}`))
    })
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'Diff' }))
    expect(
      await screen.findByText(/current canvas matches this version exactly/i)
    ).toBeInTheDocument()
  })

  it('toggles the diff closed on a second click', async () => {
    renderPanel()
    const diffBtn = await screen.findByRole('button', { name: 'Diff' })
    fireEvent.click(diffBtn)
    await screen.findByText(/changes on the canvas/i)

    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(screen.queryByText(/changes on the canvas/i)).not.toBeInTheDocument()
  })
})
