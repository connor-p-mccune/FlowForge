import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../../services/api'
import { useToast } from '../../hooks/useToast'
import { StepList } from './ExecutionPanel'
import { SkeletonRows } from '../Skeleton'

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

// How the run was triggered, for the replay confirmation copy. Falls back to an
// inference for legacy rows saved before trigger_type existed (a user id means a
// manual run; its absence means an external webhook).
function triggerLabel(execution) {
  switch (execution.trigger_type) {
    case 'webhook':
      return 'webhook'
    case 'manual':
      return 'manual'
    case 'schedule':
      return 'schedule'
    case 'replay':
      return 'replay'
    case 'dry-run':
      return 'test'
    default:
      return execution.triggered_by ? 'manual' : 'webhook'
  }
}

// Small confirmation card shown before a replay. Reuses the app's confirm-dialog
// button styles; role="dialog" so it's announced and testable like other confirms.
function ReplayConfirm({ label, modified, busy, onCancel, onConfirm }) {
  return (
    <div className="replay-confirm" role="dialog" aria-label="Confirm replay">
      <p className="replay-confirm__message">
        Re-run this workflow with the original {label} trigger data?
      </p>
      {modified && (
        <p className="replay-confirm__warning">
          Note: this workflow has been modified since this execution. The current
          workflow definition will run with the original trigger data.
        </p>
      )}
      <div className="confirm-dialog__actions">
        <button className="confirm-dialog__cancel" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="confirm-dialog__confirm" onClick={onConfirm} disabled={busy}>
          {busy ? 'Starting…' : 'Confirm'}
        </button>
      </div>
    </div>
  )
}

export default function ExecutionHistory({ workflowId, nodes, autoOpenId }) {
  const [executions, setExecutions] = useState([])
  const [workflowUpdatedAt, setWorkflowUpdatedAt] = useState(null)
  const [selected, setSelected] = useState(null) // { execution, steps }
  const [pendingReplay, setPendingReplay] = useState(null) // execution awaiting confirm
  const [replaying, setReplaying] = useState(false)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const toast = useToast()

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { executions: list, workflowUpdatedAt: updatedAt } = await apiFetch(
        `/api/workflows/${workflowId}/executions`
      )
      setExecutions(list)
      setWorkflowUpdatedAt(updatedAt || null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [workflowId])

  useEffect(() => {
    load()
  }, [load])

  // True when the workflow has been edited since this run started — a replay runs
  // the current definition, so the original output may not reproduce.
  function isModifiedSince(execution) {
    return Boolean(
      workflowUpdatedAt &&
        execution.created_at &&
        new Date(workflowUpdatedAt) > new Date(execution.created_at)
    )
  }

  const openRun = useCallback(async (executionId) => {
    setError(null)
    setPendingReplay(null)
    try {
      const { execution, steps } = await apiFetch(`/api/executions/${executionId}`)
      setSelected({ execution, steps: parseSteps(steps) })
    } catch (err) {
      setError(err.message)
    }
  }, [])

  // Auto-open a specific run when deep-linked from a notification.
  useEffect(() => {
    if (autoOpenId) openRun(autoOpenId)
  }, [autoOpenId, openRun])

  async function handleReplay() {
    if (!pendingReplay) return
    setReplaying(true)
    try {
      await apiFetch(`/api/executions/${pendingReplay.id}/replay`, { method: 'POST' })
      toast.success('Execution started')
      setPendingReplay(null)
      setSelected(null) // back to the list so the new run shows at the top
      await load()
    } catch (err) {
      toast.error(`Couldn’t start replay: ${err.message}`)
    } finally {
      setReplaying(false)
    }
  }

  if (error) return <p className="exec-panel__error">{error}</p>
  if (loading) return <SkeletonRows count={4} height={34} />

  if (selected) {
    const showConfirm = pendingReplay?.id === selected.execution.id
    return (
      <div>
        <div className="exec-history__detail-header">
          <button
            className="exec-history__back"
            onClick={() => {
              setSelected(null)
              setPendingReplay(null)
            }}
          >
            ← All runs
          </button>
          <button
            className="exec-history__replay exec-history__replay--header"
            aria-label="Replay this run"
            onClick={() => setPendingReplay(selected.execution)}
          >
            ↻ Replay
          </button>
        </div>
        {showConfirm && (
          <ReplayConfirm
            label={triggerLabel(selected.execution)}
            modified={isModifiedSince(selected.execution)}
            busy={replaying}
            onCancel={() => setPendingReplay(null)}
            onConfirm={handleReplay}
          />
        )}
        <StepList steps={selected.steps} nodes={nodes} />
      </div>
    )
  }

  if (executions.length === 0) {
    return (
      <div className="exec-empty">
        <p className="exec-empty__title">No runs yet</p>
        <p className="exec-empty__hint">Press ▶ Run to execute this workflow.</p>
      </div>
    )
  }

  return (
    <ul className="exec-history">
      {executions.map((ex) => (
        <li className="exec-history__item" key={ex.id}>
          <div className="exec-history__row-wrap">
            <button
              className={`exec-history__row${ex.trigger_type === 'dry-run' ? ' exec-history__row--test' : ''}`}
              onClick={() => openRun(ex.id)}
            >
              <span className={`status-badge status-badge--${ex.status}`}>{ex.status}</span>
              {ex.trigger_type === 'dry-run' && (
                <span className="exec-history__test-badge" title="Test run — no actions fired">
                  Test
                </span>
              )}
              <span className="exec-history__date">
                {new Date(ex.created_at).toLocaleString()}
              </span>
              <span className="exec-history__duration">{formatDuration(ex)}</span>
            </button>
            <button
              className="exec-history__replay"
              aria-label="Replay this run"
              title="Replay this run"
              onClick={() => setPendingReplay(ex)}
            >
              ↻
            </button>
          </div>
          {pendingReplay?.id === ex.id && (
            <ReplayConfirm
              label={triggerLabel(ex)}
              modified={isModifiedSince(ex)}
              busy={replaying}
              onCancel={() => setPendingReplay(null)}
              onConfirm={handleReplay}
            />
          )}
        </li>
      ))}
    </ul>
  )
}
