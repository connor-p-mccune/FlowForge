import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import CanvasToolbar from '../components/canvas/CanvasToolbar'

// Only the props the pause control touches; the rest default to no-op/false so
// the toolbar renders. onAddNode is called during render via the node buttons.
function renderToolbar(overrides = {}) {
  const onTogglePause = vi.fn()
  const onRun = vi.fn()
  render(
    <CanvasToolbar
      onAddNode={() => {}}
      onRun={onRun}
      onTest={() => {}}
      onToggleRuns={() => {}}
      onSuggest={() => {}}
      onGenerate={() => {}}
      onToggleWebhooks={() => {}}
      onToggleRunSettings={() => {}}
      onToggleInsights={() => {}}
      onToggleTests={() => {}}
      onToggleCommentMode={() => {}}
      onAutoLayout={() => {}}
      onUndo={() => {}}
      onRedo={() => {}}
      onToggleIssues={() => {}}
      onDeploy={() => {}}
      onToggleHistory={() => {}}
      onTogglePause={onTogglePause}
      paused={false}
      pausing={false}
      {...overrides}
    />
  )
  return { onTogglePause, onRun }
}

describe('CanvasToolbar pause control', () => {
  it('shows Pause and keeps Run enabled while the workflow is active', () => {
    renderToolbar({ paused: false })
    expect(screen.getByRole('button', { name: /pause/i })).toHaveTextContent('⏸ Pause')
    expect(screen.getByRole('button', { name: '▶ Run' })).not.toBeDisabled()
  })

  it('shows Resume and disables Run while paused (dry-run Test stays enabled)', () => {
    renderToolbar({ paused: true })
    const toggle = screen.getByRole('button', { name: /resume/i })
    expect(toggle).toHaveTextContent('▶ Resume')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '▶ Run' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /⚡ Test/ })).not.toBeDisabled()
  })

  it('fires onTogglePause when clicked', () => {
    const { onTogglePause } = renderToolbar({ paused: false })
    fireEvent.click(screen.getByRole('button', { name: /pause/i }))
    expect(onTogglePause).toHaveBeenCalledTimes(1)
  })

  it('disables the toggle while a pause/resume request is in flight', () => {
    renderToolbar({ pausing: true })
    expect(screen.getByRole('button', { name: '…' })).toBeDisabled()
  })
})
