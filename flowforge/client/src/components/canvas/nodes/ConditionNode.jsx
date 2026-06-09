import { Handle, Position } from 'reactflow'

export default function ConditionNode({ data, selected }) {
  return (
    <div className={`node node--condition${selected ? ' node--selected' : ''}`}>
      <Handle type="target" position={Position.Top} />
      <div className="node__label">{data.label || 'Condition'}</div>
      <div className="node__condition-labels">
        <span className="node__condition-label node__condition-label--true">true</span>
        <span className="node__condition-label node__condition-label--false">false</span>
      </div>
      <Handle type="source" position={Position.Bottom} id="true" style={{ left: '30%' }} />
      <Handle type="source" position={Position.Bottom} id="false" style={{ left: '70%' }} />
    </div>
  )
}
