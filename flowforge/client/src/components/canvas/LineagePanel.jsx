import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '../../services/api'
import { serializeGraph } from '../../hooks/useWorkflow'

// Where the workflow's data comes from and where it leaves.
//
// The panel has two modes and the *node* mode is the default whenever a node is
// selected, because the whole-graph view is a map and the question is almost
// always about one node: "what feeds this?" and "what breaks if I change it?".
// Clicking through the answers re-selects nodes on the canvas, so tracing a
// value backwards is a sequence of clicks rather than a reading exercise.
//
// Trust is carried by colour and by words, never by colour alone — the whole
// finding is "someone outside your workspace controls this value", and that
// has to survive being read by someone who can't distinguish red from amber.

const TRUST_META = {
  untrusted: { className: 'lineage-trust--untrusted', word: 'untrusted' },
  external: { className: 'lineage-trust--external', word: 'external' },
  internal: { className: 'lineage-trust--internal', word: 'internal' },
  unknown: { className: 'lineage-trust--unknown', word: 'unknown' },
}

function Origin({ origin }) {
  const meta = TRUST_META[origin.trust] || TRUST_META.unknown
  return (
    <li className={`lineage-origin ${meta.className}`}>
      <span className="lineage-origin__trust">{meta.word}</span>
      <span className="lineage-origin__label">{origin.label}</span>
      {origin.detail && <span className="lineage-origin__detail">{origin.detail}</span>}
    </li>
  )
}

export default function LineagePanel({ workflowId, nodes, edges, selectedNodeId, onClose, onSelectNode }) {
  const [report, setReport] = useState(null) // whole-graph
  const [trace, setTrace] = useState(null) // per-node
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      setError(null)
      const query = selectedNodeId ? `?node=${encodeURIComponent(selectedNodeId)}` : ''
      const res = await apiFetch(`/api/workflows/${workflowId}/lineage${query}`, {
        method: 'POST',
        body: serializeGraph(nodes, edges),
      })
      if (selectedNodeId) {
        setTrace(res.ok === false ? null : res)
        setReport(null)
      } else {
        setReport(res)
        setTrace(null)
      }
      if (res.ok === false) setError('The graph has a cycle — there is no dataflow to trace.')
    } catch (err) {
      setError(err.message)
    }
  }, [workflowId, nodes, edges, selectedNodeId])

  // Analyse immediately, then debounce as the graph changes — same cadence as
  // the Issues panel, and for the same reason: this reads the canvas on screen,
  // not the last saved version.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      load()
      return undefined
    }
    const t = setTimeout(load, 700)
    return () => clearTimeout(t)
  }, [load])

  return (
    <aside className="issues-panel lineage-panel" aria-label="Data lineage">
      <div className="issues-panel__header">
        <span className="issues-panel__title">🔗 Lineage</span>
        <button className="issues-panel__close" title="Close" onClick={onClose}>×</button>
      </div>
      <div className="issues-panel__body">
        {error && <p className="issues-panel__error">{error}</p>}

        {!error && !selectedNodeId && !report && <p className="issues-panel__hint">Tracing…</p>}
        {!error && selectedNodeId && !trace && <p className="issues-panel__hint">Tracing…</p>}

        {!error && selectedNodeId && trace && (
          <NodeTrace trace={trace} onSelectNode={onSelectNode} />
        )}

        {!error && !selectedNodeId && report?.ok && (
          <GraphMap report={report} onSelectNode={onSelectNode} />
        )}

        {!selectedNodeId && (
          <p className="issues-panel__hint lineage-panel__tip">
            Select a node to trace what feeds it and what depends on it.
          </p>
        )}
      </div>
    </aside>
  )
}

function NodeTrace({ trace, onSelectNode }) {
  const { provenance, impact } = trace
  const sameOrigins =
    provenance.outputOrigins.map((o) => o.kind).join() === provenance.origins.map((o) => o.kind).join()

  return (
    <>
      <h3 className="lineage-section">What feeds {provenance.label}</h3>
      {provenance.origins.length === 0 ? (
        <p className="issues-panel__hint">Nothing — this node reads no upstream data.</p>
      ) : (
        <ul className="lineage-origins">
          {provenance.origins.map((o) => (
            <Origin key={o.kind} origin={o} />
          ))}
        </ul>
      )}
      {/* Printed only when the two differ, which is exactly at an external
          boundary — an HTTP node's input traces to a webhook while its output
          is the far side's answer. Conflating them misreads the whole thing. */}
      {!sameOrigins && provenance.outputOrigins.length > 0 && (
        <p className="issues-panel__hint">
          Its own output is{' '}
          {provenance.outputOrigins.map((o) => o.label).join(', ')} — data flowing
          out of this node was written there, not here.
        </p>
      )}

      {provenance.chain.length > 0 && (
        <ul className="lineage-chain">
          {provenance.chain.map((c, i) => (
            <li key={`${c.from}-${c.to}-${i}`}>
              <button className="lineage-link" onClick={() => onSelectNode(c.from)}>
                {c.fromLabel}
              </button>
              <span className="lineage-chain__arrow">→</span>
              <span className="lineage-chain__to">{c.toLabel}</span>
              <code className="lineage-chain__ref">{`{{${c.reference}}}`}</code>
              <span className="lineage-chain__where">in {c.where}</span>
            </li>
          ))}
        </ul>
      )}

      <h3 className="lineage-section">What breaks if it changes</h3>
      {impact.affected.length === 0 ? (
        <p className="issues-panel__hint">Nothing references this node’s output.</p>
      ) : (
        <ul className="lineage-chain">
          {impact.affected.map((a) => (
            <li key={a.nodeId}>
              <button className="lineage-link" onClick={() => onSelectNode(a.nodeId)}>
                {a.label}
              </button>
              <span className="lineage-chain__where">
                {a.distance} hop{a.distance === 1 ? '' : 's'}
              </span>
              {a.references.map((r) => (
                <code key={r.reference} className="lineage-chain__ref">{`{{${r.reference}}}`}</code>
              ))}
            </li>
          ))}
        </ul>
      )}

      {impact.sinks.filter((s) => s.sensitivity === 'high').length > 0 && (
        <div className="lineage-warning">
          <strong>Reaches data that leaves the system</strong>
          <ul>
            {impact.sinks
              .filter((s) => s.sensitivity === 'high')
              .map((s) => (
                <li key={`${s.nodeId}-${s.key}`}>
                  <button className="lineage-link" onClick={() => onSelectNode(s.nodeId)}>
                    {s.label}
                  </button>{' '}
                  — {s.what}
                </li>
              ))}
          </ul>
        </div>
      )}
    </>
  )
}

function GraphMap({ report, onSelectNode }) {
  const secrets = Object.entries(report.secretReach || {})
  return (
    <>
      {report.findings.length > 0 && (
        <>
          <h3 className="lineage-section">Findings</h3>
          <ul className="issues-list">
            {report.findings.map((f, i) => (
              <li key={`${f.code}-${f.nodeId}-${i}`}>
                <button
                  className={`issues-item issues-item--${f.severity} issues-item--clickable`}
                  onClick={() => onSelectNode(f.nodeId)}
                >
                  <span className="issues-item__icon" aria-hidden="true">⚠️</span>
                  <span className="issues-item__message">{f.message}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {report.sinks.length > 0 && (
        <>
          <h3 className="lineage-section">Where data leaves</h3>
          <ul className="lineage-chain">
            {report.sinks.map((s) => (
              <li key={`${s.nodeId}-${s.key}`}>
                <button className="lineage-link" onClick={() => onSelectNode(s.nodeId)}>
                  {s.label}
                </button>
                <span className={`lineage-sensitivity lineage-sensitivity--${s.sensitivity}`}>
                  {s.sensitivity}
                </span>
                <span className="lineage-chain__where">{s.what}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {secrets.length > 0 && (
        <>
          <h3 className="lineage-section">Secret reach</h3>
          <ul className="lineage-chain">
            {secrets.map(([name, readers]) => (
              <li key={name}>
                <code className="lineage-chain__ref">{name}</code>
                <span className="lineage-chain__arrow">→</span>
                {readers.map((r) => (
                  <button
                    key={r.nodeId}
                    className="lineage-link"
                    onClick={() => onSelectNode(r.nodeId)}
                  >
                    {r.label}
                  </button>
                ))}
              </li>
            ))}
          </ul>
        </>
      )}

      {report.findings.length === 0 && report.sinks.length === 0 && secrets.length === 0 && (
        <p className="issues-panel__clean">
          ✓ Nothing leaves this workflow and no secrets are referenced.
        </p>
      )}
    </>
  )
}
