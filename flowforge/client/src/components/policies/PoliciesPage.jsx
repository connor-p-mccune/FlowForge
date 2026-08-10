import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../../services/api'
import { useToast } from '../../hooks/useToast'
import { SkeletonRows } from '../Skeleton'
import PolicyEditor from './PolicyEditor'

// Workspace policies — the rules a workflow must satisfy before it may go live.
//
// Sibling of Secrets and Variables (and it reuses their styles), with one
// deliberate difference in the interaction: a policy is *tested before it is
// saved*. The editor evaluates a draft rule against a real workflow's document,
// so an owner sees what it would block before anyone's deploy depends on it —
// the same argument as the expression playground and the lint route accepting
// an unsaved graph. Writing a governance rule blind is how a workspace ends up
// unable to ship.

function formatDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function PoliciesPage({ workspaceId }) {
  const toast = useToast()
  const [policies, setPolicies] = useState(null) // null = loading
  const [templates, setTemplates] = useState([])
  const [error, setError] = useState(null)
  const [editing, setEditing] = useState(null) // a policy, a template draft, or null
  const [showTemplates, setShowTemplates] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      const [{ policies: list }, { templates: catalogue }] = await Promise.all([
        apiFetch(`/api/workspaces/${workspaceId}/policies`),
        apiFetch('/api/policy-templates'),
      ])
      setPolicies(list)
      setTemplates(catalogue)
    } catch (err) {
      setError(err.message)
      setPolicies([])
    }
  }, [workspaceId])

  useEffect(() => {
    setPolicies(null)
    load()
  }, [load])

  async function handleToggle(policy) {
    try {
      const { policy: updated } = await apiFetch(
        `/api/workspaces/${workspaceId}/policies/${policy.id}`,
        { method: 'PUT', body: { enabled: !policy.enabled } }
      )
      setPolicies((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))
      toast.success(`${updated.name} ${updated.enabled ? 'enabled' : 'disabled'}.`)
    } catch (err) {
      toast.error(`Couldn’t update policy: ${err.message}`)
    }
  }

  async function handleDelete(policy) {
    if (!window.confirm(`Delete the policy “${policy.name}”? Deploys will stop being checked against it.`)) {
      return
    }
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/policies/${policy.id}`, { method: 'DELETE' })
      setPolicies((prev) => prev.filter((p) => p.id !== policy.id))
      toast.success(`${policy.name} deleted.`)
    } catch (err) {
      toast.error(`Couldn’t delete policy: ${err.message}`)
    }
  }

  function handleSaved(saved) {
    setPolicies((prev) => {
      const exists = prev.some((p) => p.id === saved.id)
      return exists ? prev.map((p) => (p.id === saved.id ? saved : p)) : [...prev, saved]
    })
    setEditing(null)
    toast.success(`${saved.name} saved.`)
  }

  const denyCount = (policies || []).filter((p) => p.enabled && p.severity === 'deny').length

  return (
    <div className="secrets-page">
      <div className="secrets-page__header">
        <h1 className="secrets-page__title">Policies</h1>
        <p className="secrets-page__subtitle">
          Rules a workflow must satisfy before it can be deployed. The linter asks
          “will this run?”; a policy asks <strong>“is this allowed here?”</strong> — an
          unapproved outbound host, an unsigned webhook trigger, an API key typed into a
          config instead of stored as a secret. Each rule is an{' '}
          <a href="https://github.com/connor-p-mccune/FlowForge/blob/main/flowforge/docs/EXPRESSIONS.md">
            FXL expression
          </a>{' '}
          that must hold; a <strong>deny</strong> refuses the deploy, a{' '}
          <strong>warn</strong> records the finding and lets it through. Both show up in
          the canvas’s Issues panel while editing.
        </p>
      </div>

      {error && <p className="secrets-page__error">{error}</p>}

      <div className="policy-page__actions">
        <button
          className="secrets-page__btn secrets-page__btn--primary"
          onClick={() => setEditing({ severity: 'deny', enabled: true })}
        >
          New policy
        </button>
        <button className="secrets-page__btn" onClick={() => setShowTemplates((v) => !v)}>
          {showTemplates ? 'Hide starter policies' : 'Start from a template'}
        </button>
        {policies !== null && (
          <span className="policy-page__count">
            {denyCount === 0
              ? 'Nothing is currently blocking a deploy.'
              : `${denyCount} rule${denyCount === 1 ? '' : 's'} can block a deploy.`}
          </span>
        )}
      </div>

      {showTemplates && (
        <ul className="policy-templates">
          {templates.map((template) => (
            <li key={template.key} className="policy-templates__item">
              <div>
                <span className="policy-templates__name">{template.name}</span>
                <p className="policy-templates__description">{template.description}</p>
                <code className="policy-templates__rule">{template.rule}</code>
              </div>
              <button
                className="secrets-page__btn"
                onClick={() => {
                  // Templates are copied in, not referenced: a rule nobody can
                  // edit is a rule nobody trusts, and every workspace's
                  // allow-list is its own.
                  setEditing({ ...template, id: undefined })
                  setShowTemplates(false)
                }}
              >
                Use
              </button>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <PolicyEditor
          workspaceId={workspaceId}
          policy={editing}
          onSaved={handleSaved}
          onCancel={() => setEditing(null)}
        />
      )}

      {policies === null ? (
        <SkeletonRows count={3} height={56} />
      ) : policies.length === 0 ? (
        <div className="secrets-page__empty">
          <p>No policies yet.</p>
          <p className="secrets-page__hint">
            Nothing is being enforced. Start from a template above — “Credentials must come
            from secrets” and “Outbound calls must use HTTPS” are the two most workspaces
            want first.
          </p>
        </div>
      ) : (
        <ul className="secrets-page__list">
          {policies.map((policy) => (
            <li key={policy.id} className="secrets-page__item">
              <div className="secrets-page__item-row">
                <div className="secrets-page__item-main">
                  <span className="policy-item__head">
                    <span
                      className={`policy-badge policy-badge--${policy.severity}${
                        policy.enabled ? '' : ' policy-badge--off'
                      }`}
                    >
                      {policy.enabled ? policy.severity : 'off'}
                    </span>
                    <strong>{policy.name}</strong>
                  </span>
                  {policy.description && (
                    <p className="policy-item__description">{policy.description}</p>
                  )}
                  <code className="secrets-page__value">{policy.rule}</code>
                </div>
                <div className="secrets-page__item-meta">
                  <span>updated {formatDate(policy.updatedAt)}</span>
                </div>
                <div className="secrets-page__item-actions">
                  <button className="secrets-page__btn" onClick={() => setEditing(policy)}>
                    Edit
                  </button>
                  <button className="secrets-page__btn" onClick={() => handleToggle(policy)}>
                    {policy.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    className="secrets-page__btn secrets-page__btn--danger"
                    onClick={() => handleDelete(policy)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
