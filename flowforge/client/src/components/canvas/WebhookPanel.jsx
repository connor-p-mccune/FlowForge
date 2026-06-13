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
    try {
      const { webhook } = await apiFetch(`/api/workflows/${workflowId}/webhooks`, {
        method: 'POST',
        body: { name: `Webhook ${webhooks.length + 1}` },
      })
      setWebhooks((prev) => [webhook, ...prev])
    } catch (err) {
      setError(err.message)
    } finally {
      setCreating(false)
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
        <button className="webhook-panel__create" onClick={handleCreate} disabled={creating}>
          {creating ? 'Creating…' : '+ New webhook URL'}
        </button>
        {error && <p className="webhook-panel__error">{error}</p>}
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
