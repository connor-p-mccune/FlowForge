import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

import TestsPanel from '../components/canvas/TestsPanel'
import { apiFetch } from '../services/api'

const scenario = (id, name) => ({
  id,
  workflowId: 'wf-1',
  name,
  input: { amount: 100 },
  assertions: [{ expression: 'output.total == 100', description: 'total' }],
})

function setup() {
  return render(<TestsPanel workflowId="wf-1" open={true} onClose={vi.fn()} />)
}

describe('TestsPanel', () => {
  beforeEach(() => apiFetch.mockReset())

  it('lists the workflow scenarios on open', async () => {
    apiFetch.mockResolvedValueOnce({ tests: [scenario('t1', 'happy'), scenario('t2', 'edge')] })
    setup()
    expect(await screen.findByText('happy')).toBeInTheDocument()
    expect(screen.getByText('edge')).toBeInTheDocument()
    expect(apiFetch).toHaveBeenCalledWith('/api/workflows/wf-1/tests')
  })

  it('runs all scenarios and shows the pass/fail summary and per-assertion results', async () => {
    apiFetch.mockResolvedValueOnce({ tests: [scenario('t1', 'happy'), scenario('t2', 'edge')] })
    apiFetch.mockResolvedValueOnce({
      workflowId: 'wf-1',
      ok: false,
      total: 2,
      passed: 1,
      failed: 1,
      scenarios: [
        { id: 't1', name: 'happy', runStatus: 'completed', passed: true, assertions: [{ expression: 'output.total == 100', passed: true }] },
        { id: 't2', name: 'edge', runStatus: 'completed', passed: false, assertions: [{ expression: 'output.total == 0', passed: false, error: null }] },
      ],
    })
    setup()
    fireEvent.click(await screen.findByText('Run all'))

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/workflows/wf-1/tests/run', { method: 'POST' })
    )
    expect(await screen.findByText('1/2 passed')).toBeInTheDocument()
    expect(screen.getByText('passed')).toBeInTheDocument()
    expect(screen.getByText('failed')).toBeInTheDocument()
    // The failing assertion is shown.
    expect(screen.getByText('output.total == 0')).toBeInTheDocument()
  })

  it('runs a single scenario', async () => {
    apiFetch.mockResolvedValueOnce({ tests: [scenario('t1', 'happy')] })
    apiFetch.mockResolvedValueOnce({
      result: { id: 't1', name: 'happy', runStatus: 'completed', passed: true, assertions: [{ expression: 'output.total == 100', passed: true }] },
    })
    setup()
    fireEvent.click(await screen.findByText('Run'))
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/workflows/wf-1/tests/t1/run', { method: 'POST' })
    )
    expect(await screen.findByText('passed')).toBeInTheDocument()
  })

  it('shows an empty state and can open the add-scenario editor', async () => {
    apiFetch.mockResolvedValueOnce({ tests: [] })
    setup()
    expect(await screen.findByText(/No scenarios yet/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('+ Add scenario'))
    expect(screen.getByLabelText('Scenario name')).toBeInTheDocument()
  })

  it('validates the draft and posts a new scenario', async () => {
    apiFetch.mockResolvedValueOnce({ tests: [] }) // initial load
    setup()
    fireEvent.click(await screen.findByText('+ Add scenario'))

    // Saving with no assertion expression is rejected client-side.
    fireEvent.change(screen.getByLabelText('Scenario name'), { target: { value: 'my case' } })
    fireEvent.click(screen.getByText('Save scenario'))
    expect(await screen.findByText(/at least one assertion/i)).toBeInTheDocument()
    expect(apiFetch).toHaveBeenCalledTimes(1) // still only the initial load

    // Fill an assertion and save → POST, then reload.
    fireEvent.change(screen.getByLabelText('Assertion 1 expression'), { target: { value: 'output.total > 0' } })
    apiFetch.mockResolvedValueOnce({ test: scenario('t9', 'my case') }) // POST
    apiFetch.mockResolvedValueOnce({ tests: [scenario('t9', 'my case')] }) // reload
    fireEvent.click(screen.getByText('Save scenario'))

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/workflows/wf-1/tests', {
        method: 'POST',
        body: { name: 'my case', input: {}, assertions: [{ expression: 'output.total > 0' }] },
      })
    )
  })
})
