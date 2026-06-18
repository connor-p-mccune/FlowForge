import { TOOLBAR_BUTTONS } from './nodeDefs'

export default function CanvasToolbar({
  onAddNode,
  onRun,
  onTest,
  onToggleRuns,
  onSuggest,
  onToggleWebhooks,
  onDeploy,
  onToggleHistory,
  running,
  testing,
  suggesting,
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
