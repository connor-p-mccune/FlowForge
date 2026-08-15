import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '../../services/api'
import { serializeGraph } from '../../hooks/useWorkflow'

// Which branches an input can actually take — and, for each one it can, the
// payload that takes it.
//
// The panel is organised around the two things the analysis produces that
// nothing else on the canvas could. A **dead branch** is drawn like an error
// because it is one: it is wired, it is typed, the graph reaches it, and no
// input ever will, so either the branch or the condition above it is wrong —
// and the finding names the decision it contradicts rather than leaving that
// to be worked out.
//
// The other is the `trigger:` line under a live branch. It is not a diagnostic;
// it is a payload that provably drives that branch, which is why the primary
// action here is **Write these into the suite** rather than a copy button.
// Nobody writes the boring tests, and the whole argument for generating them is
// that the branches are enumerable and their inputs are computable.
//
// Restraint is visible on purpose. A branch the analysis could not decide reads
// "not decided" rather than being hidden or, worse, drawn as fine — the failure
// mode of the whole feature is a missing finding, and the panel should look
// like that is what happened.

const STATUS_META = {
  reachable: { icon: '✓', className: 'path-branch--live', label: 'Reachable' },
  unreachable: { icon: '✗', className: 'path-branch--dead', label: 'No input reaches this' },
  unknown: { icon: '?', className: 'path-branch--unknown', label: 'Not decided' },
}

export default function PathsPanel({ workflowId, nodes, edges, onClose, onSelectNode, onToast }) {
  const [report, setReport] = useState(null)
  const [error, setError] = useState(null)
  const [generating, setGenerating] = useState(false)

  // Analyse the canvas on screen rather than the saved graph — a branch stops
  // being reachable at the moment somebody edits the condition above it, which
  // is well before they press save. Same cadence as the Issues and Guarantees
  // panels, because it answers the same class of question about the same
  // unsaved canvas.
  const analyse = useCallback(async () => {
    try {
      setError(null)
      const res = await apiFetch(`/api/workflows/${workflowId}/paths`, {
        method: 'POST',
        body: serializeGraph(nodes, edges),
      })
      setReport(res)
    } catch (err) {
      setError(err.message)
    }
  }, [workflowId, nodes, edges])

  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      analyse()
      return undefined
    }
    const t = setTimeout(analyse, 700)
    return () => clearTimeout(t)
  }, [analyse])

  const generate = useCallback(async () => {
    setGenerating(true)
    try {
      setError(null)
      const res = await apiFetch(`/api/workflows/${workflowId}/tests/generate`, {
        method: 'POST',
        body: serializeGraph(nodes, edges),
      })
      const written = res.created + res.updated
      onToast?.(
        `${written} scenario${written === 1 ? '' : 's'} in the suite` +
          (res.created ? ` (${res.created} new)` : ''),
        'success'
      )
    } catch (err) {
      setError(err.message)
    } finally {
      setGenerating(false)
    }
  }, [workflowId, nodes, edges, onToast])

  const branches = (report?.branches || []).filter((b) => b.wired > 0)
  const dead = branches.filter((b) => b.status === 'unreachable')
  const coverage = report?.coverage

  // Grouped by the decision they leave, so the panel reads like the canvas
  // rather than like a flat list of outcomes.
  const groups = []
  for (const branch of branches) {
    const last = groups[groups.length - 1]
    if (last && last.nodeId === branch.nodeId) last.branches.push(branch)
    else groups.push({ nodeId: branch.nodeId, label: branch.label, branches: [branch] })
  }

  return (
    <aside className="issues-panel paths-panel" aria-label="Path feasibility">
      <div className="issues-panel__header">
        <span className="issues-panel__title">🧭 Paths</span>
        {branches.length > 0 && (
          <span className="issues-panel__counts">
            {dead.length > 0 ? (
              <span className="issues-panel__count issues-panel__count--error">
                {dead.length} dead
              </span>
            ) : (
              <span className="issues-panel__count issues-panel__count--ok">all live</span>
            )}
          </span>
        )}
        <button className="issues-panel__close" title="Close" onClick={onClose}>×</button>
      </div>

      <div className="issues-panel__body">
        {error && <p className="issues-panel__error">{error}</p>}
        {!error && report === null && <p className="issues-panel__hint">Solving…</p>}

        {report?.analysed === false && (
          <p className="issues-panel__error">
            {report.reason === 'cycle'
              ? 'The graph contains a cycle, so it admits no execution to analyse.'
              : 'The graph has no nodes to analyse.'}
          </p>
        )}

        {report?.truncated && (
          <p className="issues-panel__hint">
            The search hit its bound, so nothing here is reported as dead — an
            unexplored path is not a non-existent one.
          </p>
        )}

        {report?.analysed && branches.length === 0 && (
          <p className="issues-panel__hint">
            This workflow makes no decisions, so every run takes the same path.
          </p>
        )}

        {groups.map((group) => (
          <div className="path-group" key={group.nodeId}>
            <button className="lineage-link path-group__label" onClick={() => onSelectNode(group.nodeId)}>
              {group.label}
            </button>
            <ul className="path-branches">
              {group.branches.map((branch) => {
                const meta = STATUS_META[branch.status] || STATUS_META.unknown
                return (
                  <li className={`path-branch ${meta.className}`} key={branch.outcome}>
                    <div className="path-branch__head">
                      <span className="path-branch__icon" aria-hidden="true">{meta.icon}</span>
                      <span className="path-branch__outcome">{branch.outcome}</span>
                      <span className="sr-only">{meta.label}</span>
                    </div>
                    {branch.conflict?.length > 0 && (
                      <p className="path-branch__note">
                        contradicts {branch.conflict.join(', ')}
                      </p>
                    )}
                    {branch.witness && Object.keys(branch.witness.triggerData).length > 0 && (
                      <pre className="path-branch__payload">
                        {JSON.stringify(branch.witness.triggerData)}
                      </pre>
                    )}
                    {branch.witness &&
                      Object.keys(branch.witness.triggerData).length === 0 &&
                      branch.status === 'reachable' && (
                        <p className="path-branch__note">any payload reaches this</p>
                      )}
                    {(branch.blockers || []).map((blocker) => (
                      <p className="path-branch__note" key={blocker}>{blocker}</p>
                    ))}
                  </li>
                )
              })}
            </ul>
          </div>
        ))}

        {coverage?.branches > 0 && (
          <>
            <h3 className="lineage-section">Coverage</h3>
            <p className="path-coverage">
              {coverage.reachable} of {coverage.branches} branches reachable,{' '}
              {coverage.generatable} drivable from a trigger payload.
            </p>
            <button
              className="guarantee__compose"
              onClick={generate}
              disabled={generating || coverage.generatable === 0}
            >
              {generating ? 'Writing…' : `Write ${coverage.generatable} scenarios into the suite`}
            </button>
            {coverage.generatable < coverage.reachable && (
              <p className="issues-panel__hint">
                The rest are real branches a test payload can’t drive — an
                approval’s rejected side, or a branch that turns on an API
                response. Each says which above.
              </p>
            )}
          </>
        )}
      </div>
    </aside>
  )
}
