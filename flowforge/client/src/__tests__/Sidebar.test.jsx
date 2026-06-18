import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import Sidebar from '../components/layout/Sidebar'
import { apiFetch } from '../services/api'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useParams: () => ({}),
  useLocation: () => ({ pathname: '/' }),
}))

const WORKSPACES = [{ id: 'ws1', name: 'Workspace One' }]
const WORKFLOWS = [{ id: 'wf1', name: 'My Flow', workspace_id: 'ws1', status: 'draft' }]
const EXPORT_PAYLOAD = {
  exportVersion: '1.0',
  name: 'My Flow',
  description: null,
  graph_data: { nodes: [{ id: 'n1', type: 'output-log' }], edges: [] },
  exportedAt: '2026-06-17T00:00:00.000Z',
}

function mockApi() {
  apiFetch.mockImplementation((path, opts) => {
    if (path === '/api/workspaces' && !opts) return Promise.resolve({ workspaces: WORKSPACES })
    if (path === '/api/workspaces/ws1/workflows') return Promise.resolve({ workflows: WORKFLOWS })
    if (path === '/api/workflows/wf1/export') return Promise.resolve(EXPORT_PAYLOAD)
    if (path === '/api/workflows/wf1' && opts?.method === 'DELETE') return Promise.resolve({})
    return Promise.reject(new Error(`unexpected request: ${path} ${JSON.stringify(opts)}`))
  })
}

async function renderSidebar() {
  render(<Sidebar />)
  // Wait for the workflow row to load before interacting.
  return screen.findByRole('button', { name: 'My Flow' })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockApi()
})

describe('Sidebar workflow actions menu', () => {
  it('opens a menu offering Rename, Export, and Delete', async () => {
    await renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: 'Workflow actions' }))

    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Export' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument()
  })

  it('exports a workflow by downloading a JSON blob', async () => {
    // Stub the browser download path (jsdom does not implement these).
    const createObjectURL = vi.fn(() => 'blob:mock')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    await renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: 'Workflow actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export' }))

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/workflows/wf1/export'))
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(click).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock')

    click.mockRestore()
  })

  it('deletes a workflow from the menu', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: 'Workflow actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/workflows/wf1', { method: 'DELETE' })
    )
    window.confirm.mockRestore()
  })

  it('opens the import modal from the Workflows header', async () => {
    await renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: 'Import workflow' }))

    expect(await screen.findByRole('dialog', { name: 'Import workflow' })).toBeInTheDocument()
  })
})
