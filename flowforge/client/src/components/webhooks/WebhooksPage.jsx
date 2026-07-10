import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../../services/api'
import { useToast } from '../../hooks/useToast'
import { SkeletonRows } from '../Skeleton'

// Outbound webhooks manager. A subscription points an external URL at this
// workspace's activity events ('execution.failed', 'workflow.*', '*'); the
// server queues deliveries durably, signs each one, and retries with backoff.
// The signing secret is shown exactly once, at creation — like API tokens.
// Reuses the secrets-page styling: same shell, same list anatomy.

function formatDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return isNaN(d)
    ? ''
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// "execution.*, workflow.deployed" -> ['execution.*', 'workflow.deployed']
function parseEvents(raw) {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export default function WebhooksPage({ workspaceId }) {
  const toast = useToast()
  const [subscriptions, setSubscriptions] = useState(null) // null = loading
  const [error, setError] = useState(null)

  // Add form
  const [url, setUrl] = useState('')
  const [events, setEvents] = useState('execution.*')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  // The one-time secret reveal after a create: { id, secret }
  const [newSecret, setNewSecret] = useState(null)

  // Delivery log: which subscription is expanded, and its rows
  const [expandedId, setExpandedId] = useState(null)
  const [deliveries, setDeliveries] = useState(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const { subscriptions: list } = await apiFetch(`/api/workspaces/${workspaceId}/subscriptions`)
      setSubscriptions(list)
    } catch (err) {
      setError(err.message)
      setSubscriptions([])
    }
  }, [workspaceId])

  useEffect(() => {
    setSubscriptions(null)
    setExpandedId(null)
    setNewSecret(null)
    load()
  }, [load])

  async function handleAdd(e) {
    e.preventDefault()
    setSaving(true)
    try {
      const { subscription } = await apiFetch(`/api/workspaces/${workspaceId}/subscriptions`, {
        method: 'POST',
        body: { url, events: parseEvents(events), description: description || undefined },
      })
      const { secret, ...listed } = subscription
      setSubscriptions((prev) => [{ ...listed, deliveredCount: 0, failedCount: 0 }, ...(prev || [])])
      setNewSecret({ id: subscription.id, secret })
      setUrl('')
      setDescription('')
      toast.success('Webhook added — copy the signing secret now.')
    } catch (err) {
      toast.error(`Couldn’t add webhook: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  async function handleToggle(sub) {
    try {
      const { subscription } = await apiFetch(
        `/api/workspaces/${workspaceId}/subscriptions/${sub.id}`,
        { method: 'PATCH', body: { isActive: !sub.isActive } }
      )
      setSubscriptions((prev) => prev.map((s) => (s.id === sub.id ? { ...s, ...subscription } : s)))
    } catch (err) {
      toast.error(`Couldn’t update webhook: ${err.message}`)
    }
  }

  async function handleDelete(sub) {
    if (!window.confirm(`Delete the webhook for ${sub.url}? Its delivery history goes with it.`)) return
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/subscriptions/${sub.id}`, { method: 'DELETE' })
      setSubscriptions((prev) => prev.filter((s) => s.id !== sub.id))
      if (expandedId === sub.id) setExpandedId(null)
      toast.success('Webhook deleted.')
    } catch (err) {
      toast.error(`Couldn’t delete webhook: ${err.message}`)
    }
  }

  async function handleTest(sub) {
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/subscriptions/${sub.id}/test`, { method: 'POST' })
      toast.success('Test delivery sent — the endpoint answered 2xx.')
    } catch (err) {
      toast.error(`Test delivery failed: ${err.message}`)
    }
    if (expandedId === sub.id) loadDeliveries(sub.id)
  }

  async function loadDeliveries(subId) {
    setDeliveries(null)
    try {
      const { deliveries: rows } = await apiFetch(
        `/api/workspaces/${workspaceId}/subscriptions/${subId}/deliveries`
      )
      setDeliveries(rows)
    } catch (err) {
      toast.error(`Couldn’t load deliveries: ${err.message}`)
      setDeliveries([])
    }
  }

  function toggleDeliveries(subId) {
    if (expandedId === subId) {
      setExpandedId(null)
      return
    }
    setExpandedId(subId)
    loadDeliveries(subId)
  }

  async function handleRedeliver(subId, deliveryId) {
    try {
      const { delivery } = await apiFetch(
        `/api/workspaces/${workspaceId}/subscriptions/${subId}/deliveries/${deliveryId}/redeliver`,
        { method: 'POST' }
      )
      setDeliveries((prev) => prev.map((d) => (d.id === deliveryId ? delivery : d)))
      toast.success(delivery.status === 'delivered' ? 'Redelivered.' : 'Attempted — still failing.')
    } catch (err) {
      toast.error(`Couldn’t redeliver: ${err.message}`)
    }
  }

  return (
    <div className="secrets-page">
      <div className="secrets-page__header">
        <h1 className="secrets-page__title">Outbound webhooks</h1>
        <p className="secrets-page__subtitle">
          POST this workspace’s events to your own systems — <code>execution.failed</code>,{' '}
          <code>workflow.*</code>, or <code>*</code> for everything. Deliveries are signed
          (HMAC-SHA256, same scheme as inbound triggers), retried with backoff, and logged
          here so you can see exactly what your endpoint received.
        </p>
      </div>

      {error && <p className="secrets-page__error">{error}</p>}

      <form className="secrets-page__add" onSubmit={handleAdd}>
        <div className="secrets-page__add-fields">
          <label className="secrets-page__field secrets-page__field--grow">
            <span>Endpoint URL</span>
            <input
              value={url}
              placeholder="https://ci.example.com/hooks/flowforge"
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <label className="secrets-page__field">
            <span>Events (comma-separated)</span>
            <input
              value={events}
              placeholder="execution.*, workflow.deployed"
              onChange={(e) => setEvents(e.target.value)}
            />
          </label>
          <label className="secrets-page__field">
            <span>Description (optional)</span>
            <input
              value={description}
              placeholder="Alerts channel"
              onChange={(e) => setDescription(e.target.value)}
              maxLength={200}
            />
          </label>
          <button
            className="secrets-page__btn secrets-page__btn--primary"
            type="submit"
            disabled={saving || !url.trim() || parseEvents(events).length === 0}
          >
            {saving ? 'Adding…' : 'Add webhook'}
          </button>
        </div>
      </form>

      {newSecret && (
        <div className="webhook-secret-reveal">
          <p>
            Signing secret — shown once. Verify deliveries with it, then store it like any
            other credential:
          </p>
          <div className="webhook-secret-reveal__row">
            <code>{newSecret.secret}</code>
            <button
              className="secrets-page__btn"
              onClick={() => {
                navigator.clipboard?.writeText(newSecret.secret)
                toast.success('Secret copied.')
              }}
            >
              Copy
            </button>
            <button className="secrets-page__btn" onClick={() => setNewSecret(null)}>
              Done
            </button>
          </div>
        </div>
      )}

      {subscriptions === null ? (
        <SkeletonRows count={3} height={44} />
      ) : subscriptions.length === 0 ? (
        <div className="secrets-page__empty">
          <p>No outbound webhooks yet.</p>
          <p className="secrets-page__hint">
            Add one above to get notified when runs finish, fail, or a workflow is deployed —
            see <code>docs/API.md</code> for the payload format and signature verification.
          </p>
        </div>
      ) : (
        <ul className="secrets-page__list">
          {subscriptions.map((sub) => (
            <li key={sub.id} className="secrets-page__item">
              <div className="secrets-page__item-row">
                <div className="secrets-page__item-main">
                  <code className="secrets-page__name">{sub.url}</code>
                  <span className={`webhook-status webhook-status--${sub.isActive ? 'active' : 'paused'}`}>
                    {sub.isActive ? 'active' : 'paused'}
                  </span>
                  {sub.events.map((ev) => (
                    <span key={ev} className="webhook-event-chip">{ev}</span>
                  ))}
                </div>
                <div className="secrets-page__item-meta">
                  {sub.description && <span>{sub.description}</span>}
                  <span>{sub.deliveredCount} delivered</span>
                  {sub.failedCount > 0 && (
                    <span className="webhook-failed-count">{sub.failedCount} failed</span>
                  )}
                </div>
                <div className="secrets-page__item-actions">
                  <button className="secrets-page__btn" onClick={() => toggleDeliveries(sub.id)}>
                    {expandedId === sub.id ? 'Hide deliveries' : 'Deliveries'}
                  </button>
                  <button className="secrets-page__btn" onClick={() => handleTest(sub)}>
                    Send test
                  </button>
                  <button className="secrets-page__btn" onClick={() => handleToggle(sub)}>
                    {sub.isActive ? 'Pause' : 'Resume'}
                  </button>
                  <button
                    className="secrets-page__btn secrets-page__btn--danger"
                    onClick={() => handleDelete(sub)}
                  >
                    Delete
                  </button>
                </div>
              </div>
              {expandedId === sub.id && (
                <div className="webhook-deliveries">
                  {deliveries === null ? (
                    <SkeletonRows count={2} height={28} />
                  ) : deliveries.length === 0 ? (
                    <p className="secrets-page__hint">
                      No deliveries yet — “Send test” fires one right now.
                    </p>
                  ) : (
                    <table className="webhook-deliveries__table">
                      <thead>
                        <tr>
                          <th>Event</th>
                          <th>Status</th>
                          <th>Attempts</th>
                          <th>Result</th>
                          <th>When</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {deliveries.map((d) => (
                          <tr key={d.id}>
                            <td><code>{d.event_type}</code></td>
                            <td>
                              <span className={`status-badge status-badge--${d.status === 'delivered' ? 'succeeded' : d.status === 'failed' ? 'failed' : 'running'}`}>
                                {d.status}
                              </span>
                            </td>
                            <td>{d.attempts}</td>
                            <td>{d.response_status || d.error || '—'}</td>
                            <td>{formatDate(d.created_at)}</td>
                            <td>
                              {d.status !== 'delivered' && (
                                <button
                                  className="secrets-page__btn"
                                  onClick={() => handleRedeliver(sub.id, d.id)}
                                >
                                  Redeliver
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
