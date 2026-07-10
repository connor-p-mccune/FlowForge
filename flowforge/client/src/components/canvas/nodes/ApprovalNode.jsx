import { Handle, Position } from 'reactflow'

// Approval gate: the run pauses here until a workspace member decides, then
// continues down the approved or rejected handle. The handle ids stay
// 'true'/'false' so the engine routes them with the same sourceHandle
// mechanism as condition branches.
export default function ApprovalNode({ data, selected }) {
  return (
    <div className={`node node--approval${selected ? ' node--selected' : ''}`}>
      <Handle type="target" position={Position.Top} />
      <div className="node__label">{data.label || 'Approval'}</div>
      {data.config?.message && (
        <div className="node__approval-message" title={data.config.message}>
          {data.config.message}
        </div>
      )}
      <div className="node__condition-labels">
        <span className="node__condition-label node__condition-label--true">approved</span>
        <span className="node__condition-label node__condition-label--false">rejected</span>
      </div>
      <Handle type="source" position={Position.Bottom} id="true" style={{ left: '30%' }} />
      <Handle type="source" position={Position.Bottom} id="false" style={{ left: '70%' }} />
    </div>
  )
}
