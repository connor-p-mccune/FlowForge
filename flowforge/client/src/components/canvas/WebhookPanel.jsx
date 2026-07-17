import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../../services/api'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001'

function triggerUrl(key) {
  return `${API_BASE}/api/webhooks/${key}`
}

export default function WebhookPanel({ workflowId, open, onClose }) {
  const [webhooks, setWebhooks] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [creating, setCreating] = useState(false)
  const [copiedId, setCopiedId] = useState(null)
  // HMAC signing: whether the next webhook is created signed, and the one-time
  // secret display ({ webhookId, secret }) — the server never returns it again.
  const [signNew, setSignNew] = useState(false)
  const [newSecret, setNewSecret] = useState(null)
  const [secretCopied, setSecretCopied] = useState(false)
  // Gate expression for the next webhook, and the per-row inline editor
  // ({ id, value }) for existing ones.
  const [filterNew, setFilterNew] = useState('')
  const [filterEdit, setFilterEdit] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { webhooks: list } = await apiFetch(`/api/workflows/${workflowId}/webhooks`)
      setWebhooks(list)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [workflowId])

  useEffect(() => {
    if (open) load()
  }, [open, load])

  async function handleCreate() {
    setCreating(true)
    setError(null)
    setNewSecret(null)
    setSecretCopied(false)
    try {
      const { webhook, signingSecret } = await apiFetch(`/api/workflows/${workflowId}/webhooks`, {
        method: 'POST',
        body: {
          name: `Webhook ${webhooks.length + 1}`,
          signed: signNew,
          ...(filterNew.trim() ? { filterExpression: filterNew } : {}),
        },
      })
      setWebhooks((prev) => [webhook, ...prev])
      setFilterNew('')
      if (signingSecret) setNewSecret({ webhookId: webhook.id, secret: signingSecret })
    } catch (err) {
      setError(err.message)
    } finally {
      setCreating(false)
    }
  }

  async function handleCopySecret() {
    if (!newSecret) return
    try {
      await navigator.clipboard.writeText(newSecret.secret)
      setSecretCopied(true)
    } catch {
      setError('Could not copy to clipboard')
    }
  }

  async function handleDelete(id) {
    setError(null)
    try {
      await apiFetch(`/api/webhooks/${id}`, { method: 'DELETE' })
      setWebhooks((prev) => prev.filter((w) => w.id !== id))
    } catch (err) {
      setError(err.message)
    }
  }

  // Save (or clear, with an empty value) a row's gate expression. A dedicated
  // PUT — editing the filter must not rotate the URL senders hold.
  async function handleSaveFilter() {
    if (!filterEdit) return
    setError(null)
    try {
      const { webhook } = await apiFetch(`/api/webhooks/${filterEdit.id}`, {
        method: 'PUT',
        body: { filterExpression: filterEdit.value.trim() || null },
      })
      setWebhooks((prev) => prev.map((w) => (w.id === webhook.id ? webhook : w)))
      setFilterEdit(null)
    } catch (err) {
      setError(err.message)
    }
  }

  async function handleCopy(webhook) {
    try {
      await navigator.clipboard.writeText(triggerUrl(webhook.webhook_key))
      setCopiedId(webhook.id)
      setTimeout(() => setCopiedId((c) => (c === webhook.id ? null : c)), 1500)
    } catch {
      setError('Could not copy to clipboard')
    }
  }

  if (!open) return null

  return (
    <aside className="webhook-panel">
      <div className="webhook-panel__header">
        <span className="webhook-panel__title">Webhook triggers</span>
        <button className="webhook-panel__close" title="Close" onClick={onClose}>×</button>
      </div>
      <div className="webhook-panel__body">
        <p className="webhook-panel__hint">
          Anyone with a URL below can POST JSON to start this workflow. The request
          body flows into your webhook trigger node.
        </p>
        <label className="webhook-panel__sign-toggle">
          <input
            type="checkbox"
            checked={signNew}
            onChange={(e) => setSignNew(e.target.checked)}
          />
          <span>
            Require signed deliveries — callers must send a timestamped
            HMAC-SHA256 signature
          </span>
        </label>
        <label className="webhook-panel__filter-field">
          <span>Only fire when (optional)</span>
          <input
            value={filterNew}
            placeholder={'event == "push" && ref == "main"'}
            onChange={(e) => setFilterNew(e.target.value)}
          />
        </label>
        <p className="webhook-panel__hint">
          An FXL rule over the delivery body — non-matching deliveries are
          acknowledged but start no run, so “only fire on pushes to main”
          happens at the door instead of as a condition node.
        </p>
        <button className="webhook-panel__create" onClick={handleCreate} disabled={creating}>
          {creating ? 'Creating…' : '+ New webhook URL'}
        </button>
        {error && <p className="webhook-panel__error">{error}</p>}
        {newSecret && (
          <div className="webhook-secret" role="status">
            <p className="webhook-secret__title">
              Signing secret — copy it now, it won&rsquo;t be shown again:
            </p>
            <code className="webhook-secret__value">{newSecret.secret}</code>
            <button className="webhook-item__copy" onClick={handleCopySecret}>
              {secretCopied ? 'Copied!' : 'Copy secret'}
            </button>
            <p className="webhook-secret__hint">
              Sign each POST with{' '}
              <code>X-FlowForge-Signature: v1=HMAC_SHA256(secret, timestamp + &quot;.&quot; + body)</code>{' '}
              and <code>X-FlowForge-Timestamp</code> (unix seconds).
            </p>
          </div>
        )}
        {loading ? (
          <p className="webhook-panel__hint">Loading…</p>
        ) : webhooks.length === 0 ? (
          <p className="webhook-panel__hint">No webhooks yet.</p>
        ) : (
          <ul className="webhook-list">
            {webhooks.map((w) => (
              <li className="webhook-item" key={w.id}>
                <div className="webhook-item__row">
                  <span className="webhook-item__name">{w.name || 'Webhook'}</span>
                  {w.signed && (
                    <span
                      className="webhook-item__signed"
                      title="Deliveries must carry a valid HMAC signature"
                    >
                      🔏 Signed
                    </span>
                  )}
                  <button
                    className="webhook-item__delete"
                    title="Delete"
                    onClick={() => handleDelete(w.id)}
                  >
                    Delete
                  </button>
                </div>
                <code className="webhook-item__url">{triggerUrl(w.webhook_key)}</code>
                <button className="webhook-item__copy" onClick={() => handleCopy(w)}>
                  {copiedId === w.id ? 'Copied!' : 'Copy URL'}
                </button>
                {filterEdit?.id === w.id ? (
                  <div className="webhook-item__filter-edit">
                    <input
                      value={filterEdit.value}
                      placeholder={'event == "push"'}
                      onChange={(e) => setFilterEdit({ id: w.id, value: e.target.value })}
                      aria-label="Gate expression"
                    />
                    <button className="webhook-item__copy" onClick={handleSaveFilter}>
                      Save
                    </button>
                    <button className="webhook-item__copy" onClick={() => setFilterEdit(null)}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="webhook-item__filter-row">
                    {w.filter_expression ? (
                      <span className="webhook-item__meta" title="Only matching deliveries fire">
                        ⏳ Fires when <code>{w.filter_expression}</code>
                      </span>
                    ) : (
                      <span className="webhook-item__meta">Fires on every delivery</span>
                    )}
                    <button
                      className="webhook-item__copy"
                      onClick={() => setFilterEdit({ id: w.id, value: w.filter_expression || '' })}
                    >
                      Edit filter
                    </button>
                  </div>
                )}
                {w.last_triggered_at && (
                  <span className="webhook-item__meta">
                    Last fired: {new Date(w.last_triggered_at).toLocaleString()}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}
