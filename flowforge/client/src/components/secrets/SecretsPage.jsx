import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../../services/api'
import { useToast } from '../../hooks/useToast'
import { SkeletonRows } from '../Skeleton'

// Workspace secrets manager. Secrets are write-only: the API returns names and
// metadata, never values, so the UI can add, rotate, and delete but never read
// a value back. Node configs reference them as {{secrets.NAME}} and the server
// decrypts just-in-time at run start, redacting values from run logs.

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

function formatDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function SecretsPage({ workspaceId }) {
  const toast = useToast()
  const [secrets, setSecrets] = useState(null) // null = loading
  const [error, setError] = useState(null)

  // Add form
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)

  // Rotation: which secret's replace-value form is open
  const [rotatingName, setRotatingName] = useState(null)
  const [rotateValue, setRotateValue] = useState('')
  const [rotateBusy, setRotateBusy] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      const { secrets: list } = await apiFetch(`/api/workspaces/${workspaceId}/secrets`)
      setSecrets(list)
    } catch (err) {
      setError(err.message)
      setSecrets([])
    }
  }, [workspaceId])

  useEffect(() => {
    setSecrets(null)
    load()
  }, [load])

  const nameValid = NAME_PATTERN.test(name)
  const nameTaken = (secrets || []).some((s) => s.name === name)

  async function handleAdd(e) {
    e.preventDefault()
    setSaving(true)
    try {
      const { secret } = await apiFetch(`/api/workspaces/${workspaceId}/secrets/${name}`, {
        method: 'PUT',
        body: { value },
      })
      setSecrets((prev) => [...(prev || []), secret].sort((a, b) => a.name.localeCompare(b.name)))
      toast.success(`Secret ${secret.name} saved.`)
      setName('')
      setValue('')
    } catch (err) {
      toast.error(`Couldn’t save secret: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  async function handleRotate(e) {
    e.preventDefault()
    setRotateBusy(true)
    try {
      const { secret } = await apiFetch(`/api/workspaces/${workspaceId}/secrets/${rotatingName}`, {
        method: 'PUT',
        body: { value: rotateValue },
      })
      setSecrets((prev) => prev.map((s) => (s.name === secret.name ? secret : s)))
      toast.success(`Secret ${secret.name} updated.`)
      setRotatingName(null)
      setRotateValue('')
    } catch (err) {
      toast.error(`Couldn’t update secret: ${err.message}`)
    } finally {
      setRotateBusy(false)
    }
  }

  async function handleDelete(secretName) {
    if (!window.confirm(`Delete secret ${secretName}? Workflows referencing {{secrets.${secretName}}} will resolve it as empty.`)) {
      return
    }
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/secrets/${secretName}`, { method: 'DELETE' })
      setSecrets((prev) => prev.filter((s) => s.name !== secretName))
      toast.success(`Secret ${secretName} deleted.`)
    } catch (err) {
      toast.error(`Couldn’t delete secret: ${err.message}`)
    }
  }

  return (
    <div className="secrets-page">
      <div className="secrets-page__header">
        <h1 className="secrets-page__title">Secrets</h1>
        <p className="secrets-page__subtitle">
          Store API keys and tokens once, encrypted at rest, and reference them from any
          node in this workspace as <code>{'{{secrets.NAME}}'}</code>. Values are
          write-only — they can be rotated or deleted, but never viewed again, and they
          are masked in run logs.
        </p>
      </div>

      {error && <p className="secrets-page__error">{error}</p>}

      <form className="secrets-page__add" onSubmit={handleAdd}>
        <div className="secrets-page__add-fields">
          <label className="secrets-page__field">
            <span>Name</span>
            <input
              value={name}
              placeholder="STRIPE_API_KEY"
              onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
              maxLength={64}
            />
          </label>
          <label className="secrets-page__field secrets-page__field--grow">
            <span>Value</span>
            <input
              type="password"
              value={value}
              placeholder="sk_live_…"
              onChange={(e) => setValue(e.target.value)}
              autoComplete="off"
              maxLength={4096}
            />
          </label>
          <button
            className="secrets-page__btn secrets-page__btn--primary"
            type="submit"
            disabled={saving || !nameValid || nameTaken || !value.trim()}
          >
            {saving ? 'Saving…' : 'Add secret'}
          </button>
        </div>
        {name && !nameValid && (
          <p className="secrets-page__hint secrets-page__hint--warn">
            Names start with a letter and use only letters, numbers, and underscores.
          </p>
        )}
        {nameTaken && (
          <p className="secrets-page__hint secrets-page__hint--warn">
            {name} already exists — use “Replace value” below to rotate it.
          </p>
        )}
      </form>

      {secrets === null ? (
        <SkeletonRows count={3} height={44} />
      ) : secrets.length === 0 ? (
        <div className="secrets-page__empty">
          <p>No secrets yet.</p>
          <p className="secrets-page__hint">
            Add one above, then use it in a node — for example an HTTP header of{' '}
            <code>{'{"Authorization": "Bearer {{secrets.API_KEY}}"}'}</code>.
          </p>
        </div>
      ) : (
        <ul className="secrets-page__list">
          {secrets.map((s) => (
            <li key={s.name} className="secrets-page__item">
              <div className="secrets-page__item-row">
                <div className="secrets-page__item-main">
                  <code className="secrets-page__name">{s.name}</code>
                  <span className="secrets-page__value" aria-hidden="true">••••••••</span>
                </div>
                <div className="secrets-page__item-meta">
                  {s.created_by_name && <span>added by {s.created_by_name}</span>}
                  <span>updated {formatDate(s.updated_at)}</span>
                </div>
                <div className="secrets-page__item-actions">
                  <button
                    className="secrets-page__btn"
                    onClick={() => {
                      setRotatingName((cur) => (cur === s.name ? null : s.name))
                      setRotateValue('')
                    }}
                  >
                    Replace value
                  </button>
                  <button
                    className="secrets-page__btn secrets-page__btn--danger"
                    onClick={() => handleDelete(s.name)}
                  >
                    Delete
                  </button>
                </div>
              </div>
              {rotatingName === s.name && (
                <form className="secrets-page__rotate" onSubmit={handleRotate}>
                  <input
                    type="password"
                    autoFocus
                    value={rotateValue}
                    placeholder="New value"
                    onChange={(e) => setRotateValue(e.target.value)}
                    autoComplete="off"
                    maxLength={4096}
                  />
                  <button
                    className="secrets-page__btn secrets-page__btn--primary"
                    type="submit"
                    disabled={rotateBusy || !rotateValue.trim()}
                  >
                    {rotateBusy ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    type="button"
                    className="secrets-page__btn"
                    onClick={() => setRotatingName(null)}
                  >
                    Cancel
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
