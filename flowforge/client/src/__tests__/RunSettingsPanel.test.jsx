import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import RunSettingsPanel from '../components/canvas/RunSettingsPanel'
import { apiFetch } from '../services/api'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))
const toast = { success: vi.fn(), error: vi.fn() }
vi.mock('../hooks/useToast', () => ({ useToast: () => toast }))

const WORKFLOW = {
  id: 'wf1',
  name: 'Nightly sync',
  description: 'syncs things',
  workspace_id: 'ws1',
  max_concurrent_runs: 2,
  concurrency_policy: 'reject',
}

// The workspace list backing the error-handler picker: only deployed
// workflows other than wf1 itself are eligible.
const WORKSPACE_WORKFLOWS = [
  { id: 'wf1', name: 'Nightly sync', status: 'deployed' },
  { id: 'wf2', name: 'Pager', status: 'deployed' },
  { id: 'wf3', name: 'Draft thing', status: 'draft' },
]

beforeEach(() => {
  vi.clearAllMocks()
  apiFetch.mockImplementation((path, opts) => {
    if (path === '/api/workflows/wf1' && !opts) {
      return Promise.resolve({ workflow: WORKFLOW })
    }
    if (path === '/api/workspaces/ws1/workflows') {
      return Promise.resolve({ workflows: WORKSPACE_WORKFLOWS })
    }
    if (path === '/api/workflows/wf1' && opts?.method === 'PUT') {
      return Promise.resolve({ workflow: { ...WORKFLOW, ...opts.body } })
    }
    return Promise.reject(new Error(`unexpected request: ${path}`))
  })
})

function setup(props = {}) {
  return render(
    <RunSettingsPanel workflowId="wf1" open onClose={props.onClose || vi.fn()} {...props} />
  )
}

describe('RunSettingsPanel', () => {
  it('renders nothing while closed', () => {
    const { container } = render(<RunSettingsPanel workflowId="wf1" open={false} onClose={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('loads and shows the current limit and policy', async () => {
    setup()
    const limit = await screen.findByLabelText(/max concurrent runs/i)
    expect(limit).toHaveValue(2)
    expect(screen.getByLabelText(/when at the limit/i)).toHaveValue('reject')
    expect(screen.getByText(/fail immediately \(409\)/i)).toBeInTheDocument()
  })

  it('saves the edited settings and closes', async () => {
    const onClose = vi.fn()
    setup({ onClose })
    const limit = await screen.findByLabelText(/max concurrent runs/i)

    fireEvent.change(limit, { target: { value: '5' } })
    fireEvent.change(screen.getByLabelText(/when at the limit/i), { target: { value: 'queue' } })
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }))

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/workflows/wf1', {
        method: 'PUT',
        body: expect.objectContaining({
          name: 'Nightly sync',
          max_concurrent_runs: 5,
          concurrency_policy: 'queue',
        }),
      })
    )
    expect(toast.success).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('sends null for an empty limit (unlimited)', async () => {
    setup()
    const limit = await screen.findByLabelText(/max concurrent runs/i)
    fireEvent.change(limit, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }))

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/workflows/wf1', {
        method: 'PUT',
        body: expect.objectContaining({ max_concurrent_runs: null }),
      })
    )
  })

  it('rejects an out-of-range limit without calling the API', async () => {
    setup()
    const limit = await screen.findByLabelText(/max concurrent runs/i)
    fireEvent.change(limit, { target: { value: '250' } })
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }))

    expect(await screen.findByText(/whole number from 1 to 100/i)).toBeInTheDocument()
    expect(apiFetch).not.toHaveBeenCalledWith('/api/workflows/wf1', expect.objectContaining({ method: 'PUT' }))
  })

  it('loads existing SLA targets in friendly units', async () => {
    apiFetch.mockImplementation((path, opts) => {
      if (path === '/api/workflows/wf1' && !opts) {
        return Promise.resolve({
          workflow: { ...WORKFLOW, sla_max_duration_ms: 5000, sla_min_success_rate: 0.9 },
        })
      }
      return Promise.reject(new Error(`unexpected: ${path}`))
    })
    setup()
    // 5000ms → 5s, 0.9 → 90%.
    expect(await screen.findByLabelText(/max run duration/i)).toHaveValue(5)
    expect(screen.getByLabelText(/min success rate/i)).toHaveValue(90)
  })

  it('saves SLA targets converted to ms and a fraction', async () => {
    setup()
    fireEvent.change(await screen.findByLabelText(/max run duration/i), { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText(/min success rate/i), { target: { value: '95' } })
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }))

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/workflows/wf1', {
        method: 'PUT',
        body: expect.objectContaining({
          sla_max_duration_ms: 3000,
          sla_min_success_rate: 0.95,
        }),
      })
    )
  })

  it('sends null SLA targets when the fields are empty', async () => {
    setup()
    await screen.findByLabelText(/max run duration/i)
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }))
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/workflows/wf1', {
        method: 'PUT',
        body: expect.objectContaining({ sla_max_duration_ms: null, sla_min_success_rate: null }),
      })
    )
  })

  it('rejects a success rate over 100 without calling the API', async () => {
    setup()
    fireEvent.change(await screen.findByLabelText(/min success rate/i), { target: { value: '150' } })
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }))
    expect(await screen.findByText(/percentage from 0 to 100/i)).toBeInTheDocument()
    expect(apiFetch).not.toHaveBeenCalledWith('/api/workflows/wf1', expect.objectContaining({ method: 'PUT' }))
  })

  it('offers only other deployed workflows as error handlers', async () => {
    setup()
    const select = await screen.findByLabelText(/on failure, run/i)
    const labels = [...select.querySelectorAll('option')].map((o) => o.textContent)
    expect(labels).toEqual(['Nothing (default)', 'Pager'])
  })

  it('saves the chosen error handler (and null when cleared)', async () => {
    setup()
    const select = await screen.findByLabelText(/on failure, run/i)
    fireEvent.change(select, { target: { value: 'wf2' } })
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }))
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/workflows/wf1', {
        method: 'PUT',
        body: expect.objectContaining({ error_workflow_id: 'wf2' }),
      })
    )
  })

  it('flags a saved handler that is no longer deployed', async () => {
    apiFetch.mockImplementation((path, opts) => {
      if (path === '/api/workflows/wf1' && !opts) {
        return Promise.resolve({ workflow: { ...WORKFLOW, error_workflow_id: 'wf-gone' } })
      }
      if (path === '/api/workspaces/ws1/workflows') {
        return Promise.resolve({ workflows: WORKSPACE_WORKFLOWS })
      }
      return Promise.reject(new Error(`unexpected: ${path}`))
    })
    setup()
    const select = await screen.findByLabelText(/on failure, run/i)
    expect(select).toHaveValue('wf-gone')
    expect(screen.getByText('Unavailable workflow')).toBeInTheDocument()
    expect(screen.getByText(/failures are not being escalated/i)).toBeInTheDocument()
  })

  it('surfaces a server error and stays open', async () => {
    apiFetch.mockImplementation((path, opts) => {
      if (path === '/api/workflows/wf1' && !opts) return Promise.resolve({ workflow: WORKFLOW })
      return Promise.reject(new Error('Concurrency limit reached'))
    })
    const onClose = vi.fn()
    setup({ onClose })
    await screen.findByLabelText(/max concurrent runs/i)
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }))

    expect(await screen.findByText(/Concurrency limit reached/)).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })
})
