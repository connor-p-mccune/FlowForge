import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import NodeConfigPanel from '../components/canvas/NodeConfigPanel'

const mk = (type, { label = 'Node', config = {} } = {}) => ({
  id: 'n1',
  type,
  data: { label, config },
})

function setup(node, overrides = {}) {
  const handlers = {
    onChange: vi.fn(),
    onClose: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  }
  const utils = render(<NodeConfigPanel node={node} {...handlers} />)
  return { ...handlers, ...utils }
}

describe('NodeConfigPanel rendering', () => {
  it('renders nothing when no node is selected', () => {
    const { container } = setup(null)
    expect(container).toBeEmptyDOMElement()
  })

  it('always shows the label field and the node id', () => {
    setup(mk('trigger-manual'))
    expect(screen.getByText('Label')).toBeInTheDocument()
    expect(screen.getByText('n1')).toBeInTheDocument()
  })

  it('renders HTTP fields for action-http', () => {
    setup(mk('action-http'))
    expect(screen.getByText('Method')).toBeInTheDocument()
    expect(screen.getByText('URL')).toBeInTheDocument()
    expect(screen.getByText('Headers (JSON)')).toBeInTheDocument()
    expect(screen.getByText(/^Body/)).toBeInTheDocument()
  })

  it('renders a delay field for action-delay', () => {
    setup(mk('action-delay'))
    expect(screen.getByText(/Delay \(milliseconds\)/)).toBeInTheDocument()
  })

  it('renders condition fields for condition', () => {
    setup(mk('condition'))
    expect(screen.getByText(/Left value/)).toBeInTheDocument()
    expect(screen.getByText('Operator')).toBeInTheDocument()
    expect(screen.getByText('Right value')).toBeInTheDocument()
  })

  it('swaps to an expression editor when the condition operator is expression', () => {
    setup(mk('condition', { config: { operator: 'expression', expression: 'amount > 100' } }))
    expect(screen.getByText(/Expression \(true \/ false\)/)).toBeInTheDocument()
    expect(screen.getByDisplayValue('amount > 100')).toBeInTheDocument()
    // The simple-comparison fields are hidden in expression mode.
    expect(screen.queryByText(/Left value/)).not.toBeInTheDocument()
    expect(screen.queryByText('Right value')).not.toBeInTheDocument()
  })

  it('renders source + predicate editors for the filter node', () => {
    setup(mk('filter', { config: { source: '{{h1.body}}', predicate: 'price > 10' } }))
    expect(screen.getByText(/Source list/)).toBeInTheDocument()
    expect(screen.getByText(/Keep items where/)).toBeInTheDocument()
    expect(screen.getByDisplayValue('{{h1.body}}')).toBeInTheDocument()
    expect(screen.getByDisplayValue('price > 10')).toBeInTheDocument()
  })

  it('renders source + mapping editors for the map node', () => {
    setup(mk('map', { config: { source: '{{h1.body}}', mapping: '{ id: item.id }' } }))
    expect(screen.getByText(/Source list/)).toBeInTheDocument()
    expect(screen.getByText(/Map each item to/)).toBeInTheDocument()
    expect(screen.getByDisplayValue('{ id: item.id }')).toBeInTheDocument()
  })

  it('renders source + value + group-by editors for the aggregate node', () => {
    setup(mk('aggregate', { config: { source: '{{h1.body}}', value: 'price * qty', groupBy: 'item.region' } }))
    expect(screen.getByText(/Value to aggregate/)).toBeInTheDocument()
    expect(screen.getByText(/Group by/)).toBeInTheDocument()
    expect(screen.getByDisplayValue('price * qty')).toBeInTheDocument()
    expect(screen.getByDisplayValue('item.region')).toBeInTheDocument()
  })

  it('renders approval fields with the timeout policy for approval', () => {
    setup(mk('approval', { config: { message: 'Ship it?', timeoutMinutes: 30, onTimeout: 'fail' } }))
    expect(screen.getByText(/Message for approvers/)).toBeInTheDocument()
    expect(screen.getByDisplayValue('Ship it?')).toBeInTheDocument()
    expect(screen.getByText('Timeout (minutes)')).toBeInTheDocument()
    expect(screen.getByDisplayValue('30')).toBeInTheDocument()
    expect(screen.getByText('When the timeout expires')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Fail the run' }).selected).toBe(true)
  })

  it('renders prompt fields for ai-prompt', () => {
    setup(mk('ai-prompt'))
    expect(screen.getByText(/^Prompt/)).toBeInTheDocument()
    expect(screen.getByText(/System instructions/)).toBeInTheDocument()
  })

  it('renders text + labels fields for ai-classify', () => {
    setup(mk('ai-classify'))
    expect(screen.getByText(/^Text/)).toBeInTheDocument()
    expect(screen.getByText(/Labels/)).toBeInTheDocument()
  })

  it('renders a message field for output-log', () => {
    setup(mk('output-log'))
    expect(screen.getByText(/^Message/)).toBeInTheDocument()
  })

  it('shows only a hint (no extra inputs) for trigger-manual', () => {
    setup(mk('trigger-manual'))
    expect(screen.getByText(/Manual triggers start the workflow/)).toBeInTheDocument()
    // Only the always-present Label input — no type-specific text fields.
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
  })

  it('shows a fallback for an unknown node type', () => {
    setup(mk('mystery-type'))
    expect(screen.getByText(/No configuration for this node type/)).toBeInTheDocument()
  })

  it('renders the cron field, a humanized preview, and quick-picks for trigger-schedule', () => {
    setup(mk('trigger-schedule', { config: { cron: '0 9 * * 1' } }))
    expect(screen.getByText('Cron expression')).toBeInTheDocument()
    expect(screen.getByDisplayValue('0 9 * * 1')).toBeInTheDocument()
    // cronstrue humanization (scoped to the preview — "At 09:00" isn't on any button)
    expect(screen.getByText(/At 09:00/)).toBeInTheDocument()
    expect(screen.getByText('Every hour')).toBeInTheDocument()
    expect(screen.getByText('Every 1st of month')).toBeInTheDocument()
  })

  it('flags an invalid cron expression in the preview', () => {
    setup(mk('trigger-schedule', { config: { cron: 'definitely-not-cron' } }))
    expect(screen.getByText(/Not a valid cron expression/i)).toBeInTheDocument()
  })
})

describe('NodeConfigPanel interactions', () => {
  it('editing the label calls onChange with the new label', () => {
    const { onChange } = setup(mk('output-log', { label: 'Old' }))
    fireEvent.change(screen.getByDisplayValue('Old'), { target: { value: 'New' } })
    expect(onChange).toHaveBeenCalledWith('n1', { label: 'New' })
  })

  it('editing a type-specific field merges into config', () => {
    const { onChange } = setup(mk('action-http'))
    fireEvent.change(screen.getByPlaceholderText('https://api.example.com/items'), {
      target: { value: 'https://x.test' },
    })
    expect(onChange).toHaveBeenCalledWith('n1', { config: { url: 'https://x.test' } })
  })

  it('preserves existing config keys when editing one field', () => {
    const { onChange } = setup(mk('action-http', { config: { method: 'POST' } }))
    fireEvent.change(screen.getByPlaceholderText('https://api.example.com/items'), {
      target: { value: 'https://x.test' },
    })
    expect(onChange).toHaveBeenCalledWith('n1', { config: { method: 'POST', url: 'https://x.test' } })
  })

  it('clicking delete calls onDelete with the node id', () => {
    const { onDelete } = setup(mk('output-log'))
    fireEvent.click(screen.getByText('Delete node'))
    expect(onDelete).toHaveBeenCalledWith('n1')
  })

  it('clicking close calls onClose', () => {
    const { onClose } = setup(mk('output-log'))
    fireEvent.click(screen.getByTitle('Close'))
    expect(onClose).toHaveBeenCalled()
  })

  it('clicking a schedule quick-pick sets that cron via onChange', () => {
    const { onChange } = setup(mk('trigger-schedule', { config: { cron: '0 9 * * *' } }))
    fireEvent.click(screen.getByText('Every Monday'))
    expect(onChange).toHaveBeenCalledWith('n1', { config: { cron: '0 9 * * 1' } })
  })
})
