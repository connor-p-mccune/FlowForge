import { Handle, Position } from 'reactflow'

// Validate node: checks a payload against a JSON Schema and routes the run down
// the valid or invalid branch. The handle ids stay 'valid'/'invalid' so the
// engine routes them with the same sourceHandle mechanism as condition, switch,
// and approval branches.
export default function ValidateNode({ data, selected }) {
  return (
    <div className={`node node--validate${selected ? ' node--selected' : ''}`}>
      <Handle type="target" position={Position.Top} />
      <div className="node__label">{data.label || 'Validate'}</div>
      <div className="node__condition-labels">
        <span className="node__condition-label node__condition-label--true">valid</span>
        <span className="node__condition-label node__condition-label--false">invalid</span>
      </div>
      <Handle type="source" position={Position.Bottom} id="valid" style={{ left: '30%' }} />
      <Handle type="source" position={Position.Bottom} id="invalid" style={{ left: '70%' }} />
    </div>
  )
}
