import { TOOLBAR_BUTTONS } from './nodeDefs'

export default function CanvasToolbar({
  onAddNode,
  onRun,
  onToggleRuns,
  onSuggest,
  onToggleWebhooks,
  running,
  suggesting,
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
        {running ? 'Running…' : '▶ Run'}
      </button>
      <button
        className="toolbar-btn toolbar-btn--runs"
        title="Show runs"
        onClick={onToggleRuns}
      >
        Runs
      </button>
    </div>
  )
}
