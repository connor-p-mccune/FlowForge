import { Handle, Position } from 'reactflow'
import SourceHandles from './SourceHandles'

export default function AINode({ data, selected }) {
  return (
    <div className={`node node--ai${selected ? ' node--selected' : ''}`}>
      <Handle type="target" position={Position.Top} />
      <div className="node__label">{data.label || 'AI'}</div>
      <div className="node__type">{data.subtype || 'prompt'}</div>
      <SourceHandles config={data.config} />
    </div>
  )
}
