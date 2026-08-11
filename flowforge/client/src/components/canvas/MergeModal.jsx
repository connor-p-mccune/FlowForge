import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { apiFetch } from '../../services/api'
import { useToast } from '../../hooks/useToast'

// Merge an exported workflow document into this canvas.
//
// The modal is built around one rule the merge itself enforces: **a conflicted
// merge writes nothing.** So the flow is always pick a file → see the outcome →
// decide, never pick a file → it happened. Even a clean merge previews first,
// because this rewrites a definition that may be running.
//
// When it conflicts, the panel shows the three values a person actually needs to
// choose between — the common ancestor, what is live, and what the file says —
// side by side and per field. That is the information a merge tool exists to
// present; a list of node names would just be a diff with extra steps.

const MAX_GRAPH_BYTES = 500 * 1024

function Value({ label, value, tone }) {
  const text =
    value === null || value === undefined
      ? '(absent)'
      : typeof value === 'string'
        ? value
        : JSON.stringify(value)
  return (
    <div className={`merge-value merge-value--${tone}`}>
      <span className="merge-value__label">{label}</span>
      <code className="merge-value__text">{text}</code>
    </div>
  )
}

export default function MergeModal({ workflowId, onClose, onMerged }) {
  const toast = useToast()
  const [fileName, setFileName] = useState(null)
  const [graph, setGraph] = useState(null)
  const [report, setReport] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const run = useCallback(
    async (graphData, { strategy = 'manual', apply = false } = {}) => {
      setBusy(true)
      setError(null)
      try {
        const res = await apiFetch(`/api/workflows/${workflowId}/merge`, {
          method: 'POST',
          body: { graph_data: graphData, strategy, apply },
        })
        setReport(res)
        if (res.applied) {
          toast.success('Merged into the canvas — deploy when you’re ready')
          onMerged?.()
        }
        return res
      } catch (err) {
        setError(err.message)
        return null
      } finally {
        setBusy(false)
      }
    },
    [workflowId, toast, onMerged]
  )

  const handleFile = useCallback(
    (file) => {
      setError(null)
      setReport(null)
      setGraph(null)
      if (!file) return
      setFileName(file.name)

      const reader = new FileReader()
      reader.onerror = () => setError('Could not read that file.')
      reader.onload = () => {
        let parsed
        try {
          parsed = JSON.parse(reader.result)
        } catch {
          setError('That file isn’t valid JSON. Pick a workflow you exported from FlowForge.')
          return
        }
        const gd = parsed?.graph_data
        if (!gd || !Array.isArray(gd.nodes) || !Array.isArray(gd.edges)) {
          setError('This file is missing workflow data (it needs graph_data with nodes and edges).')
          return
        }
        if (new Blob([JSON.stringify(gd)]).size > MAX_GRAPH_BYTES) {
          setError('That workflow is too large to merge (over 500KB).')
          return
        }
        const next = { nodes: gd.nodes, edges: gd.edges }
        setGraph(next)
        run(next) // preview immediately — the outcome is the point
      }
      reader.readAsText(file)
    },
    [run]
  )

  const summary = report?.summary
  const conflicts = report?.conflicts || []

  return createPortal(
    <div className="import-modal merge-modal-root" role="presentation" onClick={onClose}>
      <div
        className="import-modal__panel merge-modal"
        role="dialog"
        aria-label="Merge a workflow document"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="import-modal__header">
          <h2 className="import-modal__title">Merge from a file</h2>
          <button className="import-modal__close" title="Close" onClick={onClose}>×</button>
        </header>

        <div className="import-modal__body merge-modal__body">
          <p className="merge-modal__intro">
            Combine an exported document with this canvas, keeping both sides’
            work. Edits to <em>different fields</em> of the same node merge
            cleanly; only genuinely competing edits stop for you.
          </p>

          <label className="merge-modal__file">
            <input
              type="file"
              accept="application/json,.json"
              onChange={(e) => handleFile(e.target.files?.[0])}
            />
          </label>
          {fileName && <p className="merge-modal__filename">{fileName}</p>}

          {error && <p className="import-modal__error">{error}</p>}
          {busy && <p className="merge-modal__hint">Merging…</p>}

          {report && (
            <>
              <p className="merge-modal__hint">
                Merged against{' '}
                {report.base?.version ? (
                  <strong>version {report.base.version}</strong>
                ) : (
                  <em>an empty base — this workflow has no deploys yet</em>
                )}
                .
              </p>

              <div className="merge-summary">
                <span className="merge-summary__stat merge-summary__stat--added">
                  +{summary?.added ?? 0} added
                </span>
                <span className="merge-summary__stat merge-summary__stat--changed">
                  ~{summary?.changed ?? 0} changed
                </span>
                <span className="merge-summary__stat merge-summary__stat--removed">
                  −{summary?.removed ?? 0} removed
                </span>
                <span className="merge-summary__stat">{summary?.unchanged ?? 0} unchanged</span>
              </div>

              {report.droppedEdges?.length > 0 && (
                <p className="merge-modal__warning">
                  {report.droppedEdges.length} connection
                  {report.droppedEdges.length === 1 ? '' : 's'} dropped — an endpoint
                  was removed by the merge.
                </p>
              )}

              {conflicts.length > 0 ? (
                <>
                  <h3 className="merge-modal__section">
                    {conflicts.length} conflict{conflicts.length === 1 ? '' : 's'} — nothing was written
                  </h3>
                  <ul className="merge-conflicts">
                    {conflicts.map((c, i) => (
                      <li key={`${c.nodeId}-${c.field}-${i}`} className="merge-conflict">
                        <div className="merge-conflict__head">
                          <strong>{c.label}</strong>
                          {c.field && <code className="merge-conflict__field">{c.field}</code>}
                        </div>
                        {c.kind === 'field' ? (
                          <>
                            <Value label="was" value={c.base} tone="base" />
                            <Value label="live" value={c.ours} tone="ours" />
                            <Value label="file" value={c.theirs} tone="theirs" />
                          </>
                        ) : (
                          <p className="merge-conflict__detail">{c.detail}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                  <p className="merge-modal__hint">
                    Resolve them on the canvas, or take one side for every
                    conflicting field:
                  </p>
                  <div className="merge-modal__actions">
                    <button
                      disabled={busy}
                      onClick={() => run(graph, { strategy: 'ours', apply: true })}
                    >
                      Keep live values
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => run(graph, { strategy: 'theirs', apply: true })}
                    >
                      Take the file’s
                    </button>
                  </div>
                </>
              ) : report.applied ? (
                <p className="merge-modal__clean">
                  ✓ Merged into the canvas. Deploy when you’re ready — merging
                  changed the canvas, not what’s running.
                </p>
              ) : (
                <>
                  {report.lint?.errors > 0 && (
                    <p className="merge-modal__warning">
                      The merged graph has {report.lint.errors} lint error
                      {report.lint.errors === 1 ? '' : 's'}. Merging is still
                      allowed — the Issues panel will show them.
                    </p>
                  )}
                  <p className="merge-modal__clean">✓ Merges cleanly.</p>
                  <div className="merge-modal__actions">
                    <button
                      className="merge-modal__apply"
                      disabled={busy}
                      onClick={() => run(graph, { apply: true })}
                    >
                      Apply to the canvas
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
