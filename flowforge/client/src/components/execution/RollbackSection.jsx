import { useState } from 'react'
import { apiFetch } from '../../services/api'
import { useToast } from '../../hooks/useToast'

// The rollback of a failed run, on the run detail.
//
// This section only exists when a run was actually unwound, and its whole job
// is to answer one question fast: **is anything still standing?** A failed run
// whose compensations all took is closed; one that landed `partial` has real
// side effects outstanding in production, and somebody has to act. So the
// heading states the verdict rather than making it something to infer from a
// list of rows, and the retry button appears only in the case that needs it.
//
// The rows are ordered as they ran — newest effect undone first — because that
// is the order the operator has to reason about when the unwind stopped
// partway: everything above a failure is done, everything below it is not.

function label(nodes, nodeId) {
  return nodes?.find?.((n) => n.id === nodeId)?.data?.label || nodeId
}

export default function RollbackSection({ execution, compensations, nodes, onRolledBack }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  if (!compensations || compensations.length === 0) return null

  const status = execution?.rollback_status
  const failed = compensations.filter((c) => c.status === 'failed')
  const partial = status === 'partial' || failed.length > 0

  async function handleRetry() {
    setBusy(true)
    try {
      const res = await apiFetch(`/api/executions/${execution.id}/rollback`, { method: 'POST' })
      toast[res.outcome === 'completed' ? 'success' : 'error'](
        res.outcome === 'completed'
          ? 'Rollback completed — every compensation took'
          : 'Rollback still partial — some compensations are still failing'
      )
      setConfirming(false)
      onRolledBack?.()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={`rollback${partial ? ' rollback--partial' : ''}`}>
      <div className="rollback__header">
        <span className="rollback__title">
          {partial ? '⚠ Rollback partial' : '↩ Rolled back'}
        </span>
        <span className="rollback__summary">
          {partial
            ? `${failed.length} of ${compensations.length} compensation${compensations.length === 1 ? '' : 's'} still failing`
            : `${compensations.length} compensation${compensations.length === 1 ? '' : 's'}, newest effect first`}
        </span>
      </div>

      {partial && (
        <p className="rollback__warning">
          Some of this run’s side effects are still standing. Fix the compensating
          node, then retry — only the outstanding ones re-run, so nothing is undone
          twice.
        </p>
      )}

      <ol className="rollback__list">
        {compensations.map((c) => (
          <li key={`${c.node_id}-${c.seq}`} className={`rollback__row rollback__row--${c.status}`}>
            <span className={`status-badge status-badge--${c.status === 'succeeded' ? 'completed' : 'failed'}`}>
              {c.status}
            </span>
            <span className="rollback__node">{label(nodes, c.node_id)}</span>
            <span className="rollback__undoes">
              undoes <strong>{label(nodes, c.target_node_id)}</strong>
            </span>
            {c.attempts > 1 && (
              <span className="rollback__attempts" title="Retries before it settled">
                {c.attempts}×
              </span>
            )}
            {c.error && <span className="rollback__error">{c.error}</span>}
          </li>
        ))}
      </ol>

      {partial && !confirming && (
        <button className="rollback__retry" onClick={() => setConfirming(true)}>
          Retry the rollback
        </button>
      )}
      {partial && confirming && (
        <div className="rollback__confirm">
          <p>
            This runs the {failed.length} outstanding compensation
            {failed.length === 1 ? '' : 's'} for real. Compensations that already
            succeeded are skipped.
          </p>
          <div className="rollback__confirm-actions">
            <button onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </button>
            <button className="rollback__retry" onClick={handleRetry} disabled={busy}>
              {busy ? 'Running…' : 'Run them'}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
