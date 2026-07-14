import { Handle, Position } from 'reactflow'

// Bottom source handle(s) for node types that support the on-error policy.
// Normally a single centered handle. When the node routes caught failures to
// its error branch (config.onError === 'branch') the main handle shifts left
// and a dedicated red 'error' handle appears — its id is what the engine
// matches each edge's sourceHandle against, exactly like a condition's
// true/false handles. The main handle keeps no id so existing edges (and the
// engine's default activation) are untouched by toggling the policy.
export default function SourceHandles({ config }) {
  if (config?.onError !== 'branch') {
    return <Handle type="source" position={Position.Bottom} />
  }
  return (
    <>
      <div className="node__condition-labels">
        <span className="node__condition-label node__condition-label--true">ok</span>
        <span className="node__condition-label node__condition-label--false">error</span>
      </div>
      <Handle type="source" position={Position.Bottom} style={{ left: '30%' }} />
      <Handle
        type="source"
        position={Position.Bottom}
        id="error"
        className="node__handle--error"
        style={{ left: '70%' }}
      />
    </>
  )
}
