import { useEffect, useState } from 'react'
import { apiFetch } from '../../services/api'
import { useToast } from '../../hooks/useToast'

// Personal access tokens for the public API (/api/v1). The full token value
// exists client-side only in the moment after creation — it is rendered once
// with a copy button and never retrievable again, mirroring the server's
// hash-only storage.

const SCOPE_OPTIONS = [
  { value: 'trigger', label: 'Trigger runs', hint: 'start workflows' },
  { value: 'read', label: 'Read', hint: 'list workflows, poll executions' },
  { value: 'approve', label: 'Approve', hint: 'settle approval gates' },
  { value: 'manage', label: 'Manage', hint: 'import workflow definitions' },
]

const EXPIRY_OPTIONS = [
  { value: '', label: 'No expiry' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
]

function formatDate(iso) {
  if (!iso) return null
  const d = new Date(iso)
  return isNaN(d) ? null : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function tokenStatus(t) {
  if (t.revokedAt) return { label: 'Revoked', className: 'tokens__badge--revoked' }
  if (t.expiresAt && new Date(t.expiresAt) <= new Date()) {
    return { label: 'Expired', className: 'tokens__badge--revoked' }
  }
  return { label: 'Active', className: 'tokens__badge--active' }
}

export default function ApiTokensSection() {
  const toast = useToast()
  const [tokens, setTokens] = useState(null) // null = loading
  const [error, setError] = useState(null)

  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState(['trigger', 'read'])
  const [expiry, setExpiry] = useState('')
  const [busy, setBusy] = useState(false)

  // { value, name } for the just-created token — shown once.
  const [freshToken, setFreshToken] = useState(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    apiFetch('/api/tokens')
      .then(({ tokens: list }) => {
        if (!cancelled) setTokens(list)
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message)
          setTokens([])
        }
      })
    return () => { cancelled = true }
  }, [])

  function toggleScope(scope) {
    setScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]
    )
  }

  async function handleCreate(e) {
    e.preventDefault()
    setBusy(true)
    try {
      const body = { name: name.trim(), scopes }
      if (expiry) body.expiresInDays = Number(expiry)
      const { token, apiToken } = await apiFetch('/api/tokens', { method: 'POST', body })
      setTokens((prev) => [apiToken, ...(prev || [])])
      setFreshToken({ value: token, name: apiToken.name })
      setCopied(false)
      setCreating(false)
      setName('')
      setScopes(['trigger', 'read'])
      setExpiry('')
    } catch (err) {
      toast.error(`Couldn’t create token: ${err.message}`)
    } finally {
      setBusy(false)
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(freshToken.value)
      setCopied(true)
    } catch {
      toast.error('Couldn’t copy — select the token text and copy it manually.')
    }
  }

  async function handleRevoke(t) {
    if (!window.confirm(`Revoke token "${t.name}"? Anything using it will stop working immediately.`)) return
    try {
      await apiFetch(`/api/tokens/${t.id}`, { method: 'DELETE' })
      setTokens((prev) =>
        prev.map((x) => (x.id === t.id ? { ...x, revokedAt: new Date().toISOString() } : x))
      )
      toast.success('Token revoked.')
    } catch (err) {
      toast.error(`Couldn’t revoke token: ${err.message}`)
    }
  }

  return (
    <section className="settings__section">
      <h2 className="settings__section-title">API tokens</h2>

      <div className="settings__row">
        <div className="settings__row-main">
          <p className="settings__row-desc">
            Personal access tokens authenticate the public REST API — trigger
            workflows from CI or scripts with <code>POST /api/v1/workflows/:id/trigger</code>.
            A token’s value is shown only once, at creation.
          </p>
        </div>
      </div>

      {error && <p className="settings__error">{error}</p>}

      {freshToken && (
        <div className="tokens__reveal" role="status">
          <p className="tokens__reveal-title">
            Token “{freshToken.name}” created — copy it now, it won’t be shown again.
          </p>
          <div className="tokens__reveal-row">
            <code className="tokens__reveal-value">{freshToken.value}</code>
            <button className="settings__btn" onClick={handleCopy}>
              {copied ? '✓ Copied' : 'Copy'}
            </button>
            <button className="settings__btn" onClick={() => setFreshToken(null)}>
              Done
            </button>
          </div>
        </div>
      )}

      <div className="settings__panel">
        {!creating ? (
          <button
            className="settings__btn settings__btn--primary"
            onClick={() => setCreating(true)}
          >
            New token
          </button>
        ) : (
          <form className="settings__form" onSubmit={handleCreate}>
            <label className="settings__label">
              Name
              <input
                className="settings__input"
                value={name}
                placeholder="e.g. deploy pipeline"
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
                autoFocus
              />
            </label>
            <fieldset className="tokens__scopes">
              <legend className="tokens__scopes-legend">Scopes</legend>
              {SCOPE_OPTIONS.map((opt) => (
                <label key={opt.value} className="tokens__scope">
                  <input
                    type="checkbox"
                    checked={scopes.includes(opt.value)}
                    onChange={() => toggleScope(opt.value)}
                  />
                  <span className="tokens__scope-label">{opt.label}</span>
                  <span className="tokens__scope-hint">{opt.hint}</span>
                </label>
              ))}
            </fieldset>
            <label className="settings__label">
              Expires
              <select
                className="settings__input"
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
              >
                {EXPIRY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </label>
            <div className="settings__btn-row">
              <button
                type="button"
                className="settings__btn"
                onClick={() => setCreating(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="settings__btn settings__btn--primary"
                disabled={busy || !name.trim() || scopes.length === 0}
              >
                {busy ? 'Creating…' : 'Create token'}
              </button>
            </div>
          </form>
        )}

        {tokens === null ? (
          <p className="settings__muted">Loading…</p>
        ) : tokens.length === 0 ? (
          <p className="settings__muted">No tokens yet.</p>
        ) : (
          <ul className="tokens__list">
            {tokens.map((t) => {
              const status = tokenStatus(t)
              return (
                <li key={t.id} className="tokens__item">
                  <div className="tokens__item-main">
                    <span className="tokens__name">{t.name}</span>
                    <code className="tokens__prefix">{t.tokenPrefix}…</code>
                    <span className={`tokens__badge ${status.className}`}>{status.label}</span>
                  </div>
                  <div className="tokens__item-meta">
                    <span>scopes: {t.scopes.join(', ') || 'none'}</span>
                    {t.lastUsedAt
                      ? <span>last used {formatDate(t.lastUsedAt)}</span>
                      : <span>never used</span>}
                    {t.expiresAt && !t.revokedAt && <span>expires {formatDate(t.expiresAt)}</span>}
                  </div>
                  {!t.revokedAt && (
                    <button
                      className="settings__btn settings__btn--danger tokens__revoke"
                      onClick={() => handleRevoke(t)}
                    >
                      Revoke
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}
