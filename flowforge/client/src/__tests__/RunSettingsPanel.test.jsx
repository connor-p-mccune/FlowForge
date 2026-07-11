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
  max_concurrent_runs: 2,
  concurrency_policy: 'reject',
}

beforeEach(() => {
  vi.clearAllMocks()
  apiFetch.mockImplementation((path, opts) => {
    if (path === '/api/workflows/wf1' && !opts) {
      return Promise.resolve({ workflow: WORKFLOW })
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
    fireEvent.click(screen.getByRole('button', { name: /save limits/i }))

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
    fireEvent.click(screen.getByRole('button', { name: /save limits/i }))

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
    fireEvent.click(screen.getByRole('button', { name: /save limits/i }))

    expect(await screen.findByText(/whole number from 1 to 100/i)).toBeInTheDocument()
    expect(apiFetch).not.toHaveBeenCalledWith('/api/workflows/wf1', expect.objectContaining({ method: 'PUT' }))
  })

  it('surfaces a server error and stays open', async () => {
    apiFetch.mockImplementation((path, opts) => {
      if (path === '/api/workflows/wf1' && !opts) return Promise.resolve({ workflow: WORKFLOW })
      return Promise.reject(new Error('Concurrency limit reached'))
    })
    const onClose = vi.fn()
    setup({ onClose })
    await screen.findByLabelText(/max concurrent runs/i)
    fireEvent.click(screen.getByRole('button', { name: /save limits/i }))

    expect(await screen.findByText(/Concurrency limit reached/)).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })
})
