import { Handle, Position } from 'reactflow'

export default function ActionNode({ data, selected }) {
  return (
    <div className={`node node--action${selected ? ' node--selected' : ''}`}>
      <Handle type="target" position={Position.Top} />
      <div className="node__label">{data.label || 'Action'}</div>
      <div className="node__type">{data.config?.method || data.subtype || 'HTTP Request'}</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}
