import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import ChaosSection from '../components/canvas/ChaosSection'
import { apiFetch } from '../services/api'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))
vi.mock('../hooks/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}))

const ARMED = {
  workflowId: 'wf-1',
  active: true,
  profile: {
    enabled: true,
    scope: 'dry-run',
    expiresAt: new Date(Date.now() + 4 * 3600_000).toISOString(),
    rules: [{ mode: 'fail', nodeType: 'action-http', probability: 1 }],
  },
}

describe('ChaosSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiFetch.mockResolvedValue({ workflowId: 'wf-1', profile: null, active: false })
  })

  it('offers to arm a profile when none exists', async () => {
    render(<ChaosSection workflowId="wf-1" />)
    expect(await screen.findByRole('button', { name: 'Arm a profile' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Disarm' })).not.toBeInTheDocument()
  })

  it('summarises an armed profile with its scope and remaining time', async () => {
    apiFetch.mockResolvedValue(ARMED)
    render(<ChaosSection workflowId="wf-1" />)
    expect(await screen.findByText(/Armed · 1 rule · test runs only · 4 h left/)).toBeInTheDocument()
  })

  it('distinguishes an expired profile from an armed one', async () => {
    apiFetch.mockResolvedValue({
      ...ARMED,
      active: false,
      profile: { ...ARMED.profile, expiresAt: new Date(Date.now() - 1000).toISOString() },
    })
    render(<ChaosSection workflowId="wf-1" />)
    expect(await screen.findByText(/^Expired/)).toBeInTheDocument()
  })

  it('arms a profile with a duration rather than a timestamp', async () => {
    render(<ChaosSection workflowId="wf-1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Arm a profile' }))
    fireEvent.click(screen.getByRole('button', { name: 'Arm profile' }))

    await waitFor(() => {
      const call = apiFetch.mock.calls.find(([, options]) => options?.method === 'PUT')
      expect(call).toBeTruthy()
      const { scope, expiresAt, rules } = call[1].body
      expect(scope).toBe('dry-run')
      // The form asks "for how long?"; the API takes an instant.
      expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now())
      expect(rules[0].mode).toBe('fail')
    })
  })

  it('warns in plain words before widening a profile to real traffic', async () => {
    render(<ChaosSection workflowId="wf-1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Arm a profile' }))
    expect(screen.queryByText(/Real runs will fail on purpose/)).not.toBeInTheDocument()

    fireEvent.change(screen.getByDisplayValue('Test runs only (safe)'), {
      target: { value: 'all' },
    })
    expect(screen.getByText(/Real runs will fail on purpose/)).toBeInTheDocument()
    expect(screen.getByText(/recorded in the audit log/)).toBeInTheDocument()
  })

  it('reports malformed rule JSON without calling the API', async () => {
    render(<ChaosSection workflowId="wf-1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Arm a profile' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '{ not json' } })
    fireEvent.click(screen.getByRole('button', { name: 'Arm profile' }))

    expect(await screen.findByText(/Rules are not valid JSON/)).toBeInTheDocument()
    expect(apiFetch.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false)
  })

  it('surfaces a server refusal inline', async () => {
    apiFetch.mockImplementation((path, options) => {
      if (options?.method === 'PUT') {
        return Promise.reject(new Error('Only workspace owners can inject faults into real runs'))
      }
      return Promise.resolve({ profile: null, active: false })
    })
    render(<ChaosSection workflowId="wf-1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Arm a profile' }))
    fireEvent.click(screen.getByRole('button', { name: 'Arm profile' }))
    expect(await screen.findByText(/Only workspace owners/)).toBeInTheDocument()
  })

  it('disarms an armed profile', async () => {
    apiFetch.mockResolvedValue(ARMED)
    render(<ChaosSection workflowId="wf-1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Disarm' }))
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/workflows/wf-1/chaos', { method: 'DELETE' })
    )
  })
})
