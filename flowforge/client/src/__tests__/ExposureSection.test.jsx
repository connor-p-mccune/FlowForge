import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

import ExposureSection from '../components/analytics/ExposureSection'
import { apiFetch } from '../services/api'

// Everything else on the analytics page is about volume. This panel is the only
// one that says which workflow *matters*, and most of what is worth testing is
// what it declines to imply: that a called-only workflow scoring zero is safe,
// or that a workflow with tests is therefore fine.

const row = (over = {}) => ({
  workflowId: 'wf1',
  name: 'Order webhook',
  status: 'deployed',
  runs: { direct: 4120, called: 0, perDay: 412, observedDays: 10 },
  effects: { total: 1, unconditional: 1, inherited: 0, workflows: 1, deepest: 0, unresolved: 0 },
  exposure: { floor: 412, ceiling: 412 },
  assurance: { scenarios: 0, guarantees: 0, assertions: 0, drift: false, checked: false },
  attributed: false,
  calledBy: [],
  ...over,
})

const report = (over = {}) => ({
  available: true,
  workspaceId: 'ws1',
  windowDays: 30,
  workflows: [row()],
  queue: ['wf1'],
  summary: {
    workflows: 1,
    unreadable: 0,
    runsPerDay: 412,
    outwardPerDay: { floor: 412, ceiling: 412 },
    unchecked: 1,
    uncheckedShare: 0.78,
    offCanvas: 0,
    attributed: 0,
    ...over.summary,
  },
  ...over,
})

const setup = (payload = report(), props = {}) => {
  apiFetch.mockResolvedValue(payload)
  return render(
    <MemoryRouter>
      <ExposureSection workspaceId="ws1" days={30} {...props} />
    </MemoryRouter>
  )
}

beforeEach(() => {
  apiFetch.mockReset()
})

describe('ExposureSection', () => {
  it('leads with how much of the workspace nothing is checking', async () => {
    // Not how many workflows are unchecked — how much of what the workspace
    // does sits on them. One is a count, the other is the finding.
    setup()
    expect(await screen.findByText(/78%/)).toBeInTheDocument()
    expect(screen.getByText(/nothing is checking/)).toBeInTheDocument()
  })

  it('says so plainly when there is nothing to do', async () => {
    setup(
      report({
        workflows: [
          row({
            assurance: { scenarios: 2, guarantees: 0, assertions: 0, drift: false, checked: true },
          }),
        ],
        queue: [],
        summary: { unchecked: 0, uncheckedShare: 0 },
      })
    )
    expect(
      await screen.findByText(/Every workflow that does anything has something checking it/)
    ).toBeInTheDocument()
  })

  it('collapses the interval when its ends agree', async () => {
    // "412" says more than "412 – 412".
    const { container } = setup()
    await screen.findByText(/nothing is checking/)
    const cell = container.querySelector('tbody td')
    expect(cell.textContent).toBe('412')
  })

  it('shows both ends when gates are doing the work', async () => {
    const { container } = setup(
      report({
        workflows: [
          row({
            exposure: { floor: 0, ceiling: 96 },
            effects: { total: 4, unconditional: 0, inherited: 0, workflows: 1, deepest: 0, unresolved: 0 },
          }),
        ],
      })
    )
    await screen.findByText(/nothing is checking/)
    expect(container.querySelector('tbody td').textContent).toBe('0 – 96')
  })

  it('names the callers a called-only workflow was counted under', async () => {
    // A bare zero would read as "harmless" when it means "attributed
    // elsewhere".
    setup(
      report({
        workflows: [
          row({
            name: 'Send alert',
            runs: { direct: 0, called: 4120, perDay: 0, observedDays: 0 },
            exposure: { floor: 0, ceiling: 0 },
            attributed: true,
            calledBy: ['Orders', 'Refunds'],
          }),
        ],
      })
    )
    expect(await screen.findByText(/via Orders, Refunds/)).toBeInTheDocument()
  })

  it('counts the kinds of check without summing them', async () => {
    setup(
      report({
        workflows: [
          row({
            assurance: { scenarios: 3, guarantees: 1, assertions: 0, drift: true, checked: true },
          }),
        ],
        queue: [],
        summary: { unchecked: 0, uncheckedShare: 0 },
      })
    )
    expect(await screen.findByText('3 scenarios, 1 guarantee, drift')).toBeInTheDocument()
  })

  it('flags the effects that are not on any canvas', async () => {
    setup(
      report({
        workflows: [
          row({
            effects: { total: 5, unconditional: 1, inherited: 4, workflows: 2, deepest: 2, unresolved: 0 },
          }),
        ],
        summary: { offCanvas: 4 },
      })
    )
    expect(await screen.findByText(/4 off-canvas/)).toBeInTheDocument()
    expect(screen.getByText(/no single canvas shows them/)).toBeInTheDocument()
  })

  it('links a workflow to its canvas', async () => {
    setup()
    expect(await screen.findByRole('link', { name: 'Order webhook' })).toHaveAttribute(
      'href',
      '/workflow/wf1'
    )
  })

  it('distinguishes an empty workspace from one it could not read', async () => {
    const { unmount } = setup(
      report({ workflows: [], queue: [], summary: { workflows: 0, unchecked: 0 } })
    )
    expect(await screen.findByText(/No workflows in this workspace yet/)).toBeInTheDocument()
    unmount()

    setup(
      report({
        workflows: [],
        queue: [],
        summary: { workflows: 0, unreadable: 2, unchecked: 0 },
      })
    )
    expect(await screen.findByText(/could be read \(2 unreadable\)/)).toBeInTheDocument()
  })

  it('reports a failed read rather than rendering an empty ranking', async () => {
    // A blank table would read as "nothing here is risky", which is the one
    // thing this panel must never say by accident.
    apiFetch.mockRejectedValue(new Error('nope'))
    render(
      <MemoryRouter>
        <ExposureSection workspaceId="ws1" days={30} />
      </MemoryRouter>
    )
    expect(await screen.findByText(/Unable to load — nope/)).toBeInTheDocument()
  })

  it('asks for the window the page is showing', async () => {
    setup(report(), { days: 7 })
    await screen.findByText(/nothing is checking/)
    expect(apiFetch).toHaveBeenCalledWith('/api/workspaces/ws1/exposure?days=7')
  })
})
