import { Handle, Position } from 'reactflow'
import SourceHandles from './SourceHandles'

// Sub-workflow node: calls another workflow as a step. The nested-boxes icon
// signals "a workflow inside this workflow". The second line shows the selected
// target workflow's name (denormalized into config.workflowName when picked in the
// config panel) so the canvas reads at a glance which workflow it runs.
export default function SubWorkflowNode({ data, selected }) {
  const target = data.config?.workflowName
  return (
    <div className={`node node--subworkflow${selected ? ' node--selected' : ''}`}>
      <Handle type="target" position={Position.Top} />
      <div className="node__subworkflow-head">
        <svg
          className="node__icon"
          viewBox="0 0 16 16"
          width="14"
          height="14"
          aria-hidden="true"
        >
          {/* two nested rounded rectangles */}
          <rect x="1.5" y="1.5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
        <span className="node__label">{data.label || 'Sub-workflow'}</span>
      </div>
      <div className="node__type">{target || 'no workflow selected'}</div>
      <SourceHandles config={data.config} />
    </div>
  )
}
