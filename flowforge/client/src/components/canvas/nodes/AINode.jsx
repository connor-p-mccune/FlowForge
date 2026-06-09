import { Handle, Position } from 'reactflow'

export default function AINode({ data, selected }) {
  return (
    <div className={`node node--ai${selected ? ' node--selected' : ''}`}>
      <Handle type="target" position={Position.Top} />
      <div className="node__label">{data.label || 'AI'}</div>
      <div className="node__type">{data.subtype || 'prompt'}</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}
