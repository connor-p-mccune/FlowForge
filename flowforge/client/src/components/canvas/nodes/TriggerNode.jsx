import { Handle, Position } from 'reactflow'

export default function TriggerNode({ data, selected }) {
  return (
    <div className={`node node--trigger${selected ? ' node--selected' : ''}`}>
      <Handle type="source" position={Position.Bottom} />
      <div className="node__label">{data.label || 'Trigger'}</div>
      <div className="node__type">{data.subtype || 'manual'}</div>
    </div>
  )
}
