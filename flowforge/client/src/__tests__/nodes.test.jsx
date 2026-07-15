import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ReactFlowProvider } from 'reactflow'

import TriggerNode from '../components/canvas/nodes/TriggerNode'
import ActionNode from '../components/canvas/nodes/ActionNode'
import ConditionNode from '../components/canvas/nodes/ConditionNode'
import SwitchNode from '../components/canvas/nodes/SwitchNode'
import ValidateNode from '../components/canvas/nodes/ValidateNode'
import ApprovalNode from '../components/canvas/nodes/ApprovalNode'
import WaitCallbackNode from '../components/canvas/nodes/WaitCallbackNode'
import AINode from '../components/canvas/nodes/AINode'
import OutputNode from '../components/canvas/nodes/OutputNode'
import NoteNode from '../components/canvas/nodes/NoteNode'

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

  it('grows a dedicated error handle when onError is branch', () => {
    const { container } = renderNode(
      <ActionNode data={{ label: 'Call API', config: { onError: 'branch' } }} selected={false} />
    )
    expect(sources(container)).toHaveLength(2)
    expect(container.querySelector('[data-handleid="error"]')).toBeInTheDocument()
    // The main handle keeps no id, so existing edges survive toggling the policy.
    const main = [...sources(container)].find((h) => !h.dataset.handleid)
    expect(main).toBeTruthy()
    expect(screen.getByText('ok')).toBeInTheDocument()
    expect(screen.getByText('error')).toBeInTheDocument()
  })

  it('keeps a single source handle under fail and continue policies', () => {
    for (const onError of [undefined, 'fail', 'continue']) {
      const { container, unmount } = renderNode(
        <ActionNode data={{ config: onError ? { onError } : {} }} selected={false} />
      )
      expect(sources(container)).toHaveLength(1)
      expect(container.querySelector('[data-handleid="error"]')).toBeNull()
      unmount()
    }
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

describe('SwitchNode', () => {
  const data = { label: 'Route', config: { cases: [{ label: 'high' }, { label: 'mid' }] } }

  it('renders a labelled outlet per case plus a default', () => {
    renderNode(<SwitchNode data={data} selected={false} />)
    expect(screen.getByText('Route')).toBeInTheDocument()
    expect(screen.getByText('high')).toBeInTheDocument()
    expect(screen.getByText('mid')).toBeInTheDocument()
    expect(screen.getByText('default')).toBeInTheDocument()
  })

  it('exposes one source handle per case plus the default handle, ids matching labels', () => {
    const { container } = renderNode(<SwitchNode data={data} selected={false} />)
    expect(targets(container)).toHaveLength(1)
    expect(sources(container)).toHaveLength(3) // high, mid, default
    expect(container.querySelector('[data-handleid="high"]')).toBeInTheDocument()
    expect(container.querySelector('[data-handleid="mid"]')).toBeInTheDocument()
    expect(container.querySelector('[data-handleid="default"]')).toBeInTheDocument()
  })

  it('drops blank, duplicate, and reserved-"default" case labels from the outlets', () => {
    const messy = {
      config: { cases: [{ label: 'a' }, { label: '' }, { label: 'a' }, { label: 'default' }] },
    }
    const { container } = renderNode(<SwitchNode data={messy} selected={false} />)
    // Only the single valid 'a' outlet plus the trailing default.
    expect(sources(container)).toHaveLength(2)
    expect(container.querySelector('[data-handleid="a"]')).toBeInTheDocument()
  })

  it('shows just the default outlet when there are no cases', () => {
    const { container } = renderNode(<SwitchNode data={{ config: { cases: [] } }} selected={false} />)
    expect(sources(container)).toHaveLength(1)
    expect(container.querySelector('[data-handleid="default"]')).toBeInTheDocument()
  })
})

describe('ValidateNode', () => {
  it('renders valid/invalid branch labels', () => {
    renderNode(<ValidateNode data={{ label: 'Check body' }} selected={false} />)
    expect(screen.getByText('Check body')).toBeInTheDocument()
    expect(screen.getByText('valid')).toBeInTheDocument()
    expect(screen.getByText('invalid')).toBeInTheDocument()
  })

  it('has one target and two source handles with valid/invalid ids for engine routing', () => {
    const { container } = renderNode(<ValidateNode data={{}} selected={false} />)
    expect(targets(container)).toHaveLength(1)
    expect(sources(container)).toHaveLength(2)
    expect(container.querySelector('[data-handleid="valid"]')).toBeInTheDocument()
    expect(container.querySelector('[data-handleid="invalid"]')).toBeInTheDocument()
  })
})

describe('ApprovalNode', () => {
  it('renders approved/rejected branch labels and the message', () => {
    renderNode(
      <ApprovalNode
        data={{ label: 'Release gate', config: { message: 'Ship v2 to prod?' } }}
        selected={false}
      />
    )
    expect(screen.getByText('Release gate')).toBeInTheDocument()
    expect(screen.getByText('Ship v2 to prod?')).toBeInTheDocument()
    expect(screen.getByText('approved')).toBeInTheDocument()
    expect(screen.getByText('rejected')).toBeInTheDocument()
  })

  it('keeps the condition-style true/false handle ids for engine routing', () => {
    const { container } = renderNode(<ApprovalNode data={{}} selected={false} />)
    expect(handles(container)).toHaveLength(3)
    expect(targets(container)).toHaveLength(1)
    expect(sources(container)).toHaveLength(2)
    expect(container.querySelector('[data-handleid="true"]')).toBeInTheDocument()
    expect(container.querySelector('[data-handleid="false"]')).toBeInTheDocument()
  })

  it('omits the message line when none is configured', () => {
    const { container } = renderNode(<ApprovalNode data={{ label: 'Gate' }} selected={false} />)
    expect(container.querySelector('.node__approval-message')).toBeNull()
  })
})

describe('WaitCallbackNode', () => {
  it('renders received/timed-out branch labels', () => {
    renderNode(<WaitCallbackNode data={{ label: 'Await payment' }} selected={false} />)
    expect(screen.getByText('Await payment')).toBeInTheDocument()
    expect(screen.getByText('received')).toBeInTheDocument()
    expect(screen.getByText('timed out')).toBeInTheDocument()
  })

  it('has handle ids the engine routes on, like the other gates', () => {
    const { container } = renderNode(<WaitCallbackNode data={{}} selected={false} />)
    expect(targets(container)).toHaveLength(1)
    expect(sources(container)).toHaveLength(2)
    expect(container.querySelector('[data-handleid="received"]')).toBeInTheDocument()
    expect(container.querySelector('[data-handleid="timed-out"]')).toBeInTheDocument()
  })

  it('flags a fail-on-timeout gate in its subtitle', () => {
    renderNode(<WaitCallbackNode data={{ config: { onTimeout: 'fail' } }} selected={false} />)
    expect(screen.getByText('fails on timeout')).toBeInTheDocument()
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

describe('NoteNode', () => {
  it('renders its text with the chosen color and no handles at all', () => {
    const { container } = renderNode(
      <NoteNode data={{ config: { text: 'watch this branch', color: 'blue' } }} selected={false} />
    )
    expect(screen.getByText('watch this branch')).toBeInTheDocument()
    expect(container.querySelector('.node--note')).toHaveClass('note--blue')
    expect(handles(container)).toHaveLength(0)
  })

  it('defaults to yellow with a helper prompt when empty', () => {
    const { container } = renderNode(<NoteNode data={{}} selected={false} />)
    expect(container.querySelector('.node--note')).toHaveClass('note--yellow')
    expect(screen.getByText(/edit the text in the panel/i)).toBeInTheDocument()
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
