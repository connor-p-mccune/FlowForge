import { Handle, Position } from 'reactflow'

// For-each node: fans a workflow out over a list — the target runs once per
// item with { item, index, total } as its trigger payload. The circular-arrows
// icon signals iteration; the second line names the target workflow
// (denormalized into config.workflowName when picked in the config panel).
export default function ForEachNode({ data, selected }) {
  const target = data.config?.workflowName
  return (
    <div className={`node node--foreach${selected ? ' node--selected' : ''}`}>
      <Handle type="target" position={Position.Top} />
      <div className="node__subworkflow-head">
        <svg
          className="node__icon node__icon--foreach"
          viewBox="0 0 16 16"
          width="14"
          height="14"
          aria-hidden="true"
        >
          {/* circular arrows (loop) */}
          <path
            d="M 13 8 A 5 5 0 1 1 10.5 3.7"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
          <path d="M 10 1.2 L 13.4 3.4 L 9.9 5.4 Z" fill="currentColor" />
        </svg>
        <span className="node__label">{data.label || 'For Each'}</span>
      </div>
      <div className="node__type">
        {target ? `${target} · per item` : 'no workflow selected'}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}
