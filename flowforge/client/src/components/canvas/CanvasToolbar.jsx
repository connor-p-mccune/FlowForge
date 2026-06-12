import { TOOLBAR_BUTTONS } from './nodeDefs'

export default function CanvasToolbar({ onAddNode, onRun, onToggleRuns, running }) {
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
