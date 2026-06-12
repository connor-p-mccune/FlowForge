import { useState, useEffect } from 'react'
import { apiFetch } from '../../services/api'
import { StepList } from './ExecutionPanel'

function parseSteps(rows) {
  return rows.map((r) => ({
    nodeId: r.node_id,
    status: r.status,
    output: r.output_json ? JSON.parse(r.output_json) : null,
    error: r.error,
  }))
}

function formatDuration(execution) {
  if (!execution.started_at || !execution.finished_at) return '—'
  const ms = new Date(execution.finished_at) - new Date(execution.started_at)
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

export default function ExecutionHistory({ workflowId, nodes }) {
  const [executions, setExecutions] = useState([])
  const [selected, setSelected] = useState(null) // { execution, steps }
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    apiFetch(`/api/workflows/${workflowId}/executions`)
      .then(({ executions: list }) => { if (!cancelled) setExecutions(list) })
      .catch((err) => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [workflowId])

  async function openRun(executionId) {
    setError(null)
    try {
      const { execution, steps } = await apiFetch(`/api/executions/${executionId}`)
      setSelected({ execution, steps: parseSteps(steps) })
    } catch (err) {
      setError(err.message)
    }
  }

  if (error) return <p className="exec-panel__error">{error}</p>
  if (loading) return <p className="exec-panel__empty">Loading runs…</p>

  if (selected) {
    return (
      <div>
        <button className="exec-history__back" onClick={() => setSelected(null)}>
          ← All runs
        </button>
        <StepList steps={selected.steps} nodes={nodes} />
      </div>
    )
  }

  if (executions.length === 0) {
    return <p className="exec-panel__empty">No runs yet.</p>
  }

  return (
    <ul className="exec-history">
      {executions.map((ex) => (
        <li key={ex.id}>
          <button className="exec-history__row" onClick={() => openRun(ex.id)}>
            <span className={`status-badge status-badge--${ex.status}`}>{ex.status}</span>
            <span className="exec-history__date">
              {new Date(ex.created_at).toLocaleString()}
            </span>
            <span className="exec-history__duration">{formatDuration(ex)}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}
