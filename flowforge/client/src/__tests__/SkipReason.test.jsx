import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

import { StepList } from '../components/execution/ExecutionPanel'

// The run panel's whole job is answering "what happened", and for a skipped
// step it has always answered with the word `skipped` — which is the fact the
// person reading it already had.

const steps = [
  { nodeId: 't', type: 'trigger-webhook', status: 'succeeded' },
  { nodeId: 'mail', type: 'action-email', status: 'skipped' },
]
const nodes = [
  { id: 't', data: { label: 'Start' } },
  { id: 'mail', data: { label: 'Send receipt' } },
]
const because = (over = {}) => ({
  nodeId: 'risky',
  label: 'High risk?',
  outcome: 'true',
  expression: 'total > 100',
  reads: [{ path: 'total', value: '850' }],
  ...over,
})

const panel = (explanations) =>
  render(<StepList steps={steps} nodes={nodes} explanations={explanations} />)

describe('a skipped step', () => {
  it('says which decision closed the path to it', () => {
    panel({ mail: because() })
    expect(screen.getByText('High risk?')).toBeInTheDocument()
    expect(screen.getByText(/that branch does not reach it/)).toBeInTheDocument()
  })

  it('shows the expression and the value it actually saw', () => {
    panel({ mail: because() })
    expect(screen.getByText(/total > 100 — total was 850/)).toBeInTheDocument()
  })

  it('distinguishes an absent field from a falsy one', () => {
    // Most of what a 3am investigation is about.
    panel({ mail: because({ reads: [{ path: 'total', value: 'not set' }] }) })
    expect(screen.getByText(/total was not set/)).toBeInTheDocument()
  })

  it('renders the expression line only when there is one', () => {
    // A left/right comparison reports no operands, because that scope is not
    // recorded per step.
    const { container } = panel({ mail: because({ expression: null, reads: [] }) })
    expect(screen.getByText(/that branch does not reach it/)).toBeInTheDocument()
    expect(container.querySelector('.step__because-expr')).toBeNull()
  })

  it('says nothing about a step that ran', () => {
    panel({ t: because(), mail: because() })
    expect(screen.getAllByText(/that branch does not reach it/)).toHaveLength(1)
  })

  it('blames the failure above it, and does not dress it as a choice', () => {
    // Only a decision is a fact about the graph. Rendering the other two the
    // same way would suggest somebody chose this.
    panel({
      mail: { kind: 'upstream-failure', nodeId: 't', label: 'Start', error: 'payload was not JSON', reads: [] },
    })
    expect(screen.getByText(/failed above it, so the run never got here/)).toBeInTheDocument()
    expect(screen.getByText('payload was not JSON')).toBeInTheDocument()
    expect(screen.queryByText(/does not reach it/)).not.toBeInTheDocument()
  })

  it('says a cancelled run was cancelled', () => {
    panel({ mail: { kind: 'cancelled', reads: [] } })
    expect(screen.getByText(/The run was cancelled before it got here/)).toBeInTheDocument()
  })

  it('renders the steps unchanged when no explanation arrived', () => {
    // A panel that failed to render its steps over a missing explanation would
    // have traded the answer for the question.
    panel(null)
    expect(screen.getByText('Send receipt')).toBeInTheDocument()
    expect(screen.queryByText(/does not reach it/)).not.toBeInTheDocument()
  })
})
