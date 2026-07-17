import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { apiFetch } from '../../services/api'

// Public status page (/status/:token) — the read-only health rollup a
// workspace owner shares with people who shouldn't get accounts: uptime bars
// per deployed workflow, success rate, typical duration, last run. Rendered
// outside the authenticated shell; the token in the URL is the whole
// credential, and everything shown comes from the one public endpoint.

function fmtMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—'
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function fmtAgo(iso) {
  if (!iso) return 'never'
  const mins = Math.round((Date.now() - new Date(iso)) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

// A workflow is "operational" while its latest settled run completed.
function healthOf(wf) {
  if (!wf.lastRunStatus) return { label: 'No runs yet', tone: 'idle' }
  if (wf.lastRunStatus === 'failed') return { label: 'Failing', tone: 'down' }
  if (wf.lastRunStatus === 'completed') return { label: 'Operational', tone: 'up' }
  return { label: wf.lastRunStatus, tone: 'idle' }
}

function WorkflowRow({ wf }) {
  const health = healthOf(wf)
  return (
    <div className="status-page__row">
      <div className="status-page__row-head">
        <span className="status-page__wf-name">{wf.name}</span>
        <span className={`status-page__health status-page__health--${health.tone}`}>
          {health.label}
        </span>
      </div>
      <div className="status-page__bars" aria-label={`Recent runs of ${wf.name}, oldest first`}>
        {wf.runs.length === 0 ? (
          <span className="status-page__no-runs">No runs recorded</span>
        ) : (
          wf.runs.map((run, i) => (
            <span
              key={i}
              className={`status-page__bar status-page__bar--${run.status}`}
              title={`${run.status}${run.durationMs != null ? ` — ${fmtMs(run.durationMs)}` : ''}`}
            />
          ))
        )}
      </div>
      <div className="status-page__stats">
        <span>
          {wf.successRate == null ? 'No settled runs' : `${Math.round(wf.successRate * 100)}% success`}
        </span>
        <span>typical {fmtMs(wf.p50DurationMs)}</span>
        <span>last run {fmtAgo(wf.lastRunAt)}</span>
      </div>
    </div>
  )
}

export default function StatusPage() {
  const { token } = useParams()
  const [page, setPage] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    setPage(null)
    setError(null)
    apiFetch(`/api/status/${token}`)
      .then((data) => {
        if (!cancelled) setPage(data)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [token])

  if (error) {
    return (
      <div className="status-page status-page--message">
        <h1>Status page unavailable</h1>
        <p>This link may have been rotated or taken down by the workspace owner.</p>
      </div>
    )
  }
  if (!page) {
    return (
      <div className="status-page status-page--message">
        <p>Loading…</p>
      </div>
    )
  }

  const failing = page.workflows.filter((w) => w.lastRunStatus === 'failed').length
  const overall =
    page.workflows.length === 0
      ? { label: 'Nothing deployed yet', tone: 'idle' }
      : failing === 0
        ? { label: 'All workflows operational', tone: 'up' }
        : { label: `${failing} workflow${failing === 1 ? '' : 's'} failing`, tone: 'down' }

  return (
    <div className="status-page">
      <header className="status-page__header">
        <h1 className="status-page__title">{page.workspace}</h1>
        <div className={`status-page__overall status-page__overall--${overall.tone}`}>
          {overall.label}
        </div>
      </header>
      {page.workflows.length > 0 && (
        <div className="status-page__list">
          {page.workflows.map((wf) => (
            <WorkflowRow key={wf.name} wf={wf} />
          ))}
        </div>
      )}
      <footer className="status-page__footer">
        Generated {new Date(page.generatedAt).toLocaleString()} · Powered by FlowForge
      </footer>
    </div>
  )
}
