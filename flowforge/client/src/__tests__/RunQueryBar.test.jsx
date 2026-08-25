import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import RunQueryBar from '../components/execution/RunQueryBar'
import { apiFetch } from '../services/api'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

const RESULT = {
  workflowId: 'wf1',
  ok: true,
  runs: [{ id: 'ex-1', status: 'failed', createdAt: '2026-08-01T10:00:00.000Z' }],
  plan: {
    pushedDown: ['status == "failed"'],
    loadedSteps: false,
    scanned: 240,
    matched: 1,
    truncated: false,
    evaluationErrors: 0,
  },
}

const bar = (props = {}) =>
  render(<RunQueryBar workflowId="wf1" onResult={() => {}} active={false} {...props} />)

const input = () => screen.getByLabelText('Filter runs with an FXL predicate')
const search = () => screen.getByText('Search')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('RunQueryBar', () => {
  it('sends the predicate and hands the result up', async () => {
    apiFetch.mockResolvedValue(RESULT)
    const onResult = vi.fn()
    bar({ onResult })
    fireEvent.change(input(), { target: { value: 'status == "failed"' } })
    fireEvent.click(search())
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(RESULT))
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/workflows/wf1/query',
      expect.objectContaining({ method: 'POST', body: { where: 'status == "failed"', limit: 200 } })
    )
  })

  it('trims before sending, so a stray space is not a predicate', async () => {
    apiFetch.mockResolvedValue(RESULT)
    bar()
    fireEvent.change(input(), { target: { value: '  status == "failed"  ' } })
    fireEvent.click(search())
    await waitFor(() => expect(apiFetch.mock.calls[0][1].body.where).toBe('status == "failed"'))
  })

  it('will not search on an empty predicate', () => {
    bar()
    expect(search()).toBeDisabled()
  })

  it('offers examples to start from, and only before a search', () => {
    const { rerender } = bar()
    expect(screen.getByText('durationMs > 60000')).toBeInTheDocument()
    fireEvent.click(screen.getByText('durationMs > 60000'))
    expect(input()).toHaveValue('durationMs > 60000')

    rerender(<RunQueryBar workflowId="wf1" onResult={() => {}} active />)
    expect(screen.queryByText('waitMs > 30000')).not.toBeInTheDocument()
  })

  // — the syntax error, which is the point of returning a position ————

  it('shows a parse error in place rather than as a toast that scrolls away', async () => {
    const err = Object.assign(new Error('HTTP 400'), {
      body: { error: 'Unexpected end of input', position: 9 },
    })
    apiFetch.mockRejectedValue(err)
    bar()
    fireEvent.change(input(), { target: { value: 'status ==' } })
    fireEvent.click(search())
    expect(await screen.findByRole('alert')).toHaveTextContent('Unexpected end of input')
  })

  it('points a caret at the character the parser stopped on', async () => {
    apiFetch.mockRejectedValue(
      Object.assign(new Error('HTTP 400'), { body: { error: 'boom', position: 9 } })
    )
    const { container } = bar()
    fireEvent.change(input(), { target: { value: 'status ==' } })
    fireEvent.click(search())
    await screen.findByRole('alert')
    // Nine spaces then the caret — under the character the parser named.
    expect(container.querySelector('.run-query__caret').textContent)
      .toBe('status ==\n         ^')
  })

  it('clears the result when a search fails, so the list is not stale', async () => {
    apiFetch.mockRejectedValue(Object.assign(new Error('HTTP 400'), { body: { error: 'boom' } }))
    const onResult = vi.fn()
    bar({ onResult })
    fireEvent.change(input(), { target: { value: 'nope' } })
    fireEvent.click(search())
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(null))
  })

  it('falls back to the error message when the server sent no body', async () => {
    apiFetch.mockRejectedValue(new Error('Network unreachable'))
    bar()
    fireEvent.change(input(), { target: { value: 'status == "failed"' } })
    fireEvent.click(search())
    expect(await screen.findByRole('alert')).toHaveTextContent('Network unreachable')
  })

  // — clearing ————————————————————————————————————————————————————————

  it('offers a clear only while a query is active', () => {
    const { rerender } = bar()
    expect(screen.queryByText('Clear')).not.toBeInTheDocument()
    rerender(<RunQueryBar workflowId="wf1" onResult={() => {}} active />)
    expect(screen.getByText('Clear')).toBeInTheDocument()
  })

  it('clearing empties the field and hands back null', () => {
    const onResult = vi.fn()
    render(<RunQueryBar workflowId="wf1" onResult={onResult} active />)
    fireEvent.change(input(), { target: { value: 'status == "failed"' } })
    fireEvent.click(screen.getByText('Clear'))
    expect(input()).toHaveValue('')
    expect(onResult).toHaveBeenCalledWith(null)
  })

  it('submits on Enter, because that is what a search box does', async () => {
    apiFetch.mockResolvedValue(RESULT)
    const onResult = vi.fn()
    const { container } = bar({ onResult })
    fireEvent.change(input(), { target: { value: 'status == "failed"' } })
    fireEvent.submit(container.querySelector('form'))
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(RESULT))
  })
})
