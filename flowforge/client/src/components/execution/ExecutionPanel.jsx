import { useState } from 'react'
import ExecutionHistory from './ExecutionHistory'

// `childExecutionsByNode` (optional) maps a step's nodeId → the sub-workflow runs
// that step spawned, each { execution, steps, childExecutionsByNode } so the tree
// nests recursively. Present in the History detail view (fetched from
// GET /api/executions/:id); absent for the live socket-driven run.
// `pendingApprovals` (optional) maps a nodeId → its waiting approval request;
// paired with `onRespondApproval`, a running approval step grows inline
// Approve / Reject controls.
export function StepList({ steps, nodes, childExecutionsByNode, pendingApprovals, onRespondApproval }) {
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
        const approval = s.status === 'running' ? pendingApprovals?.[s.nodeId] : null
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
            {approval && onRespondApproval && (
              <div className="approval-actions">
                <span className="approval-actions__message">
                  {approval.message || 'Waiting for approval'}
                </span>
                <div className="approval-actions__buttons">
                  <button
                    className="approval-actions__btn approval-actions__btn--approve"
                    onClick={() => onRespondApproval(approval.id, 'approve')}
                  >
                    ✓ Approve
                  </button>
                  <button
                    className="approval-actions__btn approval-actions__btn--reject"
                    onClick={() => onRespondApproval(approval.id, 'reject')}
                  >
                    ✕ Reject
                  </button>
                </div>
              </div>
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

export default function ExecutionPanel({ open, onClose, execution, steps, nodes, workflowId, initialHistoryExecId, onCancel, pendingApprovals, onRespondApproval }) {
  // Arriving via a notification deep link opens straight to the run's history.
  const [tab, setTab] = useState(initialHistoryExecId ? 'history' : 'live')

  if (!open) return null

  const cancellable =
    Boolean(onCancel) &&
    execution?.id &&
    (execution.status === 'pending' || execution.status === 'running')

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
        {tab === 'live' && cancellable && (
          <button
            className="exec-panel__stop"
            title="Stop this run — the node in flight finishes, the rest is skipped"
            onClick={onCancel}
          >
            ■ Stop
          </button>
        )}
        <button className="exec-panel__close" title="Close" onClick={onClose}>×</button>
      </div>
      <div className="exec-panel__body">
        {tab === 'live' ? (
          execution ? (
            <>
              {execution.error && <p className="exec-panel__error">{execution.error}</p>}
              <StepList
                steps={steps}
                nodes={nodes}
                pendingApprovals={pendingApprovals}
                onRespondApproval={onRespondApproval}
              />
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
