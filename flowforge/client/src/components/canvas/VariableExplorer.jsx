import { useEffect, useMemo, useRef, useState } from 'react'

// What each node type is known to emit, so the explorer can offer concrete
// {{id.field}} references. `note` covers types whose output is dynamic.
const NODE_OUTPUTS = {
  'trigger-manual': { fields: ['triggered'] },
  'trigger-webhook': {
    fields: ['triggered'],
    note: 'plus every field of the webhook POST body',
  },
  'trigger-schedule': { fields: ['triggered'] },
  'action-http': { fields: ['status', 'body'], note: 'body is the parsed response' },
  'action-delay': { fields: ['delayedMs'], note: 'plus everything from upstream (pass-through)' },
  'action-email': { fields: ['sent', 'to', 'subject', 'messageId'] },
  'action-slack': { fields: ['ok', 'text'] },
  transform: { fields: [], note: 'emits the keys of its output template' },
  condition: { fields: ['result'] },
  'ai-prompt': { fields: ['text'] },
  'ai-classify': { fields: ['label'] },
  'ai-extract': { fields: ['data'] },
  'output-log': { fields: ['message'] },
  'output-return': { fields: [], note: 'passes its input through unchanged' },
  'sub-workflow': { fields: [], note: 'emits whatever the called workflow returns' },
  'for-each': { fields: ['count', 'succeeded', 'failed', 'results'] },
}

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

// Collapsible helper inside the config panel: lists every upstream node with
// its known output fields as click-to-copy {{id.field}} chips, so wiring data
// between steps doesn't require memorizing node ids.
export default function VariableExplorer({ node, nodes = [], edges = [] }) {
  const upstream = useMemo(
    () => (node ? upstreamOf(node.id, nodes, edges) : []),
    [node, nodes, edges]
  )

  const [copiedRef, setCopiedRef] = useState(null)
  const resetTimer = useRef(null)
  useEffect(() => () => clearTimeout(resetTimer.current), [])

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
    <details className="var-explorer">
      <summary className="var-explorer__summary">
        ⚡ Insert data from upstream ({upstream.length} node{upstream.length > 1 ? 's' : ''})
      </summary>
      <p className="var-explorer__hint">
        Click a field to copy its <code>{'{{…}}'}</code> reference, then paste it into any
        input above.
      </p>
      <ul className="var-explorer__list">
        {upstream.map((source) => {
          const outputs = NODE_OUTPUTS[source.type] || { fields: [] }
          return (
            <li className="var-explorer__node" key={source.id}>
              <div className="var-explorer__node-head">
                <span className="var-explorer__node-label">
                  {source.data?.label || source.id}
                </span>
                <span className="var-explorer__node-type">{source.type}</span>
              </div>
              {outputs.fields.length > 0 && (
                <div className="var-explorer__chips">
                  {outputs.fields.map((field) => {
                    const ref = `{{${source.id}.${field}}}`
                    return (
                      <button
                        key={field}
                        type="button"
                        className="var-explorer__chip"
                        title={`Copy ${ref}`}
                        onClick={() => copy(ref)}
                      >
                        {copiedRef === ref ? '✓ Copied' : `.${field}`}
                      </button>
                    )
                  })}
                </div>
              )}
              {outputs.note && <p className="var-explorer__note">{outputs.note}</p>}
            </li>
          )
        })}
      </ul>
    </details>
  )
}
