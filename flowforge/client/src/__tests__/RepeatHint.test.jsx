import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

import RepeatHint from '../components/canvas/RepeatHint'
import { apiFetch } from '../services/api'

// The recovery dropdown's middle option asserts that this workflow's steps are
// idempotent. The graph can answer that, and this is where it does — beside the
// setting, while somebody is choosing it.

const step = (over = {}) => ({
  nodeId: 'charge',
  label: 'Charge card',
  type: 'action-http',
  verdict: 'unsafe',
  retried: true,
  why: 'a POST with no idempotency key',
  ...over,
})

const report = (over = {}) => ({
  available: true,
  workflowId: 'wf1',
  steps: [step()],
  recovery: { policy: 'safe', verdict: 'blocks-recovery', why: '' },
  summary: {
    steps: 1,
    safe: 0,
    guarded: 0,
    unsafe: 1,
    billed: 0,
    unknown: 0,
    opaque: 0,
    maxAttempts: 3,
    retriedUnsafe: 1,
    declaredButUnsendable: 0,
    ...over.summary,
  },
  ...over,
})

const hint = (payload = report(), policy = 'safe') => {
  apiFetch.mockResolvedValue(payload)
  return render(<RepeatHint workflowId="wf1" policy={policy} />)
}

beforeEach(() => {
  apiFetch.mockReset()
})

describe('RepeatHint', () => {
  it('warns about the retries that need no crash at all', async () => {
    // Independent of the dropdown: the engine retries most nodes on every run.
    hint()
    expect(
      await screen.findByText(/would repeat their work on an ordinary retry/)
    ).toBeInTheDocument()
    expect(screen.getByText(/Nothing has to crash for this/)).toBeInTheDocument()
  })

  it('shows that warning whatever the policy says', async () => {
    hint(report(), 'manual')
    expect(await screen.findByText(/ordinary retry/)).toBeInTheDocument()
  })

  it('contradicts a resume policy the graph does not support', async () => {
    hint(report(), 'resume')
    // Scoped to the contradiction paragraph: the node is also named in the
    // retry warning above it, and asserting on the document would pass on
    // either.
    const claim = await screen.findByText(/steps are not all idempotent/)
    expect(claim.closest('p').textContent).toMatch(/Charge card/)
  })

  it('judges the option on screen, not the one the server read', async () => {
    // The report describes the saved policy. Telling somebody only after they
    // save would be telling them too late.
    hint(report({ recovery: { policy: 'safe', verdict: 'blocks-recovery', why: '' } }), 'resume')
    expect(await screen.findByText(/not all idempotent/)).toBeInTheDocument()
  })

  it('says nothing about idempotence when the policy does not claim it', async () => {
    hint(report(), 'safe')
    await screen.findByText(/ordinary retry/)
    expect(screen.queryByText(/not all idempotent/)).not.toBeInTheDocument()
  })

  it('trims a long list rather than printing fifteen node names', async () => {
    const many = report({
      steps: [1, 2, 3, 4, 5, 6].map((n) => step({ nodeId: `n${n}`, label: `Node ${n}`, retried: false })),
      summary: { unsafe: 6, retriedUnsafe: 0 },
    })
    hint(many, 'resume')
    expect(await screen.findByText(/and 2 more/)).toBeInTheDocument()
  })

  it('says so plainly when nothing would repeat its work', async () => {
    const clean = report({
      steps: [step({ verdict: 'safe', why: 'a GET reads' })],
      summary: { unsafe: 0, safe: 1, retriedUnsafe: 0 },
    })
    hint(clean, 'resume')
    expect(
      await screen.findByText(/Nothing this workflow does would repeat its work/)
    ).toBeInTheDocument()
  })

  it('points at the declaration that fixes it', async () => {
    hint()
    expect(await screen.findByText(/every attempt carries the same/)).toBeInTheDocument()
  })

  it('renders nothing when the workflow has no steps a repeat would touch', async () => {
    const { container } = hint(report({ steps: [], summary: { steps: 0, unsafe: 0, retriedUnsafe: 0 } }))
    await new Promise((r) => setTimeout(r, 0))
    expect(container).toBeEmptyDOMElement()
  })

  it('stays quiet when the read fails rather than claiming anything', async () => {
    // A settings panel is not the place to render an error about an advisory.
    apiFetch.mockRejectedValue(new Error('nope'))
    const { container } = render(<RepeatHint workflowId="wf1" policy="resume" />)
    await new Promise((r) => setTimeout(r, 0))
    expect(container).toBeEmptyDOMElement()
  })
})
