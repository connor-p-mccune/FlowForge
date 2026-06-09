import { Handle, Position } from 'reactflow'

export default function OutputNode({ data, selected }) {
  return (
    <div className={`node node--output${selected ? ' node--selected' : ''}`}>
      <Handle type="target" position={Position.Top} />
      <div className="node__label">{data.label || 'Output'}</div>
      <div className="node__type">{data.subtype || 'log'}</div>
    </div>
  )
}
