import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../../services/api'
import { useToast } from '../../hooks/useToast'

// "Waiting on you" — pending approval gates across every workspace the viewer
// belongs to, surfaced on the dashboard so a paused run is impossible to miss.
// Renders nothing when the inbox is empty; each row settles inline or jumps
// to the paused run on its canvas.

function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return ''
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export default function ApprovalsInbox() {
  const toast = useToast()
  const navigate = useNavigate()
  const [approvals, setApprovals] = useState(null) // null = loading (render nothing)

  useEffect(() => {
    let cancelled = false
    apiFetch('/api/approvals?status=pending')
      .then(({ approvals: list }) => {
        if (!cancelled) setApprovals(list || [])
      })
      .catch(() => {
        // The dashboard must never break over its widget — an error just
        // renders as an empty inbox.
        if (!cancelled) setApprovals([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function respond(approval, decision) {
    try {
      await apiFetch(`/api/approvals/${approval.id}/respond`, {
        method: 'POST',
        body: { decision },
      })
      toast.success(decision === 'approve' ? 'Approved — run continuing.' : 'Rejected.')
    } catch (err) {
      // A conflict means someone else already decided — either way the row is done.
      toast.error(`Couldn’t record the decision: ${err.message}`)
    }
    setApprovals((prev) => prev.filter((a) => a.id !== approval.id))
  }

  if (!approvals || approvals.length === 0) return null

  return (
    <section className="approvals-inbox" aria-label="Pending approvals">
      <h3 className="approvals-inbox__title">
        Waiting on you <span className="approvals-inbox__count">{approvals.length}</span>
      </h3>
      <ul className="approvals-inbox__list">
        {approvals.map((a) => (
          <li key={a.id} className="approvals-inbox__item">
            <button
              className="approvals-inbox__main"
              title="Open the paused run"
              onClick={() => navigate(`/workflow/${a.workflow_id}?execution=${a.execution_id}`)}
            >
              <span className="approvals-inbox__workflow">{a.workflow_name || 'a workflow'}</span>
              {a.message && <span className="approvals-inbox__message">{a.message}</span>}
              <span className="approvals-inbox__time">{timeAgo(a.requested_at)}</span>
            </button>
            <div className="approvals-inbox__actions">
              <button
                className="approval-actions__btn approval-actions__btn--approve"
                onClick={() => respond(a, 'approve')}
              >
                ✓ Approve
              </button>
              <button
                className="approval-actions__btn approval-actions__btn--reject"
                onClick={() => respond(a, 'reject')}
              >
                ✕ Reject
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
