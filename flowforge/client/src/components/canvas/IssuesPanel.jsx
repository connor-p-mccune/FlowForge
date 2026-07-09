import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '../../services/api'
import { serializeGraph } from '../../hooks/useWorkflow'

const SEVERITY_META = {
  error: { icon: '⛔', label: 'Error' },
  warning: { icon: '⚠️', label: 'Warning' },
}

// Left-anchored panel listing the linter's findings for the live canvas graph
// (posted, not the saved one — so it reflects edits the debounced auto-save
// hasn't flushed yet). Re-lints, debounced, as the graph changes while open.
// Clicking an issue selects the offending node, which opens its config panel
// on the right — the two panels are on opposite sides so both stay visible.
export default function IssuesPanel({ workflowId, nodes, edges, onClose, onSelectNode }) {
  const [issues, setIssues] = useState(null) // null = first lint in flight
  const [summary, setSummary] = useState(null)
  const [error, setError] = useState(null)

  const runLint = useCallback(async () => {
    try {
      setError(null)
      const { issues: list, summary: counts } = await apiFetch(
        `/api/workflows/${workflowId}/lint`,
        { method: 'POST', body: serializeGraph(nodes, edges) }
      )
      setIssues(list)
      setSummary(counts)
    } catch (err) {
      setError(err.message)
    }
  }, [workflowId, nodes, edges])

  // Lint immediately on open, then debounce re-lints as the graph changes.
  // (serializeGraph strips volatile props, so selection churn re-fires this
  // effect but produces an identical, cheap request at worst.)
  const firstRun = useRef(true)
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false
      runLint()
      return undefined
    }
    const t = setTimeout(runLint, 700)
    return () => clearTimeout(t)
  }, [runLint])

  const clean = issues !== null && issues.length === 0

  return (
    <aside className="issues-panel" aria-label="Workflow issues">
      <div className="issues-panel__header">
        <span className="issues-panel__title">🔎 Issues</span>
        {summary && (summary.errors > 0 || summary.warnings > 0) && (
          <span className="issues-panel__counts">
            {summary.errors > 0 && (
              <span className="issues-panel__count issues-panel__count--error">
                {summary.errors} error{summary.errors === 1 ? '' : 's'}
              </span>
            )}
            {summary.warnings > 0 && (
              <span className="issues-panel__count issues-panel__count--warning">
                {summary.warnings} warning{summary.warnings === 1 ? '' : 's'}
              </span>
            )}
          </span>
        )}
        <button className="issues-panel__close" title="Close" onClick={onClose}>×</button>
      </div>
      <div className="issues-panel__body">
        {error && <p className="issues-panel__error">{error}</p>}
        {!error && issues === null && <p className="issues-panel__hint">Checking the workflow…</p>}
        {!error && clean && (
          <p className="issues-panel__clean">✓ No issues found — this workflow looks good.</p>
        )}
        {!error && issues !== null && issues.length > 0 && (
          <ul className="issues-list">
            {issues.map((iss, i) => {
              const meta = SEVERITY_META[iss.severity] || SEVERITY_META.warning
              const content = (
                <>
                  <span className="issues-item__icon" title={meta.label} aria-hidden="true">
                    {meta.icon}
                  </span>
                  <span className="issues-item__message">{iss.message}</span>
                </>
              )
              return (
                <li key={`${iss.code}-${iss.nodeId || 'graph'}-${i}`}>
                  {iss.nodeId ? (
                    <button
                      className={`issues-item issues-item--${iss.severity} issues-item--clickable`}
                      title="Show this node"
                      onClick={() => onSelectNode(iss.nodeId)}
                    >
                      {content}
                    </button>
                  ) : (
                    <div className={`issues-item issues-item--${iss.severity}`}>{content}</div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </aside>
  )
}
