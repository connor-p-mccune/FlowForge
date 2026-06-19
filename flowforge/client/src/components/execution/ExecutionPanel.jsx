import { useState } from 'react'
import ExecutionHistory from './ExecutionHistory'

// `childExecutionsByNode` (optional) maps a step's nodeId → the sub-workflow runs
// that step spawned, each { execution, steps, childExecutionsByNode } so the tree
// nests recursively. Present in the History detail view (fetched from
// GET /api/executions/:id); absent for the live socket-driven run.
export function StepList({ steps, nodes, childExecutionsByNode }) {
  // Prefer the canvas node's label; nested child steps belong to another workflow
  // whose nodes aren't on this canvas, so fall back to the step's node type, then id.
  const labelFor = (step) =>
    nodes?.find((n) => n.id === step.nodeId)?.data?.label || step.type || step.nodeId

  if (!steps || steps.length === 0) {
    return <p className="exec-panel__empty">Waiting for steps…</p>
  }

  return (
    <ol className="step-list">
      {steps.map((s) => {
        const children = childExecutionsByNode?.[s.nodeId]
        return (
          <li key={s.nodeId} className="step">
            <span className={`status-badge status-badge--${s.status}`}>{s.status}</span>
            <span className="step__label">{labelFor(s)}</span>
            {(s.output || s.error) && (
              <details className="step__details">
                <summary>{s.error ? 'error' : 'output'}</summary>
                <pre>{s.error || JSON.stringify(s.output, null, 2)}</pre>
              </details>
            )}
            {children && children.length > 0 && (
              <div className="step__subworkflows">
                {children.map((child) => (
                  <details key={child.execution.id} className="step__subworkflow" open>
                    <summary className="step__subworkflow-summary">
                      <span aria-hidden="true">↳ </span>Sub-workflow run
                      <span className={`status-badge status-badge--${child.execution.status}`}>
                        {child.execution.status}
                      </span>
                    </summary>
                    <div className="step__subworkflow-body">
                      <StepList
                        steps={child.steps}
                        nodes={nodes}
                        childExecutionsByNode={child.childExecutionsByNode}
                      />
                    </div>
                  </details>
                ))}
              </div>
            )}
          </li>
        )
      })}
    </ol>
  )
}

export default function ExecutionPanel({ open, onClose, execution, steps, nodes, workflowId, initialHistoryExecId }) {
  // Arriving via a notification deep link opens straight to the run's history.
  const [tab, setTab] = useState(initialHistoryExecId ? 'history' : 'live')

  if (!open) return null

  return (
    <div className="exec-panel">
      <div className="exec-panel__header">
        <div className="exec-panel__tabs">
          <button
            className={`exec-panel__tab${tab === 'live' ? ' exec-panel__tab--active' : ''}`}
            onClick={() => setTab('live')}
          >
            Current run
          </button>
          <button
            className={`exec-panel__tab${tab === 'history' ? ' exec-panel__tab--active' : ''}`}
            onClick={() => setTab('history')}
          >
            History
          </button>
        </div>
        {tab === 'live' && execution && (
          <span className={`status-badge status-badge--${execution.status}`}>
            {execution.status}
          </span>
        )}
        <button className="exec-panel__close" title="Close" onClick={onClose}>×</button>
      </div>
      <div className="exec-panel__body">
        {tab === 'live' ? (
          execution ? (
            <>
              {execution.error && <p className="exec-panel__error">{execution.error}</p>}
              <StepList steps={steps} nodes={nodes} />
            </>
          ) : (
            <p className="exec-panel__empty">Press Run to execute this workflow.</p>
          )
        ) : (
          <ExecutionHistory workflowId={workflowId} nodes={nodes} autoOpenId={initialHistoryExecId} />
        )}
      </div>
    </div>
  )
}
