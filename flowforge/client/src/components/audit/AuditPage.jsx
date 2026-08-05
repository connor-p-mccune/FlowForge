import { useState, useEffect, useCallback } from 'react'
import { apiFetch, apiFetchText } from '../../services/api'
import { SkeletonRows } from '../Skeleton'
import { useToast } from '../../hooks/useToast'
import { ACTION_FILTERS, describeAuditEntry, formatAuditTime } from './format'

const PAGE_SIZE = 50

function auditUrl(workspaceId, action, before) {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) })
  if (action && action !== 'all') params.set('action', action)
  if (before != null) params.set('before', String(before))
  return `/api/workspaces/${workspaceId}/audit?${params.toString()}`
}

// The verification banner. Its job is to make the chain's state the first thing
// a reader sees, because an audit log whose integrity you have to go and check
// separately is one nobody checks. Three states, and the failure state is
// deliberately loud: a broken chain is a security incident, not a warning.
function VerificationBanner({ state, onRecheck, checking }) {
  if (!state) return null
  if (!state.ok) {
    return (
      <div className="audit__verify audit__verify--broken" role="alert">
        <div className="audit__verify-title">⚠ Chain verification failed</div>
        <p className="audit__verify-detail">
          Entry #{state.brokenAt?.seq} — {state.brokenAt?.detail}. This log has been
          modified outside the application. Treat every entry from #{state.brokenAt?.seq}{' '}
          onward as unreliable and investigate database access.
        </p>
      </div>
    )
  }
  return (
    <div className="audit__verify audit__verify--ok">
      <div className="audit__verify-title">
        ✓ Chain verified — {state.entries.toLocaleString()}{' '}
        {state.entries === 1 ? 'entry' : 'entries'}, unbroken
      </div>
      <p className="audit__verify-detail">
        Every entry hashes into the next, so no entry can be edited, removed, or
        reordered without breaking the chain.{' '}
        {/* The head is the value worth copying somewhere outside this system:
            anchoring it externally is what closes the last gap in the guarantee. */}
        <span className="audit__hash" title="The newest hash — anchor this externally to detect a full rewrite">
          head {state.head?.slice(0, 16)}…
        </span>
        <button className="audit__recheck" onClick={onRecheck} disabled={checking}>
          {checking ? 'Checking…' : 'Re-check'}
        </button>
      </p>
    </div>
  )
}

// Workspace audit log — the governance record, distinct from the activity feed.
// Owner-only server-side; a member reaching this page gets the 403 rendered as
// an explanation rather than an error, because being refused here is a correct
// outcome, not a fault.
export default function AuditPage({ workspaceId }) {
  const [action, setAction] = useState('all')
  const [entries, setEntries] = useState([])
  const [hasMore, setHasMore] = useState(false)
  const [verification, setVerification] = useState(null)
  const [checking, setChecking] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(null)
  const [forbidden, setForbidden] = useState(false)
  const toast = useToast()

  const verify = useCallback(
    async ({ announce = false } = {}) => {
      setChecking(true)
      try {
        const result = await apiFetch(`/api/workspaces/${workspaceId}/audit/verify`)
        setVerification(result)
        if (announce) {
          if (result.ok) toast.success(`Chain verified — ${result.entries} entries intact`)
          else toast.error(`Chain broken at entry #${result.brokenAt?.seq}`)
        }
      } catch {
        /* The banner simply stays hidden; the entries below are still useful. */
      } finally {
        setChecking(false)
      }
    },
    [workspaceId, toast]
  )

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      setForbidden(false)
      try {
        const data = await apiFetch(auditUrl(workspaceId, action))
        if (cancelled) return
        setEntries(data.entries)
        setHasMore(data.hasMore)
      } catch (err) {
        if (cancelled) return
        if (/owner/i.test(err.message)) setForbidden(true)
        else setError(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [workspaceId, action])

  useEffect(() => {
    verify()
  }, [verify])

  async function loadMore() {
    if (loadingMore || entries.length === 0) return
    setLoadingMore(true)
    try {
      const before = entries[entries.length - 1].seq
      const data = await apiFetch(auditUrl(workspaceId, action, before))
      setEntries((prev) => {
        const seen = new Set(prev.map((e) => e.id))
        return [...prev, ...data.entries.filter((e) => !seen.has(e.id))]
      })
      setHasMore(data.hasMore)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoadingMore(false)
    }
  }

  // Download the export. Deliberately not a plain <a href>: the endpoint is
  // owner-only and authenticates by header, and the alternative — putting the
  // session token in a URL so the browser can fetch it directly — would leak
  // the credential into history, referrers, and any proxy log on the way.
  // Fetching it here and saving a blob keeps the token in the header where it
  // belongs, at the cost of buffering the file, which for an audit export is a
  // trade worth making.
  async function handleExport(format) {
    try {
      const body = await apiFetchText(
        `/api/workspaces/${workspaceId}/audit/export?format=${format}`
      )
      const blob = new Blob([body], {
        type: format === 'csv' ? 'text/csv' : 'application/json',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `audit-${new Date().toISOString().slice(0, 10)}.${format}`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      toast.error(err.message)
    }
  }

  if (forbidden) {
    return (
      <div className="audit">
        <h1 className="audit__title">Audit log</h1>
        <div className="audit__empty">
          <div className="audit__empty-title">Owners only</div>
          <p className="audit__empty-hint">
            The audit log records who changed credentials and membership, so reading it
            is limited to workspace owners. Ask an owner if you need a copy.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="audit">
      <div className="audit__header">
        <div>
          <h1 className="audit__title">Audit log</h1>
          <p className="audit__subtitle">
            An append-only, hash-chained record of security-relevant changes — separate
            from the activity feed, and verifiable.
          </p>
        </div>
        <div className="audit__actions">
          <button className="audit__export" onClick={() => handleExport('csv')}>
            Export CSV
          </button>
          <button className="audit__export" onClick={() => handleExport('json')}>
            Export JSON
          </button>
        </div>
      </div>

      <VerificationBanner
        state={verification}
        checking={checking}
        onRecheck={() => verify({ announce: true })}
      />

      <div className="audit__filters" role="group" aria-label="Filter audit entries">
        {ACTION_FILTERS.map((f) => (
          <button
            key={f.key}
            className={`audit__filter-btn${action === f.key ? ' audit__filter-btn--active' : ''}`}
            onClick={() => setAction(f.key)}
            disabled={loading}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error ? (
        <div className="audit__error">Unable to load the audit log — {error}</div>
      ) : loading ? (
        <SkeletonRows count={8} height={52} />
      ) : entries.length === 0 ? (
        <div className="audit__empty">
          <div className="audit__empty-title">Nothing recorded yet</div>
          <p className="audit__empty-hint">
            Changes to secrets, variables, membership, API tokens, and what’s deployed
            will appear here.
          </p>
        </div>
      ) : (
        <>
          <table className="audit__table">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">What</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td className="audit__seq">{entry.seq}</td>
                  <td className="audit__when">{formatAuditTime(entry.createdAt)}</td>
                  <td className="audit__who">{entry.actor || 'unknown'}</td>
                  <td className="audit__what">{describeAuditEntry(entry)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {hasMore && (
            <div className="audit__more">
              <button className="audit__more-btn" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
