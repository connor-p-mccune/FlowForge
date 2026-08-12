import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '../../services/api'
import { serializeGraph } from '../../hooks/useWorkflow'

// The invariants this workflow's author declared about their own graph, checked
// against the graph on screen.
//
// The panel is built around one belief: nobody sits down to write path
// invariants. They sit down to build a workflow, and the invariant is the thing
// they were assuming the whole time without saying. So the primary action here
// is **Pin**, not "new declaration" — the server reports what already holds and
// looks deliberate (a gate standing in front of something consequential), and
// one click turns an accident into a promise. Writing one from scratch is
// available and secondary, because it is the rarer path.
//
// The other decision is that a violation shows its counterexample as a chain of
// clickable node names. "Charge card is not dominated by Approve" is a true
// statement nobody can act on; "Run by hand → Charge card" is the bug, and
// clicking it puts you on the node that caused it.

const KINDS = [
  { value: 'requires', verb: 'never runs unless', tail: 'ran first' },
  { value: 'ensures', verb: 'runs only if', tail: 'runs too', prefix: 'if' },
  { value: 'exclusive', verb: 'and', tail: 'never both run' },
]

const STATUS_META = {
  holds: { icon: '✓', className: 'guarantee--holds', label: 'Holds' },
  violated: { icon: '✗', className: 'guarantee--violated', label: 'Violated' },
  unknown: { icon: '?', className: 'guarantee--unknown', label: 'Cannot be checked' },
}

// The declaration as stored — the shape both the API and the equality check
// below agree on. Kept separate from the verdict so re-verifying never
// resurrects a declaration the author just removed.
const key = (g) => `${g.kind}:${g.node}:${g.other}`

export default function GuaranteesPanel({ workflowId, nodes, edges, onClose, onSelectNode }) {
  const [declared, setDeclared] = useState(null) // null = not loaded yet
  const [report, setReport] = useState(null)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [composing, setComposing] = useState(false)

  // Verify against the canvas on screen (not the saved graph), passing the
  // declarations we hold locally so an unsaved pin is reflected immediately.
  const verify = useCallback(
    async (list) => {
      try {
        setError(null)
        const body = serializeGraph(nodes, edges)
        const res = await apiFetch(`/api/workflows/${workflowId}/guarantees`, {
          method: 'POST',
          body: list ? { ...body, guarantees: list } : body,
        })
        setReport(res)
        if (!list) setDeclared(res.results.map((r) => ({ kind: r.kind, node: r.node, other: r.other })))
      } catch (err) {
        setError(err.message)
      }
    },
    [workflowId, nodes, edges]
  )

  // Verify on open, then debounce as the graph changes — the same cadence as
  // the Issues panel, because it answers the same class of question about the
  // same unsaved canvas.
  const first = useRef(true)
  const declaredRef = useRef(null)
  declaredRef.current = declared
  useEffect(() => {
    if (first.current) {
      first.current = false
      verify(null)
      return undefined
    }
    const t = setTimeout(() => verify(declaredRef.current), 700)
    return () => clearTimeout(t)
  }, [verify])

  const save = useCallback(
    async (list) => {
      setSaving(true)
      try {
        setError(null)
        setDeclared(list)
        await apiFetch(`/api/workflows/${workflowId}/guarantees`, {
          method: 'PUT',
          body: { guarantees: list },
        })
        await verify(list)
      } catch (err) {
        setError(err.message)
      } finally {
        setSaving(false)
      }
    },
    [workflowId, verify]
  )

  const pin = (suggestion) =>
    save([...(declared || []), { kind: suggestion.kind, node: suggestion.node, other: suggestion.other }])

  const unpin = (result) => save((declared || []).filter((g) => key(g) !== key(result)))

  const results = report?.results || []
  const suggestions = (report?.suggestions || []).filter(
    (s) => !(declared || []).some((g) => key(g) === key(s))
  )
  const broken = results.filter((r) => r.status !== 'holds').length

  return (
    <aside className="issues-panel guarantees-panel" aria-label="Workflow guarantees">
      <div className="issues-panel__header">
        <span className="issues-panel__title">🛡 Guarantees</span>
        {results.length > 0 && (
          <span className="issues-panel__counts">
            {broken > 0 ? (
              <span className="issues-panel__count issues-panel__count--error">
                {broken} broken
              </span>
            ) : (
              <span className="issues-panel__count issues-panel__count--ok">all hold</span>
            )}
          </span>
        )}
        <button className="issues-panel__close" title="Close" onClick={onClose}>×</button>
      </div>

      <div className="issues-panel__body">
        {error && <p className="issues-panel__error">{error}</p>}
        {!error && report === null && <p className="issues-panel__hint">Verifying…</p>}

        {report?.analysed === false && (
          <p className="issues-panel__error">
            {report.reason === 'cycle'
              ? 'The graph contains a cycle, so it admits no execution to verify against.'
              : 'The graph has no nodes to verify.'}
          </p>
        )}

        {results.length > 0 && (
          <ul className="guarantee-list">
            {results.map((result) => {
              const meta = STATUS_META[result.status] || STATUS_META.unknown
              return (
                <li key={key(result)} className={`guarantee ${meta.className}`}>
                  <div className="guarantee__head">
                    <span className="guarantee__icon" title={meta.label} aria-hidden="true">
                      {meta.icon}
                    </span>
                    <span className="guarantee__statement">{result.statement}</span>
                    <button
                      className="guarantee__remove"
                      title="Remove this guarantee"
                      aria-label={`Remove guarantee: ${result.statement}`}
                      onClick={() => unpin(result)}
                      disabled={saving}
                    >
                      ×
                    </button>
                  </div>
                  {/* The visible-to-a-screen-reader status word, so the verdict
                      never depends on the icon's colour alone. */}
                  <span className="sr-only">{meta.label}</span>
                  {result.message && <p className="guarantee__message">{result.message}</p>}
                  {result.evidence && <p className="guarantee__evidence">{result.evidence}</p>}
                  {result.counterexample?.length > 0 && (
                    <p className="guarantee__path">
                      {result.counterexample.map((id, i) => (
                        <span key={`${id}-${i}`}>
                          {i > 0 && <span className="guarantee__arrow">→</span>}
                          <button className="lineage-link" onClick={() => onSelectNode(id)}>
                            {labelFor(nodes, id)}
                          </button>
                        </span>
                      ))}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        {report && results.length === 0 && report.analysed !== false && (
          <p className="issues-panel__hint">
            Nothing declared yet. A guarantee is the thing you were already
            assuming — pin one below and an edit that breaks it stops the deploy.
          </p>
        )}

        {suggestions.length > 0 && (
          <>
            <h3 className="lineage-section">True today — pin it?</h3>
            <ul className="guarantee-suggestions">
              {suggestions.map((s) => (
                <li key={key(s)}>
                  <span className="guarantee__statement">{s.statement}</span>
                  <button className="guarantee__pin" onClick={() => pin(s)} disabled={saving}>
                    Pin
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {report?.facts && (
          <>
            <h3 className="lineage-section">Always runs</h3>
            <p className="guarantee__facts">
              {report.facts.alwaysRuns.length === 0
                ? 'Nothing — every node sits behind a decision.'
                : report.facts.alwaysRuns.map((f) => f.label).join(', ')}
            </p>
          </>
        )}

        {composing ? (
          <Composer
            nodes={nodes}
            onCancel={() => setComposing(false)}
            onAdd={(g) => {
              setComposing(false)
              save([...(declared || []), g])
            }}
          />
        ) : (
          <button className="guarantee__compose" onClick={() => setComposing(true)}>
            + Write a guarantee
          </button>
        )}
      </div>
    </aside>
  )
}

function labelFor(nodes, id) {
  return nodes.find((n) => n.id === id)?.data?.label || id
}

// Writing one by hand. Sticky notes are excluded because they never execute, so
// an invariant about one could not be broken or upheld.
function Composer({ nodes, onAdd, onCancel }) {
  const choices = nodes.filter((n) => n.type !== 'note')
  const [kind, setKind] = useState('requires')
  const [node, setNode] = useState(choices[0]?.id || '')
  const [other, setOther] = useState(choices[1]?.id || '')
  const spec = KINDS.find((k) => k.value === kind)

  return (
    <div className="guarantee-composer">
      <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Guarantee kind">
        {KINDS.map((k) => (
          <option key={k.value} value={k.value}>
            {k.value}
          </option>
        ))}
      </select>
      <div className="guarantee-composer__row">
        {spec.prefix && <span>{spec.prefix}</span>}
        <select value={node} onChange={(e) => setNode(e.target.value)} aria-label="Subject node">
          {choices.map((n) => (
            <option key={n.id} value={n.id}>{n.data?.label || n.id}</option>
          ))}
        </select>
        <span>{spec.verb}</span>
        <select value={other} onChange={(e) => setOther(e.target.value)} aria-label="Related node">
          {choices.map((n) => (
            <option key={n.id} value={n.id}>{n.data?.label || n.id}</option>
          ))}
        </select>
        <span>{spec.tail}</span>
      </div>
      <div className="guarantee-composer__actions">
        <button
          className="tests-btn tests-btn--primary"
          disabled={!node || !other || node === other}
          onClick={() => onAdd({ kind, node, other })}
        >
          Add
        </button>
        <button className="tests-btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}
