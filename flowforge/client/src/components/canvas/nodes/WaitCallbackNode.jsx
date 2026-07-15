import { Handle, Position } from 'reactflow'

// Wait-for-callback gate: the machine-in-the-loop counterpart to approval.
// The run pauses here until an external system POSTs to the node's one-time
// callback URL, then continues down the received or timed-out handle — the
// ids are what the engine matches each edge's sourceHandle against, exactly
// like approval's pair. While a run waits, the URL shows in the run panel.
export default function WaitCallbackNode({ data, selected }) {
  const failOnTimeout = data.config?.onTimeout === 'fail'
  return (
    <div className={`node node--callback${selected ? ' node--selected' : ''}`}>
      <Handle type="target" position={Position.Top} />
      <div className="node__label">{data.label || 'Wait for Callback'}</div>
      <div className="node__type">
        {failOnTimeout ? 'fails on timeout' : 'callback gate'}
      </div>
      <div className="node__condition-labels">
        <span className="node__condition-label node__condition-label--true">received</span>
        <span className="node__condition-label node__condition-label--false">timed out</span>
      </div>
      <Handle type="source" position={Position.Bottom} id="received" style={{ left: '30%' }} />
      <Handle type="source" position={Position.Bottom} id="timed-out" style={{ left: '70%' }} />
    </div>
  )
}
