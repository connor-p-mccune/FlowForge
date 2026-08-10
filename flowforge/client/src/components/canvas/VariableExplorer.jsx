import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch } from '../../services/api'

// Ancestors of `nodeId` (everything upstream through any number of hops),
// nearest first — the nodes whose output this node can legally reference.
function upstreamOf(nodeId, nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const incoming = {}
  for (const e of edges) (incoming[e.target] ||= []).push(e.source)
  const seen = new Set()
  const order = []
  const queue = [...(incoming[nodeId] || [])]
  while (queue.length) {
    const id = queue.shift()
    if (seen.has(id)) continue
    seen.add(id)
    const node = byId.get(id)
    if (node) order.push(node)
    queue.push(...(incoming[id] || []))
  }
  return order
}

// Collapsible helper inside the config panel: every upstream node with the
// fields it actually produces, as click-to-copy {{id.path}} chips.
//
// The field list is **fetched, not hard-coded**. It used to be a table in this
// file mapping each node type to the keys it emits, which is a second copy of a
// truth that lives in the runners — it drifted (no switch, no validate, no
// filter) the moment either side moved. `POST /workflows/:id/types` infers the
// same answer from the graph itself, so the picker gains three things the table
// could never have: the *type* of each field, references nested one level deep
// (`body.total`), and shapes that depend on config rather than on node type —
// a Transform node's template, a Filter's element type.
//
// The request carries the live canvas, because the graph on screen is the one
// the author is wiring up and it may not be saved yet. It is issued lazily, on
// first expand: a schema nobody looked at costs nothing.
export default function VariableExplorer({ node, nodes = [], edges = [], workflowId }) {
  const upstream = useMemo(
    () => (node ? upstreamOf(node.id, nodes, edges) : []),
    [node, nodes, edges]
  )

  const [open, setOpen] = useState(false)
  const [schema, setSchema] = useState(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [copiedRef, setCopiedRef] = useState(null)
  const resetTimer = useRef(null)
  useEffect(() => () => clearTimeout(resetTimer.current), [])

  const load = useCallback(async () => {
    if (!workflowId) return
    setLoading(true)
    setFailed(false)
    try {
      const data = await apiFetch(`/api/workflows/${workflowId}/types`, {
        method: 'POST',
        body: { nodes, edges },
      })
      setSchema(data.nodes || {})
    } catch {
      // The picker still lists the upstream nodes; only the field chips are
      // lost, so a failed analysis degrades instead of blanking the panel.
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [workflowId, nodes, edges])

  // Re-fetch whenever the graph changes underneath an open picker: the whole
  // point is that the chips describe the canvas as it is now.
  useEffect(() => {
    if (open) load()
  }, [open, load])

  if (upstream.length === 0) return null

  const copy = (ref) => {
    try {
      navigator.clipboard?.writeText(ref)
    } catch {
      /* clipboard unavailable (permissions, http) — the chip text still shows the ref */
    }
    setCopiedRef(ref)
    clearTimeout(resetTimer.current)
    resetTimer.current = setTimeout(() => setCopiedRef(null), 1200)
  }

  return (
    <details
      className="var-explorer"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="var-explorer__summary">
        ⚡ Insert data from upstream ({upstream.length} node{upstream.length > 1 ? 's' : ''})
      </summary>
      <p className="var-explorer__hint">
        Click a field to copy its <code>{'{{…}}'}</code> reference, then paste it into any
        input above. Types are inferred from the graph.
      </p>
      {loading && !schema && <p className="var-explorer__note">Analysing the graph…</p>}
      {failed && (
        <p className="var-explorer__note">
          Could not analyse the graph — field names are unavailable, but every reference still
          takes the form <code>{'{{node-id.field}}'}</code>.
        </p>
      )}
      <ul className="var-explorer__list">
        {upstream.map((source) => {
          const output = schema?.[source.id]?.output
          const fields = output?.fields || []
          return (
            <li className="var-explorer__node" key={source.id}>
              <div className="var-explorer__node-head">
                <span className="var-explorer__node-label">
                  {source.data?.label || source.id}
                </span>
                <span className="var-explorer__node-type">{source.type}</span>
              </div>
              {output?.described && (
                <code className="var-explorer__shape">{output.described}</code>
              )}
              {fields.length > 0 && (
                <div className="var-explorer__chips">
                  {fields.map((field) => {
                    const ref = `{{${source.id}.${field.path}}}`
                    return (
                      <button
                        key={field.path}
                        type="button"
                        className="var-explorer__chip"
                        title={`Copy ${ref} — ${field.type}${field.optional ? ' (may be absent)' : ''}`}
                        onClick={() => copy(ref)}
                      >
                        {copiedRef === ref ? '✓ Copied' : `.${field.path}`}
                        {copiedRef !== ref && (
                          <span className="var-explorer__chip-type">{field.type}</span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
              {/* An open or dynamic shape has fields we deliberately don't
                  claim to know — say so rather than implying the list is all
                  there is. */}
              {output?.described?.includes('…') && (
                <p className="var-explorer__note">
                  …plus whatever else the data carries at run time.
                </p>
              )}
            </li>
          )
        })}
      </ul>
    </details>
  )
}
