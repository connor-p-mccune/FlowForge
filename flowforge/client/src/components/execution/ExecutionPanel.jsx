import { useState } from 'react'
import ExecutionHistory from './ExecutionHistory'

export function StepList({ steps, nodes }) {
  const labelFor = (nodeId) =>
    nodes?.find((n) => n.id === nodeId)?.data?.label || nodeId

  if (!steps || steps.length === 0) {
    return <p className="exec-panel__empty">Waiting for steps…</p>
  }

  return (
    <ol className="step-list">
      {steps.map((s) => (
        <li key={s.nodeId} className="step">
          <span className={`status-badge status-badge--${s.status}`}>{s.status}</span>
          <span className="step__label">{labelFor(s.nodeId)}</span>
          {(s.output || s.error) && (
            <details className="step__details">
              <summary>{s.error ? 'error' : 'output'}</summary>
              <pre>{s.error || JSON.stringify(s.output, null, 2)}</pre>
            </details>
          )}
        </li>
      ))}
    </ol>
  )
}

export default function ExecutionPanel({ open, onClose, execution, steps, nodes, workflowId }) {
  const [tab, setTab] = useState('live')

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
          <ExecutionHistory workflowId={workflowId} nodes={nodes} />
        )}
      </div>
    </div>
  )
}
