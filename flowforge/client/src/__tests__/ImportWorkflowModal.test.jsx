import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import ImportWorkflowModal from '../components/workflows/ImportWorkflowModal'
import { apiFetch } from '../services/api'

// All HTTP goes through services/api — mock it so the test controls responses.
vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

// The modal navigates to the new workflow after import; capture that call.
const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }))

const validExport = {
  exportVersion: '1.0',
  name: 'Exported Flow',
  description: 'desc',
  graph_data: {
    nodes: [
      { id: 'n1', type: 'trigger-webhook', data: { label: 'Hook' } },
      { id: 'n2', type: 'output-log', data: { label: 'Log' } },
    ],
    edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
  },
  exportedAt: '2026-06-17T00:00:00.000Z',
}

function jsonFile(obj, name = 'flow.json') {
  return new File([JSON.stringify(obj)], name, { type: 'application/json' })
}

function selectFile(file) {
  fireEvent.change(screen.getByLabelText('Workflow file'), { target: { files: [file] } })
}

function setup(props = {}) {
  const handlers = { onClose: vi.fn(), onCreated: vi.fn() }
  const utils = render(<ImportWorkflowModal workspaceId="ws1" {...handlers} {...props} />)
  return { ...handlers, ...utils }
}

beforeEach(() => {
  vi.clearAllMocks()
  apiFetch.mockResolvedValue({ workflow: { id: 'wf-new', name: 'Exported Flow' } })
})

describe('ImportWorkflowModal', () => {
  it('renders a JSON file picker', () => {
    setup()
    const input = screen.getByLabelText('Workflow file')
    expect(input).toHaveAttribute('type', 'file')
    expect(input.getAttribute('accept')).toMatch(/json/)
  })

  it('reads a valid export: pre-fills the name and previews node/edge counts', async () => {
    setup()
    selectFile(jsonFile(validExport))

    const nameInput = await screen.findByLabelText('Name')
    expect(nameInput).toHaveValue('Exported Flow')
    expect(screen.getByText(/2 nodes · 1 edge/)).toBeInTheDocument()
  })

  it('rejects a non-JSON file and shows no name field', async () => {
    setup()
    selectFile(new File(['not json{'], 'bad.json', { type: 'application/json' }))

    expect(await screen.findByText(/valid JSON/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
  })

  it('rejects a file missing graph_data', async () => {
    setup()
    selectFile(jsonFile({ name: 'x', exportVersion: '1.0' }))

    expect(await screen.findByText(/missing workflow data/)).toBeInTheDocument()
  })

  it('imports, notifies, closes, and navigates to the new workflow', async () => {
    const { onCreated, onClose } = setup()
    selectFile(jsonFile(validExport))
    await screen.findByLabelText('Name')

    fireEvent.click(screen.getByRole('button', { name: 'Import' }))

    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith({ id: 'wf-new', name: 'Exported Flow' })
    )
    expect(apiFetch).toHaveBeenCalledWith('/api/workspaces/ws1/workflows/import', {
      method: 'POST',
      body: { name: 'Exported Flow', graph_data: validExport.graph_data },
    })
    expect(navigate).toHaveBeenCalledWith('/workflow/wf-new')
    expect(onClose).toHaveBeenCalled()
  })

  it('surfaces a server error without navigating', async () => {
    apiFetch.mockRejectedValueOnce(new Error('Workflow graph is too large (max 500KB)'))
    setup()
    selectFile(jsonFile(validExport))
    await screen.findByLabelText('Name')

    fireEvent.click(screen.getByRole('button', { name: 'Import' }))

    expect(await screen.findByText(/too large/)).toBeInTheDocument()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('closes on Escape and via the × button', async () => {
    const { onClose } = setup()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '×' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
