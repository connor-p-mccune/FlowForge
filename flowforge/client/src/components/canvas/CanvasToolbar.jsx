import { TOOLBAR_BUTTONS } from './nodeDefs'

export default function CanvasToolbar({
  onAddNode,
  onRun,
  onTest,
  onToggleRuns,
  onSuggest,
  onGenerate,
  onToggleWebhooks,
  onToggleCommentMode,
  commentMode,
  onAutoLayout,
  onDeploy,
  onToggleHistory,
  running,
  testing,
  suggesting,
  generating,
  deploying,
  scheduleWarning,
}) {
  return (
    <div className="canvas-toolbar">
      {TOOLBAR_BUTTONS.map(({ type, label, className }) => (
        <button
          key={type}
          className={`toolbar-btn ${className}`}
          title={`Add ${label} node`}
          onClick={() => onAddNode(type)}
        >
          + {label}
        </button>
      ))}
      <span className="canvas-toolbar__divider" />
      <button
        className="toolbar-btn toolbar-btn--generate"
        title="Generate a whole workflow from a description with AI"
        onClick={onGenerate}
        disabled={generating}
      >
        <span
          className={`toolbar-btn__sparkle${generating ? ' toolbar-btn__sparkle--spin' : ''}`}
          aria-hidden="true"
        >
          ✨
        </span>
        {generating ? 'Generating…' : 'Generate'}
      </button>
      <button
        className="toolbar-btn toolbar-btn--suggest"
        title="Suggest the next step with AI"
        onClick={onSuggest}
        disabled={suggesting}
      >
        {suggesting ? 'Thinking…' : '✨ Suggest'}
      </button>
      <button
        className="toolbar-btn toolbar-btn--webhooks"
        title="Manage webhook triggers"
        onClick={onToggleWebhooks}
      >
        Webhooks
      </button>
      <button
        className={`toolbar-btn toolbar-btn--comment${commentMode ? ' toolbar-btn--active' : ''}`}
        title="Comment mode — click the canvas to leave a comment (or right-click anywhere)"
        onClick={onToggleCommentMode}
        aria-pressed={commentMode}
      >
        💬 Comment
      </button>
      <button
        className="toolbar-btn toolbar-btn--tidy"
        title="Tidy — auto-arrange nodes into clean layers"
        onClick={onAutoLayout}
      >
        ▦ Tidy
      </button>
      <span className="canvas-toolbar__divider" />
      <button
        className="toolbar-btn toolbar-btn--run"
        title="Run workflow"
        onClick={onRun}
        disabled={running}
      >
        {running && !testing ? 'Running…' : '▶ Run'}
      </button>
      <button
        className="toolbar-btn toolbar-btn--test"
        title="Test run — execute the full workflow without firing email, Slack, or HTTP actions"
        onClick={onTest}
        disabled={running}
      >
        {testing ? 'Testing…' : '⚡ Test'}
      </button>
      <button
        className="toolbar-btn toolbar-btn--runs"
        title="Show runs"
        onClick={onToggleRuns}
      >
        Runs
      </button>
      <span className="canvas-toolbar__divider" />
      <button
        className="toolbar-btn toolbar-btn--deploy"
        title="Deploy — save the current workflow as a new version"
        onClick={onDeploy}
        disabled={deploying}
      >
        {deploying ? 'Deploying…' : '🚀 Deploy'}
      </button>
      <button
        className="toolbar-btn toolbar-btn--history"
        title="Version history"
        onClick={onToggleHistory}
      >
        🕘 History
      </button>
      {scheduleWarning && (
        <span className="canvas-toolbar__warning" role="status">
          ⚠ Deploy this workflow to activate the schedule
        </span>
      )}
    </div>
  )
}
