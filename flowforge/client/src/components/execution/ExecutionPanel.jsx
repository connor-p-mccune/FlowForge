import { useState } from 'react'
import TraceLink from './TraceLink'
import ExecutionHistory from './ExecutionHistory'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001'

// A running wait-callback step: show the one-time URL the run is waiting on,
// with a copy button, so a manual test (or an operator poking a stuck
// integration) is one paste away from a curl command.
function CallbackWaiting({ callback }) {
  const [copied, setCopied] = useState(false)
  const url = `${API_BASE}${callback.url}`
  return (
    <div className="callback-waiting">
      <span className="callback-waiting__label">Waiting for POST to</span>
      <code className="callback-waiting__url">{url}</code>
      <button
        type="button"
        className="callback-waiting__copy"
        onClick={() => {
          navigator.clipboard?.writeText(url)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

// What a gate asks for beyond one response from anybody, and how far along it
// is. Renders nothing for an ordinary approval — a line reading "1 approval
// required" on every gate is one people learn to skip, and this one has to be
// read on the day it says four.
function ApprovalGate({ approval }) {
  const quorum = Number(approval.quorum) || 1
  const rules = []
  if (approval.requiredRole === 'owner') rules.push('workspace owners only')
  if (approval.separationOfDuties) rules.push('not whoever started the run')
  if (quorum <= 1 && rules.length === 0) return null

  const approvals = Number(approval.approvals) || 0
  return (
    <span className="approval-gate">
      {quorum > 1 && (
        <span className="approval-gate__quorum">
          {approvals} of {quorum} approvals
        </span>
      )}
      {rules.length > 0 && <span className="approval-gate__rules">{rules.join(' · ')}</span>}
    </span>
  )
}

// `childExecutionsByNode` (optional) maps a step's nodeId → the sub-workflow runs
// that step spawned, each { execution, steps, childExecutionsByNode } so the tree
// nests recursively. Present in the History detail view (fetched from
// GET /api/executions/:id); absent for the live socket-driven run.
// `pendingApprovals` (optional) maps a nodeId → its waiting approval request;
// paired with `onRespondApproval`, a running approval step grows inline
// Approve / Reject controls. `pendingCallbacks` (optional) maps a nodeId → its
// waiting callback ({ url, expiresAt }) for the same treatment.
// Why a step did not run, shown under the step somebody is already looking at.
//
// The run panel's whole job is answering "what happened", and for a skipped
// step it has always answered with the word `skipped` — which is the fact the
// person reading it already had. This is the sentence they came for.
function SkipReason({ because }) {
  if (!because) return null
  return (
    <p className="step__because">
      <span className="step__because-cause">{because.label}</span> was{' '}
      <span className="step__because-outcome">{String(because.outcome)}</span>, and that branch does
      not reach it.
      {because.expression && (
        <span className="step__because-expr">
          {because.expression}
          {/* The values are read out of the recorded input, not re-derived — so
              `not set` really does mean the field was absent rather than
              falsy, which is most of what a 3am investigation is about. */}
          {because.reads.length > 0 &&
            ` — ${because.reads.map((r) => `${r.path} was ${r.value}`).join(', ')}`}
        </span>
      )}
    </p>
  )
}

export function StepList({ steps, nodes, childExecutionsByNode, pendingApprovals, onRespondApproval, pendingCallbacks, explanations }) {
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
        const callback = s.status === 'running' ? pendingCallbacks?.[s.nodeId] : null
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
            {s.status === 'skipped' && <SkipReason because={explanations?.[s.nodeId]} />}
            {callback && <CallbackWaiting callback={callback} />}
            {approval && onRespondApproval && (
              <div className="approval-actions">
                <span className="approval-actions__message">
                  {approval.message || 'Waiting for approval'}
                </span>
                <ApprovalGate approval={approval} />
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

export default function ExecutionPanel({ open, onClose, execution, steps, nodes, workflowId, initialHistoryExecId, onCancel, pendingApprovals, onRespondApproval, pendingCallbacks }) {
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
              <TraceLink executionId={execution.id} traceId={execution.trace_id} />
              <StepList
                steps={steps}
                nodes={nodes}
                pendingApprovals={pendingApprovals}
                onRespondApproval={onRespondApproval}
                pendingCallbacks={pendingCallbacks}
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
