import { useCallback, useState } from 'react'
import { apiFetch } from '../../services/api'
import { serializeGraph } from '../../hooks/useWorkflow'

// What this change would have done to the runs that already happened.
//
// Every other analysis panel — Issues, Lineage, Guarantees, Paths — re-runs
// itself on a debounce as the canvas changes, because each is a pure function
// of the graph and costs microseconds. **This one does not**, and the button is
// the honest expression of why: it replays real runs through the engine, which
// takes seconds and is not something to do on every keystroke. A panel that
// quietly executed twenty graphs each time somebody dragged a node would be a
// performance bug wearing a feature's clothes.
//
// The other decision the layout makes is to lead with the count rather than the
// list. "3 of 20 runs would behave differently" is the answer; which three is
// the follow-up, and a reviewer who only reads the first line has still read
// the important part.

export default function PreviewPanel({ workflowId, nodes, edges, onClose, onSelectNode }) {
  const [report, setReport] = useState(null)
  const [error, setError] = useState(null)
  const [running, setRunning] = useState(false)

  const label = useCallback(
    (id) => nodes.find((n) => n.id === id)?.data?.label || id,
    [nodes]
  )

  const preview = useCallback(async () => {
    setRunning(true)
    try {
      setError(null)
      const res = await apiFetch(`/api/workflows/${workflowId}/preview`, {
        method: 'POST',
        body: serializeGraph(nodes, edges),
      })
      setReport(res)
    } catch (err) {
      setError(err.message)
    } finally {
      setRunning(false)
    }
  }, [workflowId, nodes, edges])

  const changed = report?.changed || []

  return (
    <aside className="issues-panel preview-panel" aria-label="Deploy preview">
      <div className="issues-panel__header">
        <span className="issues-panel__title">🔮 Preview</span>
        {report?.analysed && (
          <span className="issues-panel__counts">
            <span
              className={`issues-panel__count issues-panel__count--${changed.length ? 'warning' : 'ok'}`}
            >
              {changed.length ? `${changed.length} differ` : 'no change'}
            </span>
          </span>
        )}
        <button className="issues-panel__close" title="Close" onClick={onClose}>×</button>
      </div>

      <div className="issues-panel__body">
        <p className="issues-panel__hint">
          Replays this workflow’s recent runs against the canvas as it stands.
          Every step that reaches outside FlowForge is answered from the original
          run’s own recording, so what you see is what the <em>graph</em> would
          do differently — not what a different API would return. Nothing is
          sent, and nothing is kept.
        </p>

        <button className="guarantee__compose" onClick={preview} disabled={running}>
          {running ? 'Replaying…' : 'Replay recent runs'}
        </button>

        {error && <p className="issues-panel__error">{error}</p>}

        {report?.analysed === false && (
          <p className="issues-panel__hint">
            This workflow has no run history yet, so there is nothing to compare
            the change against.
          </p>
        )}

        {report?.analysed && (
          <>
            <p className="preview__headline">
              {changed.length === 0
                ? `All ${report.runs} replayed runs behave identically.`
                : `${changed.length} of ${report.runs} replayed runs would behave differently.`}
            </p>
            {report.truncated && (
              <p className="issues-panel__hint">
                The preview ran out of time before replaying them all — some runs
                were not compared.
              </p>
            )}
          </>
        )}

        {changed.length > 0 && (
          <ul className="preview-list">
            {changed.map((entry) => (
              <li className="preview-run" key={entry.executionId}>
                <div className="preview-run__when">{new Date(entry.at).toLocaleString()}</div>
                {entry.error ? (
                  <p className="preview-run__line preview-run__line--bad">{entry.error}</p>
                ) : (
                  <>
                    {entry.difference.statusChanged && (
                      <p className="preview-run__line">
                        status <strong>{entry.before.status}</strong> →{' '}
                        <strong>{entry.after.status}</strong>
                      </p>
                    )}
                    {entry.difference.routed.map((route) => (
                      <p className="preview-run__line" key={route.nodeId}>
                        <button className="lineage-link" onClick={() => onSelectNode(route.nodeId)}>
                          {label(route.nodeId)}
                        </button>{' '}
                        routes {String(route.before)} → {String(route.after)}
                      </p>
                    ))}
                    {entry.difference.started.length > 0 && (
                      <p className="preview-run__line preview-run__line--start">
                        now runs {entry.difference.started.map(label).join(', ')}
                      </p>
                    )}
                    {entry.difference.stopped.length > 0 && (
                      <p className="preview-run__line preview-run__line--stop">
                        no longer runs {entry.difference.stopped.map(label).join(', ')}
                      </p>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}
