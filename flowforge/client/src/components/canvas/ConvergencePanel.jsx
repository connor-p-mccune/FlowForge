import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '../../services/api'
import { serializeGraph } from '../../hooks/useWorkflow'

// Where parallel branches collide.
//
// A node with several incoming edges gets its input from `Object.assign` over
// the upstream outputs, so when two branches both produce a `status`, exactly
// one survives. The engine picks the deeper contributor — it ran later and saw
// the shallower one's value — which leaves the case no order can fix: two
// branches at the *same* depth, where the canonical edge sort breaks the tie
// alphabetically.
//
// This panel is the only place in the product where that ordering is visible.
// It lists the collisions, and while it is open the canvas draws the losing
// edge dashed and labelled with what it loses, which is the whole point: the
// answer was always there and nothing showed it.
export default function ConvergencePanel({
  workflowId,
  nodes,
  edges,
  onClose,
  onSelectNode,
  onReport,
}) {
  const [report, setReport] = useState(null) // null = first analysis in flight
  const [error, setError] = useState(null)

  const analyse = useCallback(async () => {
    try {
      setError(null)
      const next = await apiFetch(`/api/workflows/${workflowId}/convergence`, {
        method: 'POST',
        body: serializeGraph(nodes, edges),
      })
      setReport(next)
      onReport?.(next)
    } catch (err) {
      setError(err.message)
    }
  }, [workflowId, nodes, edges, onReport])

  // Immediately on open, then debounced as the graph changes — because the
  // answer changes the moment somebody draws a connection, and wiring a third
  // branch into a join is exactly the edit that creates a collision.
  const firstRun = useRef(true)
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false
      analyse()
      return undefined
    }
    const t = setTimeout(analyse, 700)
    return () => clearTimeout(t)
  }, [analyse])

  // The decoration belongs to this panel's lifetime: closing it puts the canvas
  // back the way it was.
  useEffect(() => () => onReport?.(null), [onReport])

  const summary = report?.summary
  const joins = report?.joins || []

  return (
    <aside className="issues-panel" aria-label="Converging branches">
      <div className="issues-panel__header">
        <span className="issues-panel__title">⤞ Convergence</span>
        {summary && summary.collisions > 0 && (
          <span className="issues-panel__counts">
            {summary.tieBroken > 0 && (
              <span className="issues-panel__count issues-panel__count--warning">
                {summary.tieBroken} tie-break{summary.tieBroken === 1 ? '' : 's'}
              </span>
            )}
            {summary.dataflow > 0 && (
              <span className="issues-panel__count">
                {summary.dataflow} settled
              </span>
            )}
          </span>
        )}
        <button className="issues-panel__close" title="Close" onClick={onClose}>×</button>
      </div>
      <div className="issues-panel__body">
        {error && <p className="issues-panel__error">{error}</p>}
        {!error && report === null && (
          <p className="issues-panel__hint">Looking for converging branches…</p>
        )}
        {!error && report && report.available === false && (
          <p className="issues-panel__hint">
            {report.reason === 'cycle'
              ? 'The graph has a cycle, so no run of it happens at all.'
              : 'Nothing on the canvas yet.'}
          </p>
        )}
        {!error && report?.available && joins.length === 0 && (
          <p className="issues-panel__clean">
            ✓ No converging branch supplies a field another one also supplies.
          </p>
        )}
        {!error && joins.length > 0 && (
          <>
            <p className="convergence__lede">
              Where two branches supply the same field, one value survives. The
              engine takes the deeper contributor — it ran later. Where both sit
              at the same depth nothing in the graph decides, and the winner is
              alphabetical.
            </p>
            <ul className="convergence-list">
              {joins.map((join) =>
                join.collisions.map((found) => (
                  <li key={`${join.nodeId}-${found.key}`}>
                    <button
                      className={`convergence-item convergence-item--${found.resolution}`}
                      title="Show this node"
                      onClick={() => onSelectNode(join.nodeId)}
                    >
                      <span className="convergence-item__head">
                        <code className="convergence-item__field">{found.key}</code>
                        <span className="convergence-item__at">at {join.label}</span>
                        <span className={`convergence-item__tag convergence-item__tag--${found.resolution}`}>
                          {found.resolution === 'tie-break' ? 'alphabetical' : 'ran later'}
                        </span>
                      </span>
                      <span className="convergence-item__flow">
                        {found.contributors.map((c) => (
                          <span
                            key={c.nodeId}
                            className={
                              c.nodeId === found.decidedBy
                                ? 'convergence-src convergence-src--wins'
                                : 'convergence-src'
                            }
                          >
                            {c.label}
                            {!found.sameType && <em className="convergence-src__type">{c.type}</em>}
                          </span>
                        ))}
                      </span>
                      {!found.decidedBy && (
                        <span className="convergence-item__note">
                          Which one survives depends on the branch that ran.
                        </span>
                      )}
                      {!found.sameType && (
                        <span className="convergence-item__note">
                          Differently shaped, so the winner changes what downstream can do with it.
                        </span>
                      )}
                    </button>
                  </li>
                ))
              )}
            </ul>
          </>
        )}
      </div>
    </aside>
  )
}
