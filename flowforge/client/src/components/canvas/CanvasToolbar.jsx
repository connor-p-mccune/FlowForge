import { TOOLBAR_BUTTONS } from './nodeDefs'

export default function CanvasToolbar({
  onAddNode,
  onRun,
  onTest,
  onToggleRuns,
  onSuggest,
  onGenerate,
  onToggleWebhooks,
  onToggleRunSettings,
  onToggleBackfill,
  backfillOpen,
  onToggleInsights,
  onToggleCanary,
  canaryOpen,
  insightsOpen,
  onToggleTests,
  testsOpen,
  onToggleCommentMode,
  commentMode,
  onAutoLayout,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onToggleIssues,
  onToggleLineage,
  lineageOpen,
  onToggleGuarantees,
  guaranteesOpen,
  onTogglePaths,
  pathsOpen,
  onTogglePreview,
  previewOpen,
  onToggleDebugger,
  debuggerOpen,
  issuesOpen,
  onDeploy,
  onToggleHistory,
  onOpenMerge,
  onTogglePause,
  paused,
  pausing,
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
        className="toolbar-btn toolbar-btn--limits"
        title="Run settings — concurrency limits and SLA targets"
        onClick={onToggleRunSettings}
      >
        ⏱ Settings
      </button>
      <button
        className={`toolbar-btn toolbar-btn--backfill${backfillOpen ? ' toolbar-btn--active' : ''}`}
        title="Backfill — re-run this schedule over a window of the past"
        onClick={onToggleBackfill}
        aria-pressed={backfillOpen}
      >
        ⏮ Backfill
      </button>
      <button
        className={`toolbar-btn toolbar-btn--insights${insightsOpen ? ' toolbar-btn--active' : ''}`}
        title="Run insights — duration percentiles, success rate, and anomalous runs"
        onClick={onToggleInsights}
        aria-pressed={insightsOpen}
      >
        📊 Insights
      </button>
      <button
        className={`toolbar-btn toolbar-btn--canary${canaryOpen ? ' toolbar-btn--active' : ''}`}
        title="Canary release — send a slice of runs to this canvas and compare it against the deployed version"
        onClick={onToggleCanary}
        aria-pressed={canaryOpen}
      >
        🐤 Canary
      </button>
      <button
        className={`toolbar-btn toolbar-btn--tests${testsOpen ? ' toolbar-btn--active' : ''}`}
        title="Test scenarios — assert on the workflow's output and gate CI on them"
        onClick={onToggleTests}
        aria-pressed={testsOpen}
      >
        🧪 Tests
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
      <button
        className="toolbar-btn toolbar-btn--undo"
        title="Undo (Ctrl/⌘-Z)"
        onClick={onUndo}
        disabled={!canUndo}
        aria-label="Undo"
      >
        ↶
      </button>
      <button
        className="toolbar-btn toolbar-btn--redo"
        title="Redo (Ctrl/⌘-Shift-Z)"
        onClick={onRedo}
        disabled={!canRedo}
        aria-label="Redo"
      >
        ↷
      </button>
      <button
        className={`toolbar-btn toolbar-btn--issues${issuesOpen ? ' toolbar-btn--active' : ''}`}
        title="Check this workflow for problems before running it"
        onClick={onToggleIssues}
        aria-pressed={issuesOpen}
      >
        🔎 Issues
      </button>
      <button
        className={`toolbar-btn toolbar-btn--issues${lineageOpen ? ' toolbar-btn--active' : ''}`}
        title="Trace where this workflow's data comes from and where it leaves"
        onClick={onToggleLineage}
        aria-pressed={lineageOpen}
      >
        🔗 Lineage
      </button>
      <button
        className={`toolbar-btn toolbar-btn--issues${guaranteesOpen ? ' toolbar-btn--active' : ''}`}
        title="Guarantees — invariants checked over every execution this graph admits, not just the one that ran"
        onClick={onToggleGuarantees}
        aria-pressed={guaranteesOpen}
      >
        🛡 Guarantees
      </button>
      <button
        className={`toolbar-btn toolbar-btn--issues${pathsOpen ? ' toolbar-btn--active' : ''}`}
        title="Paths — which branches an input can actually take, and the payload that takes each one"
        onClick={onTogglePaths}
        aria-pressed={pathsOpen}
      >
        🧭 Paths
      </button>
      <button
        className={`toolbar-btn toolbar-btn--issues${previewOpen ? ' toolbar-btn--active' : ''}`}
        title="Preview — replay recent runs against this canvas and see which would behave differently"
        onClick={onTogglePreview}
        aria-pressed={previewOpen}
      >
        🔮 Preview
      </button>
      <button
        className={`toolbar-btn toolbar-btn--issues${debuggerOpen ? ' toolbar-btn--active' : ''}`}
        title="Debugger — stop a run at a node and inspect what it is about to do"
        onClick={onToggleDebugger}
        aria-pressed={debuggerOpen}
      >
        🐞 Debug
      </button>
      <span className="canvas-toolbar__divider" />
      <button
        className="toolbar-btn toolbar-btn--run"
        title={paused ? 'Workflow is paused — resume it to run' : 'Run workflow'}
        // Wrapped rather than passed directly: onRun takes an optional debug
        // request, and handing it a MouseEvent would start every ordinary run
        // as a malformed debug session.
        onClick={() => onRun()}
        disabled={running || paused}
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
        className={`toolbar-btn toolbar-btn--pause${paused ? ' toolbar-btn--paused' : ''}`}
        title={
          paused
            ? 'Resume — accept new runs again'
            : 'Pause — hold all new runs (manual, API, webhook, schedule); in-flight runs finish and test runs still work'
        }
        onClick={onTogglePause}
        disabled={pausing}
        aria-pressed={paused}
      >
        {pausing ? '…' : paused ? '▶ Resume' : '⏸ Pause'}
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
      <button
        className="toolbar-btn toolbar-btn--history"
        title="Merge an exported workflow file into this canvas, keeping both sides' edits"
        onClick={onOpenMerge}
      >
        ⇋ Merge
      </button>
      {scheduleWarning && (
        <span className="canvas-toolbar__warning" role="status">
          ⚠ Deploy this workflow to activate the schedule
        </span>
      )}
    </div>
  )
}
