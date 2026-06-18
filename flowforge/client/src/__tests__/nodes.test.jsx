import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ReactFlowProvider } from 'reactflow'

import TriggerNode from '../components/canvas/nodes/TriggerNode'
import ActionNode from '../components/canvas/nodes/ActionNode'
import ConditionNode from '../components/canvas/nodes/ConditionNode'
import AINode from '../components/canvas/nodes/AINode'
import OutputNode from '../components/canvas/nodes/OutputNode'

// React Flow's <Handle> reads from the flow store, so every node must render
// inside a ReactFlowProvider.
function renderNode(ui) {
  return render(<ReactFlowProvider>{ui}</ReactFlowProvider>)
}

const handles = (container) => container.querySelectorAll('.react-flow__handle')
const sources = (container) => container.querySelectorAll('.react-flow__handle.source')
const targets = (container) => container.querySelectorAll('.react-flow__handle.target')

describe('TriggerNode', () => {
  it('renders its label and subtype', () => {
    renderNode(<TriggerNode data={{ label: 'Start here', subtype: 'webhook' }} selected={false} />)
    expect(screen.getByText('Start here')).toBeInTheDocument()
    expect(screen.getByText('webhook')).toBeInTheDocument()
  })

  it('falls back to default text without data', () => {
    renderNode(<TriggerNode data={{}} selected={false} />)
    expect(screen.getByText('Trigger')).toBeInTheDocument()
    expect(screen.getByText('manual')).toBeInTheDocument()
  })

  it('exposes a single source handle and no target (it starts the flow)', () => {
    const { container } = renderNode(<TriggerNode data={{}} selected={false} />)
    expect(handles(container)).toHaveLength(1)
    expect(sources(container)).toHaveLength(1)
    expect(targets(container)).toHaveLength(0)
    expect(container.querySelector('.react-flow__handle').dataset.handlepos).toBe('bottom')
  })

  it('adds the selected modifier class when selected', () => {
    const { container } = renderNode(<TriggerNode data={{}} selected={true} />)
    expect(container.querySelector('.node')).toHaveClass('node--trigger', 'node--selected')
  })

  it('shows the cron expression for a schedule trigger', () => {
    renderNode(
      <TriggerNode
        data={{ label: 'Nightly', subtype: 'schedule', config: { cron: '0 9 * * *' } }}
        selected={false}
      />
    )
    expect(screen.getByText('schedule')).toBeInTheDocument()
    expect(screen.getByText('0 9 * * *')).toBeInTheDocument()
  })

  it('does not render a cron line for non-schedule triggers', () => {
    const { container } = renderNode(
      <TriggerNode data={{ subtype: 'webhook', config: { cron: '0 9 * * *' } }} selected={false} />
    )
    expect(container.querySelector('.node__cron')).toBeNull()
  })
})

describe('ActionNode', () => {
  it('shows the HTTP method from config when present', () => {
    renderNode(<ActionNode data={{ label: 'Call API', config: { method: 'POST' } }} selected={false} />)
    expect(screen.getByText('Call API')).toBeInTheDocument()
    expect(screen.getByText('POST')).toBeInTheDocument()
  })

  it('falls back to the subtype, then a default, when no method', () => {
    renderNode(<ActionNode data={{ subtype: 'delay' }} selected={false} />)
    expect(screen.getByText('delay')).toBeInTheDocument()
  })

  it('has a target handle on top and a source handle on the bottom', () => {
    const { container } = renderNode(<ActionNode data={{}} selected={false} />)
    expect(handles(container)).toHaveLength(2)
    expect(targets(container)).toHaveLength(1)
    expect(sources(container)).toHaveLength(1)
    expect(container.querySelector('.react-flow__handle.target').dataset.handlepos).toBe('top')
    expect(container.querySelector('.react-flow__handle.source').dataset.handlepos).toBe('bottom')
  })

  it('shows no dry-run badge when there is no dryRunResult', () => {
    renderNode(<ActionNode data={{ label: 'Email' }} selected={false} />)
    expect(screen.queryByRole('button', { name: 'Would send' })).toBeNull()
  })

  it('renders a "Would send" badge in test mode and toggles a JSON payload popover', () => {
    const { container } = renderNode(
      <ActionNode
        data={{ label: 'Email', dryRunResult: { to: 'a@b.com', subject: 'Hi' } }}
        selected={false}
      />
    )
    const badge = screen.getByRole('button', { name: 'Would send' })
    // Payload stays hidden until the badge is clicked.
    expect(container.querySelector('.dry-run-popover')).toBeNull()

    fireEvent.click(badge)
    const popover = container.querySelector('.dry-run-popover__body')
    expect(popover).toBeInTheDocument()
    expect(popover.textContent).toContain('"to": "a@b.com"')
    expect(popover.textContent).toContain('"subject": "Hi"')

    // Clicking again closes it.
    fireEvent.click(badge)
    expect(container.querySelector('.dry-run-popover')).toBeNull()
  })
})

describe('ConditionNode', () => {
  it('renders true/false branch labels', () => {
    renderNode(<ConditionNode data={{ label: 'Is big?' }} selected={false} />)
    expect(screen.getByText('Is big?')).toBeInTheDocument()
    expect(screen.getByText('true')).toBeInTheDocument()
    expect(screen.getByText('false')).toBeInTheDocument()
  })

  it('has one target and two identified source handles (true + false)', () => {
    const { container } = renderNode(<ConditionNode data={{}} selected={false} />)
    expect(handles(container)).toHaveLength(3)
    expect(targets(container)).toHaveLength(1)
    expect(sources(container)).toHaveLength(2)
    expect(container.querySelector('[data-handleid="true"]')).toBeInTheDocument()
    expect(container.querySelector('[data-handleid="false"]')).toBeInTheDocument()
  })
})

describe('AINode', () => {
  it('renders label and subtype with both handles', () => {
    const { container } = renderNode(<AINode data={{ label: 'Summarize', subtype: 'prompt' }} selected={false} />)
    expect(screen.getByText('Summarize')).toBeInTheDocument()
    expect(screen.getByText('prompt')).toBeInTheDocument()
    expect(targets(container)).toHaveLength(1)
    expect(sources(container)).toHaveLength(1)
  })
})

describe('OutputNode', () => {
  it('renders label and subtype', () => {
    renderNode(<OutputNode data={{ label: 'Log it', subtype: 'log' }} selected={false} />)
    expect(screen.getByText('Log it')).toBeInTheDocument()
    expect(screen.getByText('log')).toBeInTheDocument()
  })

  it('has only a target handle (it ends the flow)', () => {
    const { container } = renderNode(<OutputNode data={{}} selected={false} />)
    expect(handles(container)).toHaveLength(1)
    expect(targets(container)).toHaveLength(1)
    expect(sources(container)).toHaveLength(0)
    expect(container.querySelector('.react-flow__handle').dataset.handlepos).toBe('top')
  })
})
