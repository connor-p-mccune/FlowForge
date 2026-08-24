import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import ContractGate from '../components/canvas/ContractGate'

const REPORT = {
  available: true,
  workflowId: 'wf1',
  name: 'Fulfilment',
  before: { describe: '{ orderId: string }', fields: ['orderId'] },
  after: { describe: '{ total: number }', fields: ['total'] },
  change: { removed: [{ path: 'orderId', was: 'string' }], widened: [], weakened: [], added: [] },
  callers: [
    {
      workflowId: 'wf2',
      name: 'Orders',
      status: 'deployed',
      breaks: [
        {
          nodeId: 'call',
          label: 'Fulfil order',
          reference: 'call.orderId',
          path: 'orderId',
          missing: 'orderId',
          reason: 'removed',
          suggestion: 'order_id',
        },
      ],
    },
    { workflowId: 'wf3', name: 'Reports', status: 'deployed', breaks: [] },
  ],
  summary: { verdict: 'breaking', callers: 2, broken: 1, references: 1 },
}

const gate = (props = {}) =>
  render(<ContractGate report={REPORT} onCancel={() => {}} onConfirm={() => {}} {...props} />)

describe('ContractGate', () => {
  it('counts only the workflows that actually break', () => {
    gate()
    // Two callers, one broken. Saying "2" would be counting a workflow that is
    // fine, which is how a warning stops being believed.
    expect(screen.getByText('This breaks 1 other workflow')).toBeInTheDocument()
    expect(screen.queryByText('Reports')).not.toBeInTheDocument()
  })

  it('names the caller, the reference and the node it sits in', () => {
    gate()
    expect(screen.getByText('Orders')).toBeInTheDocument()
    expect(screen.getByText('{{call.orderId}}')).toBeInTheDocument()
    expect(screen.getByText(/in Fulfil order/)).toBeInTheDocument()
  })

  it('suggests the field somebody probably meant', () => {
    gate()
    expect(screen.getByText(/did you mean/)).toBeInTheDocument()
    expect(screen.getByText('order_id')).toBeInTheDocument()
  })

  it('says what the failure will actually look like', () => {
    // Not a crash — an empty value. Somebody deciding whether to deploy needs
    // to know which, because the two get investigated very differently.
    gate()
    expect(screen.getByText(/the value will simply arrive empty/)).toBeInTheDocument()
  })

  it('lists what went from the returned shape', () => {
    gate()
    expect(screen.getByText(/Gone from what this workflow returns: orderId/)).toBeInTheDocument()
  })

  it('confirms rather than refuses, because fixing the callers is a valid plan', () => {
    const onConfirm = vi.fn()
    gate({ onConfirm })
    fireEvent.click(screen.getByText('Deploy anyway'))
    expect(onConfirm).toHaveBeenCalled()
  })

  it('lets the author back out', () => {
    const onCancel = vi.fn()
    gate({ onCancel })
    fireEvent.click(screen.getByText('Keep editing'))
    expect(onCancel).toHaveBeenCalled()
  })

  it('closes on the backdrop but not on the panel', () => {
    const onCancel = vi.fn()
    const { baseElement } = gate({ onCancel })
    fireEvent.click(screen.getByRole('dialog'))
    expect(onCancel).not.toHaveBeenCalled()
    fireEvent.click(baseElement.querySelector('.contract-gate-root'))
    expect(onCancel).toHaveBeenCalled()
  })

  it('renders nothing without a report', () => {
    const { baseElement } = render(<ContractGate report={null} onCancel={() => {}} onConfirm={() => {}} />)
    expect(baseElement.querySelector('.contract-gate')).toBeNull()
  })

  it('pluralises for several broken workflows', () => {
    render(
      <ContractGate
        report={{
          ...REPORT,
          callers: [REPORT.callers[0], { ...REPORT.callers[0], workflowId: 'wf4', name: 'Invoices' }],
          summary: { verdict: 'breaking', callers: 2, broken: 2, references: 2 },
        }}
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    )
    expect(screen.getByText('This breaks 2 other workflows')).toBeInTheDocument()
    expect(screen.getByText(/2 references in other workflows/)).toBeInTheDocument()
  })
})
