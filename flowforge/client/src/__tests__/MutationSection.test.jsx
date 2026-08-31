import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import MutationSection from '../components/canvas/MutationSection'
import { apiFetch } from '../services/api'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

const mutant = (over = {}) => ({
  id: 'm1',
  operator: 'swap-branches',
  nodeId: 'check',
  describe: '"Large order?" wired backwards — its true and false branches swapped',
  killed: true,
  by: 'test',
  detail: 'a large order is tagged large',
  ...over,
})

const report = (list, over = {}) => {
  const killed = list.filter((m) => m.killed)
  return {
    available: true,
    workflowId: 'wf1',
    scenarios: 2,
    guarantees: 1,
    mutants: list,
    summary: {
      total: list.length,
      killed: killed.length,
      survived: list.length - killed.length,
      score: list.length ? Math.round((killed.length / list.length) * 100) : null,
      byLint: killed.filter((m) => m.by === 'lint').length,
      byGuarantee: killed.filter((m) => m.by === 'guarantee').length,
      byTest: killed.filter((m) => m.by === 'test').length,
    },
    ...over,
  }
}

const section = () => render(<MutationSection workflowId="wf1" />)
const check = () => screen.getByText('Check')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('MutationSection', () => {
  it('explains what it does before anybody presses anything', async () => {
    section()
    expect(screen.getByText(/Introduces a plausible bug/)).toBeInTheDocument()
    expect(screen.getByText(/a gap in the\s+checks, not a bug in the workflow/)).toBeInTheDocument()
  })

  it('runs nothing until asked', () => {
    // Every surviving mutant costs a full pass of the scenario suite. A panel
    // that started a hundred and sixty dry runs because it was opened is one
    // people stop opening.
    section()
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('posts when asked, because the analysis executes', async () => {
    apiFetch.mockResolvedValue(report([mutant()]))
    section()
    fireEvent.click(check())
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/workflows/wf1/mutations', { method: 'POST' })
    )
  })

  // — the finding ————————————————————————————————————————————————————

  it('leads with how many bugs would get through', async () => {
    apiFetch.mockResolvedValue(
      report([mutant(), mutant({ id: 'm2', killed: false, by: null })])
    )
    section()
    fireEvent.click(check())
    expect(await screen.findByText('1 of 2 bugs would get through.')).toBeInTheDocument()
  })

  it('names each survivor, because a percentage names none of them', async () => {
    apiFetch.mockResolvedValue(
      report([
        mutant({
          id: 'm2',
          killed: false,
          by: null,
          describe: '"Approve refund" removed — the graph runs straight past the gate',
        }),
      ])
    )
    section()
    fireEvent.click(check())
    expect(
      await screen.findByText('"Approve refund" removed — the graph runs straight past the gate')
    ).toBeInTheDocument()
  })

  it('says what would fix a survivor', async () => {
    apiFetch.mockResolvedValue(report([mutant({ killed: false, by: null })]))
    section()
    fireEvent.click(check())
    expect(await screen.findByText(/asserts on what the workflow/)).toBeInTheDocument()
  })

  it('says so plainly when nothing got through', async () => {
    apiFetch.mockResolvedValue(report([mutant(), mutant({ id: 'm2' })]))
    section()
    fireEvent.click(check())
    expect(await screen.findByText('Every one of the 2 bugs was caught.')).toBeInTheDocument()
  })

  it('shows what caught each of the ones that were caught', async () => {
    apiFetch.mockResolvedValue(
      report([mutant({ by: 'guarantee' }), mutant({ id: 'm2', by: 'lint' })])
    )
    section()
    fireEvent.click(check())
    expect(await screen.findByText(/caught by a guarantee/)).toBeInTheDocument()
    expect(screen.getByText(/caught by the linter/)).toBeInTheDocument()
  })

  it('warns when the linter is the only thing checking the workflow', async () => {
    apiFetch.mockResolvedValue(
      report([mutant({ by: 'lint' })], { scenarios: 0, guarantees: 0 })
    )
    section()
    fireEvent.click(check())
    expect(await screen.findByText(/no scenarios and no guarantees/)).toBeInTheDocument()
  })

  it('states the equivalent-mutant caveat rather than presenting the count as exact', async () => {
    apiFetch.mockResolvedValue(report([mutant()]))
    section()
    fireEvent.click(check())
    expect(await screen.findByText(/no algorithm can tell those apart/)).toBeInTheDocument()
  })

  // — the unavailable cases ————————————————————————————————————————

  it('says so when there is nothing to mutate', async () => {
    apiFetch.mockResolvedValue({ available: false, reason: 'no-mutations' })
    section()
    fireEvent.click(check())
    expect(
      await screen.findByText(/no conditions, gates or removable steps/)
    ).toBeInTheDocument()
  })

  it('shows the error rather than nothing when the check fails', async () => {
    apiFetch.mockRejectedValue(new Error('Workflow not found'))
    section()
    fireEvent.click(check())
    expect(await screen.findByText('Workflow not found')).toBeInTheDocument()
  })

  it('disables the button while it is working', async () => {
    let settle
    apiFetch.mockReturnValue(new Promise((resolve) => { settle = resolve }))
    section()
    fireEvent.click(check())
    expect(await screen.findByText('Checking…')).toBeDisabled()
    settle(report([mutant()]))
    await waitFor(() => expect(screen.getByText('Check')).not.toBeDisabled())
  })
})

// The mutant is the diagnosis; the witness is the prescription. Where the
// solver found an input the two graphs disagree on, it belongs against the
// survivor rather than in a summary — copyable into a scenario without hunting.
describe('MutationSection — witnesses', () => {
  const survivor = (over = {}) =>
    mutant({
      id: 'm2',
      killed: false,
      by: null,
      operator: 'off-by-one',
      describe: '"Large order?" off by one — 100 became 101',
      ...over,
    })

  it('shows the input that would have caught a survivor', async () => {
    apiFetch.mockResolvedValue(
      report([
        survivor({
          witness: { triggerData: { total: 101 }, assumptions: [] },
          suggestion: 'assert on which branch "check" takes with this input',
        }),
      ])
    )
    section()
    fireEvent.click(check())
    expect(await screen.findByText('{"total":101}')).toBeInTheDocument()
    expect(screen.getByText(/assert on which branch "check" takes/)).toBeInTheDocument()
  })

  it('falls back to the general advice when the solver found nothing', async () => {
    // An equivalent mutation has no distinguishing input, and inventing one
    // would be worse than saying what generally kills these.
    apiFetch.mockResolvedValue(report([survivor()]))
    section()
    fireEvent.click(check())
    expect(await screen.findByText(/asserts on what the workflow/)).toBeInTheDocument()
  })

  it('does not repeat the general advice once a witness is shown', async () => {
    apiFetch.mockResolvedValue(
      report([survivor({ witness: { triggerData: { total: 101 }, assumptions: [] } })])
    )
    section()
    fireEvent.click(check())
    await screen.findByText('{"total":101}')
    expect(screen.queryByText(/asserts on what the workflow/)).not.toBeInTheDocument()
  })
})
