import { useEffect, useState } from 'react'
import { apiFetch } from '../../services/api'
import { useToast } from '../../hooks/useToast'

// "Share a public status page" card on the workspace analytics page: mint or
// rotate the token, copy the public URL, or take the page down. Management
// is owner-only on the server; the controls render for every member and a
// non-owner simply gets the server's refusal as a toast — honest, and no
// second role model to maintain client-side.

export default function StatusPageSection({ workspaceId }) {
  const [token, setToken] = useState(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    apiFetch(`/api/workspaces/${workspaceId}/status-page`)
      .then(({ token: current }) => {
        if (cancelled) return
        setToken(current)
        setLoaded(true)
      })
      .catch(() => {
        /* the card is a nicety — analytics still renders without it */
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  if (!loaded) return null

  const publicUrl = token ? `${window.location.origin}/status/${token}` : null

  async function mint() {
    setBusy(true)
    try {
      const { token: fresh } = await apiFetch(`/api/workspaces/${workspaceId}/status-page`, {
        method: 'POST',
      })
      setToken(fresh)
      toast.success(token ? 'Status page link rotated — old links no longer work' : 'Status page published')
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function disable() {
    setBusy(true)
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/status-page`, { method: 'DELETE' })
      setToken(null)
      toast.success('Status page taken down')
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(publicUrl)
      toast.success('Status page URL copied')
    } catch {
      toast.error('Couldn’t copy — select the URL manually')
    }
  }

  return (
    <section className="status-share">
      <h2 className="status-share__title">Public status page</h2>
      <p className="status-share__hint">
        Share a read-only health page of this workspace’s deployed workflows —
        uptime bars, success rates, typical durations — with people who don’t
        have accounts. No ids, errors, or payloads are exposed, and rotating
        the link severs every previously shared copy.
      </p>
      {token ? (
        <>
          <div className="status-share__url-row">
            <code className="status-share__url" data-testid="status-page-url">{publicUrl}</code>
            <button className="status-share__btn" onClick={copyUrl}>Copy</button>
          </div>
          <div className="status-share__actions">
            <a className="status-share__btn" href={publicUrl} target="_blank" rel="noreferrer">
              Open
            </a>
            <button className="status-share__btn" onClick={mint} disabled={busy}>
              Rotate link
            </button>
            <button className="status-share__btn status-share__btn--danger" onClick={disable} disabled={busy}>
              Take down
            </button>
          </div>
        </>
      ) : (
        <button className="status-share__btn status-share__btn--primary" onClick={mint} disabled={busy}>
          {busy ? 'Publishing…' : 'Publish status page'}
        </button>
      )}
    </section>
  )
}
