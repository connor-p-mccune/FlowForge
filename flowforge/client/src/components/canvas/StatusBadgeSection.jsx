import { useState } from 'react'
import { apiFetch } from '../../services/api'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001'

// Status badge controls, embedded in the run-settings panel. A workflow can
// mint a public badge token; the SVG at /api/workflows/:id/badge.svg?token=…
// then shows its latest run status (passing/failing/…) for embedding in a
// README or dashboard, exactly like a CI badge. Minting/rotating/removing all
// go through /api/workflows/:id/badge-token.
export default function StatusBadgeSection({ workflowId, initialToken }) {
  const [badgeToken, setBadgeToken] = useState(initialToken || null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState(null)

  const badgeUrl = badgeToken
    ? `${API_BASE}/api/workflows/${workflowId}/badge.svg?token=${badgeToken}`
    : null
  const markdown = badgeUrl ? `![workflow status](${badgeUrl})` : ''

  async function mint() {
    setBusy(true)
    setError(null)
    try {
      const { badgeToken: token } = await apiFetch(`/api/workflows/${workflowId}/badge-token`, {
        method: 'POST',
      })
      setBadgeToken(token)
      setCopied(false)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    setError(null)
    try {
      await apiFetch(`/api/workflows/${workflowId}/badge-token`, { method: 'DELETE' })
      setBadgeToken(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function copyMarkdown() {
    try {
      await navigator.clipboard.writeText(markdown)
      setCopied(true)
    } catch {
      setError('Could not copy to clipboard')
    }
  }

  return (
    <div className="badge-section">
      <span className="run-settings__label">Status badge</span>
      <p className="webhook-panel__hint">
        A public SVG of this workflow’s latest run status, for a README or
        dashboard. Anyone with the badge URL can see the status — rotate or
        remove it to revoke.
      </p>
      {error && <p className="webhook-panel__error">{error}</p>}
      {!badgeToken ? (
        <button
          type="button"
          className="webhook-panel__create"
          onClick={mint}
          disabled={busy}
        >
          {busy ? 'Generating…' : 'Generate badge'}
        </button>
      ) : (
        <>
          <img className="badge-section__preview" src={badgeUrl} alt="Workflow status badge" />
          <code className="badge-section__markdown">{markdown}</code>
          <div className="badge-section__actions">
            <button type="button" className="badge-section__btn" onClick={copyMarkdown}>
              {copied ? 'Copied!' : 'Copy Markdown'}
            </button>
            <button type="button" className="badge-section__btn" onClick={mint} disabled={busy}>
              Rotate
            </button>
            <button
              type="button"
              className="badge-section__btn badge-section__btn--danger"
              onClick={remove}
              disabled={busy}
            >
              Remove
            </button>
          </div>
        </>
      )}
    </div>
  )
}
