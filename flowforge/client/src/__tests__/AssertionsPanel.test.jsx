import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import AssertionsPanel from '../components/canvas/AssertionsPanel'
import { apiFetch } from '../services/api'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

const entry = (over = {}) => ({
  id: 'as-1',
  name: 'no 5xx from charge',
  predicate: 'steps.charge.output.status >= 500',
  enabled: true,
  state: 'holding',
  checked: 412,
  violations: 0,
  errors: 0,
  lastError: null,
  lastCheckedAt: '2026-08-22T10:00:00.000Z',
  lastViolationAt: null,
  lastViolationExecutionId: null,
  ...over,
})

const report = (list) => ({
  workflowId: 'wf1',
  assertions: list,
  summary: {
    total: list.length,
    violated: list.filter((a) => a.state === 'violated').length,
    broken: list.filter((a) => a.state === 'broken').length,
    holding: list.filter((a) => a.state === 'holding').length,
    unchecked: list.filter((a) => a.state === 'unchecked').length,
  },
})

const panel = (props = {}) =>
  render(<AssertionsPanel workflowId="wf1" onClose={() => {}} {...props} />)

const mockList = (list) => apiFetch.mockResolvedValue(report(list))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('AssertionsPanel', () => {
  it('lists what is pinned, with the predicate', async () => {
    mockList([entry()])
    panel()
    expect(await screen.findByText('no 5xx from charge')).toBeInTheDocument()
    expect(screen.getByText('steps.charge.output.status >= 500')).toBeInTheDocument()
    expect(screen.getByText('412 runs checked')).toBeInTheDocument()
  })

  it('shows a violation with the run that caused it', async () => {
    mockList([
      entry({
        state: 'violated',
        violations: 3,
        lastViolationExecutionId: 'e57a1234-0000-4000-8000-000000000000',
      }),
    ])
    const { container } = panel()
    await screen.findByText('no 5xx from charge')
    expect(screen.getByText('3 violations')).toBeInTheDocument()
    expect(screen.getByText('e57a1234')).toBeInTheDocument()
    expect(container.querySelector('.assertion--violated')).toBeTruthy()
  })

  // — the state a lesser panel would get wrong ————————————————————————

  it('says a broken assertion has never worked, rather than showing it green', async () => {
    // Zero violations because it has never once evaluated. Showing it beside
    // the ones that work would be actively misleading.
    mockList([
      entry({
        state: 'broken',
        checked: 0,
        errors: 412,
        lastError: 'first: expected an array',
      }),
    ])
    const { container } = panel()
    await screen.findByText('no 5xx from charge')
    expect(screen.getByText(/Threw on all 412 runs and never evaluated/)).toBeInTheDocument()
    expect(screen.getByText(/first: expected an array/)).toBeInTheDocument()
    expect(container.querySelector('.assertion--broken')).toBeTruthy()
    // And it does not claim any runs were checked.
    expect(screen.queryByText(/runs checked/)).not.toBeInTheDocument()
  })

  it('counts violated and broken in the header, separately', async () => {
    mockList([
      entry({ id: 'a', state: 'violated', violations: 1 }),
      entry({ id: 'b', name: 'other', state: 'broken', checked: 0, errors: 5, lastError: 'boom' }),
    ])
    panel()
    expect(await screen.findByText('1 violated')).toBeInTheDocument()
    expect(screen.getByText('1 broken')).toBeInTheDocument()
  })

  it('marks a disabled assertion rather than hiding it', async () => {
    mockList([entry({ enabled: false })])
    panel()
    expect(await screen.findByText('(off)')).toBeInTheDocument()
    expect(screen.getByText('Enable')).toBeInTheDocument()
  })

  // — authoring ————————————————————————————————————————————————————————

  it('explains where an assertion comes from when there are none', async () => {
    mockList([])
    panel()
    expect(await screen.findByText(/Guarantees prove what the/)).toBeInTheDocument()
    expect(screen.getByText(/then pin that same expression here/)).toBeInTheDocument()
  })

  it('pins a new one and reloads', async () => {
    apiFetch.mockResolvedValue(report([]))
    panel()
    fireEvent.click(await screen.findByText('+ Pin something that must never happen'))
    fireEvent.change(screen.getByPlaceholderText('A completed run whose charge failed'), {
      target: { value: 'charge must succeed' },
    })
    fireEvent.change(
      screen.getByPlaceholderText('status == "completed" and steps.charge.output.status >= 400'),
      { target: { value: 'steps.charge.output.status >= 400' } }
    )
    fireEvent.click(screen.getByText('Pin it'))

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/workflows/wf1/assertions',
        expect.objectContaining({
          method: 'POST',
          body: { name: 'charge must succeed', predicate: 'steps.charge.output.status >= 400' },
        })
      )
    )
  })

  it('shows why a predicate was refused rather than storing it', async () => {
    apiFetch.mockImplementation((path, opts) => {
      if (opts?.method === 'POST') {
        return Promise.reject(
          Object.assign(new Error('HTTP 400'), {
            body: { error: 'predicate does not parse: Unexpected end of input' },
          })
        )
      }
      return Promise.resolve(report([]))
    })
    panel()
    fireEvent.click(await screen.findByText('+ Pin something that must never happen'))
    fireEvent.change(screen.getByPlaceholderText('A completed run whose charge failed'), {
      target: { value: 'x' },
    })
    fireEvent.change(
      screen.getByPlaceholderText('status == "completed" and steps.charge.output.status >= 400'),
      { target: { value: 'status ==' } }
    )
    fireEvent.click(screen.getByText('Pin it'))
    expect(await screen.findByText(/predicate does not parse/)).toBeInTheDocument()
  })

  it('will not pin without both a name and a predicate', async () => {
    mockList([])
    panel()
    fireEvent.click(await screen.findByText('+ Pin something that must never happen'))
    expect(screen.getByText('Pin it')).toBeDisabled()
  })

  it('removes one', async () => {
    mockList([entry()])
    panel()
    fireEvent.click(await screen.findByText('Remove'))
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/assertions/as-1', { method: 'DELETE' })
    )
  })

  it('disables one without removing it', async () => {
    mockList([entry()])
    panel()
    fireEvent.click(await screen.findByText('Disable'))
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/assertions/as-1',
        expect.objectContaining({ method: 'PUT', body: { enabled: false } })
      )
    )
  })

  it('shows the error rather than an empty panel when loading fails', async () => {
    apiFetch.mockRejectedValue(new Error('Workflow not found'))
    panel()
    expect(await screen.findByText('Workflow not found')).toBeInTheDocument()
  })
})
