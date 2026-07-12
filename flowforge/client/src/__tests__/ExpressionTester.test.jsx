import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import ExpressionTester from '../components/canvas/ExpressionTester'
import { apiFetch } from '../services/api'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

beforeEach(() => {
  apiFetch.mockReset()
})

describe('ExpressionTester', () => {
  it('starts collapsed and opens on click', () => {
    render(<ExpressionTester expression="amount > 100" sampleScope='{ "amount": 200 }' />)
    expect(screen.queryByText('Sample data (JSON)')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText(/Try this expression/))
    expect(screen.getByText('Sample data (JSON)')).toBeInTheDocument()
  })

  it('evaluates the expression against the sample scope and shows the result', async () => {
    apiFetch.mockResolvedValue({ ok: true, result: true, resultType: 'boolean' })
    render(<ExpressionTester expression="amount > 100" sampleScope='{ "amount": 200 }' />)
    fireEvent.click(screen.getByText(/Try this expression/))
    fireEvent.click(screen.getByRole('button', { name: 'Evaluate' }))

    await waitFor(() => expect(screen.getByText('boolean')).toBeInTheDocument())
    expect(apiFetch).toHaveBeenCalledWith('/api/expressions/evaluate', {
      method: 'POST',
      body: { expression: 'amount > 100', scope: { amount: 200 } },
    })
    expect(screen.getByText('true')).toBeInTheDocument()
  })

  it('renders an FXL error returned with ok:false', async () => {
    apiFetch.mockResolvedValue({ ok: false, error: 'Cannot use "abc" as a number', position: null })
    render(<ExpressionTester expression='"abc" * 2' sampleScope="{}" />)
    fireEvent.click(screen.getByText(/Try this expression/))
    fireEvent.click(screen.getByRole('button', { name: 'Evaluate' }))
    await waitFor(() => expect(screen.getByText(/as a number/)).toBeInTheDocument())
  })

  it('rejects invalid sample JSON before calling the API', async () => {
    render(<ExpressionTester expression="x" sampleScope="{ not json" />)
    fireEvent.click(screen.getByText(/Try this expression/))
    fireEvent.click(screen.getByRole('button', { name: 'Evaluate' }))
    await waitFor(() => expect(screen.getByText(/not valid JSON/)).toBeInTheDocument())
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('disables evaluation when there is no expression', () => {
    render(<ExpressionTester expression="" sampleScope="{}" />)
    fireEvent.click(screen.getByText(/Try this expression/))
    expect(screen.getByRole('button', { name: 'Evaluate' })).toBeDisabled()
  })
})
