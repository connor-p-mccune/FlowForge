import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../../services/api'
import { useToast } from '../../hooks/useToast'
import { StepList } from './ExecutionPanel'
import ExecutionTimeline from './ExecutionTimeline'
import { SkeletonRows } from '../Skeleton'

function parseSteps(rows) {
  return rows.map((r) => ({
    nodeId: r.node_id,
    type: r.node_type,
    status: r.status,
    output: r.output_json ? JSON.parse(r.output_json) : null,
    error: r.error,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  }))
}

// Reshape the recursive childExecutions tree from GET /api/executions/:id into a
// map keyed by the parent step's node id, so StepList can nest each sub-workflow
// run under the step that spawned it. Recurses for nested sub-workflows.
function buildChildMap(childExecutions) {
  const map = {}
  for (const child of childExecutions || []) {
    const nodeId = child.execution.parent_node_id
    if (!nodeId) continue
    ;(map[nodeId] ||= []).push({
      execution: child.execution,
      steps: parseSteps(child.steps),
      childExecutionsByNode: buildChildMap(child.childExecutions),
    })
  }
  return map
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
    case 'resume':
      return 'resume'
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

// Confirmation card for resuming a failed/cancelled run. Distinct from replay:
// a resume continues the same run — succeeded steps are reused, only the
// failed remainder re-executes.
function ResumeConfirm({ modified, busy, onCancel, onConfirm }) {
  return (
    <div className="replay-confirm" role="dialog" aria-label="Confirm resume">
      <p className="replay-confirm__message">
        Continue this run from where it stopped? Steps that already succeeded are
        reused — only the failed part re-runs.
      </p>
      {modified && (
        <p className="replay-confirm__warning">
          Note: this workflow has been modified since this execution. Edited nodes
          (and everything downstream of them) will re-run instead of being reused.
        </p>
      )}
      <div className="confirm-dialog__actions">
        <button className="confirm-dialog__cancel" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="confirm-dialog__confirm" onClick={onConfirm} disabled={busy}>
          {busy ? 'Starting…' : 'Resume'}
        </button>
      </div>
    </div>
  )
}

// Only a run that stopped short can be continued.
function isResumable(execution) {
  return execution.status === 'failed' || execution.status === 'cancelled'
}

export default function ExecutionHistory({ workflowId, nodes, autoOpenId }) {
  const [executions, setExecutions] = useState([])
  const [workflowUpdatedAt, setWorkflowUpdatedAt] = useState(null)
  const [selected, setSelected] = useState(null) // { execution, steps }
  const [detailView, setDetailView] = useState('steps') // 'steps' | 'timeline'
  const [pendingReplay, setPendingReplay] = useState(null) // execution awaiting confirm
  const [pendingResume, setPendingResume] = useState(null) // execution awaiting confirm
  const [replaying, setReplaying] = useState(false)
  const [resuming, setResuming] = useState(false)
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
    setPendingResume(null)
    setDetailView('steps')
    try {
      const { execution, steps, childExecutions, criticalPath } = await apiFetch(
        `/api/executions/${executionId}`
      )
      setSelected({
        execution,
        steps: parseSteps(steps),
        childExecutionsByNode: buildChildMap(childExecutions),
        criticalPath,
      })
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

  async function handleResume() {
    if (!pendingResume) return
    setResuming(true)
    try {
      await apiFetch(`/api/executions/${pendingResume.id}/resume`, { method: 'POST' })
      toast.success('Run resumed')
      setPendingResume(null)
      setSelected(null) // back to the list so the resumed run shows at the top
      await load()
    } catch (err) {
      toast.error(`Couldn’t resume: ${err.message}`)
    } finally {
      setResuming(false)
    }
  }

  if (error) return <p className="exec-panel__error">{error}</p>
  if (loading) return <SkeletonRows count={4} height={34} />

  if (selected) {
    const showReplayConfirm = pendingReplay?.id === selected.execution.id
    const showResumeConfirm = pendingResume?.id === selected.execution.id
    return (
      <div>
        <div className="exec-history__detail-header">
          <button
            className="exec-history__back"
            onClick={() => {
              setSelected(null)
              setPendingReplay(null)
              setPendingResume(null)
            }}
          >
            ← All runs
          </button>
          <div className="exec-history__detail-actions">
            {isResumable(selected.execution) && (
              <button
                className="exec-history__replay exec-history__replay--header"
                aria-label="Resume this run"
                onClick={() => {
                  setPendingReplay(null)
                  setPendingResume(selected.execution)
                }}
              >
                ↪ Resume
              </button>
            )}
            <button
              className="exec-history__replay exec-history__replay--header"
              aria-label="Replay this run"
              onClick={() => {
                setPendingResume(null)
                setPendingReplay(selected.execution)
              }}
            >
              ↻ Replay
            </button>
          </div>
        </div>
        {showReplayConfirm && (
          <ReplayConfirm
            label={triggerLabel(selected.execution)}
            modified={isModifiedSince(selected.execution)}
            busy={replaying}
            onCancel={() => setPendingReplay(null)}
            onConfirm={handleReplay}
          />
        )}
        {showResumeConfirm && (
          <ResumeConfirm
            modified={isModifiedSince(selected.execution)}
            busy={resuming}
            onCancel={() => setPendingResume(null)}
            onConfirm={handleResume}
          />
        )}
        <div className="exec-history__viewtoggle" role="tablist" aria-label="Run detail view">
          <button
            role="tab"
            aria-selected={detailView === 'steps'}
            className={`exec-history__viewtab${detailView === 'steps' ? ' exec-history__viewtab--active' : ''}`}
            onClick={() => setDetailView('steps')}
          >
            Steps
          </button>
          <button
            role="tab"
            aria-selected={detailView === 'timeline'}
            className={`exec-history__viewtab${detailView === 'timeline' ? ' exec-history__viewtab--active' : ''}`}
            onClick={() => setDetailView('timeline')}
          >
            Timeline
          </button>
        </div>
        {detailView === 'timeline' ? (
          <ExecutionTimeline
            steps={selected.steps}
            nodes={nodes}
            criticalPath={selected.criticalPath}
          />
        ) : (
          <StepList
            steps={selected.steps}
            nodes={nodes}
            childExecutionsByNode={selected.childExecutionsByNode}
          />
        )}
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
              {ex.trigger_type === 'resume' && (
                <span
                  className="exec-history__resumed-badge"
                  title="Continues an earlier run — its succeeded steps were reused"
                >
                  Resumed
                </span>
              )}
              <span className="exec-history__date">
                {new Date(ex.created_at).toLocaleString()}
              </span>
              <span className="exec-history__duration">{formatDuration(ex)}</span>
            </button>
            {isResumable(ex) && (
              <button
                className="exec-history__replay"
                aria-label="Resume this run"
                title="Resume this run — succeeded steps are reused, only the failed part re-runs"
                onClick={() => {
                  setPendingReplay(null)
                  setPendingResume(ex)
                }}
              >
                ↪
              </button>
            )}
            <button
              className="exec-history__replay"
              aria-label="Replay this run"
              title="Replay this run"
              onClick={() => {
                setPendingResume(null)
                setPendingReplay(ex)
              }}
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
          {pendingResume?.id === ex.id && (
            <ResumeConfirm
              modified={isModifiedSince(ex)}
              busy={resuming}
              onCancel={() => setPendingResume(null)}
              onConfirm={handleResume}
            />
          )}
        </li>
      ))}
    </ul>
  )
}
