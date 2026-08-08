import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

import CostSection, { formatUsd } from '../components/analytics/CostSection'
import { ToastProvider } from '../hooks/useToast'
import { apiFetch } from '../services/api'

const payload = (over = {}) => ({
  groupBy: 'workflow',
  total: 4_000_000,
  budget: {
    month: '2026-08',
    spentMicroUsd: 4_000_000,
    capMicroUsd: 10_000_000,
    alertPct: 0.8,
    usedFraction: 0.4,
    blocked: false,
  },
  breakdown: [
    { key: 'wf1', name: 'Nightly sync', runs: 12, microUsd: 3_000_000, display: '$3.00' },
    { key: 'wf2', name: 'Digest', runs: 4, microUsd: 1_000_000, display: '$1.00' },
  ],
  ...over,
})

const setup = (props = {}) =>
  render(
    <ToastProvider>
      <CostSection workspaceId="ws1" {...props} />
    </ToastProvider>
  )

describe('formatUsd', () => {
  it('keeps sub-cent figures legible instead of rounding them to zero', () => {
    // A single AI call routinely costs less than a cent; $0.00 everywhere would
    // make the per-step view useless exactly where it matters most.
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(50)).toBe('<$0.0001')
    expect(formatUsd(4200)).toBe('$0.0042')
    expect(formatUsd(1_230_000)).toBe('$1.23')
  })
})

describe('CostSection', () => {
  beforeEach(() => {
    apiFetch.mockReset()
  })

  it('shows the month’s spend against the cap with what is left', async () => {
    apiFetch.mockResolvedValue(payload())
    setup()
    // The remaining-balance line is the unique one: "$4.00" also appears as the
    // breakdown's total, which is the same number arrived at another way.
    expect(await screen.findByText(/40% used · \$6\.00 left this month/)).toBeInTheDocument()
    expect(screen.getByText(/of \$10\.00/)).toBeInTheDocument()
  })

  it('says plainly that runs are being refused once the budget is reached', async () => {
    // "Blocked" and "80% used" need different copy: one is a warning, the other
    // is an outage someone is currently experiencing.
    apiFetch.mockResolvedValue(
      payload({
        budget: {
          month: '2026-08',
          spentMicroUsd: 12_000_000,
          capMicroUsd: 10_000_000,
          alertPct: 0.8,
          usedFraction: 1.2,
          blocked: true,
        },
      })
    )
    setup()
    expect(await screen.findByText(/new runs are being refused/i)).toBeInTheDocument()
    // …and that the escape hatches still work, since that is the first question.
    expect(screen.getByText(/dry runs still work/i)).toBeInTheDocument()
  })

  it('reports an unset budget without pretending there is a cap', async () => {
    apiFetch.mockResolvedValue(
      payload({ budget: { month: '2026-08', spentMicroUsd: 4_000_000, capMicroUsd: null, blocked: false } })
    )
    setup()
    expect(await screen.findByText(/no budget set/)).toBeInTheDocument()
  })

  it('offers the edit control only to an owner', async () => {
    apiFetch.mockResolvedValue(payload())
    const { unmount } = setup({ canEdit: false })
    expect(await screen.findByText(/40% used/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Change' })).not.toBeInTheDocument()
    unmount()

    setup({ canEdit: true })
    expect(await screen.findByRole('button', { name: 'Change' })).toBeInTheDocument()
  })

  it('treats an empty cap field as removing the budget, not as zero', async () => {
    // Zero would mean "block everything" — nobody types that on purpose, but
    // everyone reaches it by clearing the box.
    apiFetch.mockResolvedValue(payload())
    setup({ canEdit: true })
    fireEvent.click(await screen.findByRole('button', { name: 'Change' }))
    fireEvent.change(screen.getByLabelText('Monthly budget cap in USD'), {
      target: { value: '' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      const put = apiFetch.mock.calls.find(([, opts]) => opts?.method === 'PUT')
      expect(put[1].body).toEqual({ capUsd: null })
    })
  })

  it('regroups the breakdown through the API', async () => {
    apiFetch.mockResolvedValue(payload())
    setup()
    await screen.findByText('Nightly sync')
    fireEvent.click(screen.getByRole('button', { name: 'By node type' }))
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('groupBy=nodeType'))
    )
  })

  it('explains why external calls show as unpriced', async () => {
    // Otherwise a zero next to a busy HTTP node reads as a bug rather than as
    // "we deliberately don't guess what your vendor charges".
    apiFetch.mockResolvedValue(
      payload({
        groupBy: 'nodeType',
        breakdown: [{ key: 'action-http', steps: 40, microUsd: 0, display: '$0.00' }],
      })
    )
    setup()
    fireEvent.click(await screen.findByRole('button', { name: 'By node type' }))
    expect(await screen.findByText(/can’t know what a third-party API charges/)).toBeInTheDocument()
  })

  it('explains an empty month rather than showing a bare zero', async () => {
    apiFetch.mockResolvedValue(payload({ total: 0, breakdown: [] }))
    setup()
    expect(await screen.findByText(/Nothing metered this month/)).toBeInTheDocument()
  })
})
