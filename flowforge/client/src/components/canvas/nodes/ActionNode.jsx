import { useState } from 'react'
import { Handle, Position } from 'reactflow'

export default function ActionNode({ data, selected }) {
  // Set by WorkflowCanvas (render-only) after a dry run: the payload this action
  // would have sent. Present only for intercepted email/Slack/HTTP nodes.
  const dryRun = data.dryRunResult
  const [showPayload, setShowPayload] = useState(false)

  return (
    <div className={`node node--action${selected ? ' node--selected' : ''}`}>
      <Handle type="target" position={Position.Top} />
      <div className="node__label">{data.label || 'Action'}</div>
      <div className="node__type">{data.config?.method || data.subtype || 'HTTP Request'}</div>

      {dryRun && (
        <button
          type="button"
          className="node__dry-run-badge nodrag nopan"
          title="Test mode: this action did not fire — click to see what it would have sent"
          onClick={(e) => {
            e.stopPropagation()
            setShowPayload((v) => !v)
          }}
        >
          Would send
        </button>
      )}

      {dryRun && showPayload && (
        <div className="dry-run-popover nodrag nopan" onClick={(e) => e.stopPropagation()}>
          <div className="dry-run-popover__header">
            <span>Would send</span>
            <button
              type="button"
              className="dry-run-popover__close"
              title="Close"
              onClick={(e) => {
                e.stopPropagation()
                setShowPayload(false)
              }}
            >
              ×
            </button>
          </div>
          <pre className="dry-run-popover__body">{JSON.stringify(dryRun, null, 2)}</pre>
        </div>
      )}

      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}
