import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import ImpactGate from '../components/canvas/ImpactGate'

// The change that most needs saying is the one that looks like nothing.
// Deleting an edge and drawing a new one is two gestures and no visible
// difference on a canvas of forty nodes, so this is a gate at the moment the
// damage happens rather than a banner somebody scrolls past.

const finding = (over = {}) => ({
  code: 'ungated-effect',
  severity: 100,
  blocking: false,
  summary: 'Charge card now runs on every run',
  detail: 'It was gated before this change; nothing in the graph gates it now.',
  nodeId: 'c',
  subject: 'wf1:c',
  ...over,
})

const report = (over = {}) => ({
  available: true,
  workflowId: 'wf1',
  findings: [finding()],
  resolved: [],
  nodes: { added: [], removed: [] },
  summary: { introduced: 1, resolved: 0, blocking: 0, review: 1, verdict: 'review' },
  ...over,
})

const gate = (payload = report(), handlers = {}) =>
  render(<ImpactGate report={payload} onCancel={() => {}} onConfirm={() => {}} {...handlers} />)

describe('ImpactGate', () => {
  it('says what the change does, and what it is not', async () => {
    gate()
    expect(screen.getByText(/Charge card now runs on every run/)).toBeInTheDocument()
    expect(screen.getByText(/nothing in the graph gates it now/)).toBeInTheDocument()
    // The sentence that explains why a dialog is warranted at all.
    expect(screen.getByText(/most of it will not show up in a diff/)).toBeInTheDocument()
  })

  it('confirms rather than refuses', async () => {
    // An ungated payment is sometimes exactly what somebody meant, and a tool
    // that will not let you is a tool people route around.
    const onConfirm = vi.fn()
    gate(report(), { onConfirm })
    fireEvent.click(screen.getByRole('button', { name: 'Deploy anyway' }))
    expect(onConfirm).toHaveBeenCalled()
  })

  it('lets somebody go back to the canvas instead', async () => {
    const onCancel = vi.fn()
    gate(report(), { onCancel })
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('marks a finding the deploy check refuses anyway', async () => {
    // Different news: the deploy stops whether or not this dialog is confirmed.
    gate(
      report({
        findings: [finding({ code: 'guarantee-broken', blocking: true, summary: 'A guarantee no longer holds' })],
      })
    )
    expect(screen.getByText(/the deploy check refuses this anyway/)).toBeInTheDocument()
  })

  it('does not mark a finding nothing else would stop', async () => {
    gate()
    expect(screen.queryByText(/refuses this anyway/)).not.toBeInTheDocument()
  })

  it('shows what the change fixes as well', async () => {
    // Somebody who has just gated three effects deserves to see that before
    // being asked to confirm.
    gate(
      report({
        resolved: [{ code: 'effect-gated', summary: 'Fetch price is now gated', subject: 'wf1:f' }],
      })
    )
    expect(screen.getByText('What it fixes')).toBeInTheDocument()
    expect(screen.getByText('Fetch price is now gated')).toBeInTheDocument()
  })

  it('stays quiet about fixes when there are none', async () => {
    gate()
    expect(screen.queryByText('What it fixes')).not.toBeInTheDocument()
  })

  it('warns that a pair may be one node redrawn', async () => {
    gate(report({ nodes: { added: ['new'], removed: ['old'] } }))
    expect(screen.getByText(/may be one node redrawn/)).toBeInTheDocument()
  })

  it('stays quiet about node churn when only one side moved', async () => {
    gate(report({ nodes: { added: ['new'], removed: [] } }))
    expect(screen.queryByText(/one node redrawn/)).not.toBeInTheDocument()
  })

  it('renders nothing without a report, so the deploy path is unaffected', async () => {
    const { container } = render(<ImpactGate report={null} onCancel={() => {}} onConfirm={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })
})
