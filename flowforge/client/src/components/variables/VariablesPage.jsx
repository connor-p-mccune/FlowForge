import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../../services/api'
import { useToast } from '../../hooks/useToast'
import { SkeletonRows } from '../Skeleton'

// Workspace variables manager — the plain-config counterpart to Secrets.
// Values are readable and editable (that's the point: environment base URLs,
// channel names, thresholds you can see and diff); node configs reference
// them as {{vars.NAME}}. Anything sensitive belongs on the Secrets page,
// where values are encrypted and masked in run logs — variables get neither.
// Reuses the secrets-page styles: the two pages are deliberately siblings.

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

function formatDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function VariablesPage({ workspaceId }) {
  const toast = useToast()
  const [variables, setVariables] = useState(null) // null = loading
  const [error, setError] = useState(null)

  // Add form
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)

  // Inline edit: which variable's value form is open
  const [editingName, setEditingName] = useState(null)
  const [editValue, setEditValue] = useState('')
  const [editBusy, setEditBusy] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      const { variables: list } = await apiFetch(`/api/workspaces/${workspaceId}/variables`)
      setVariables(list)
    } catch (err) {
      setError(err.message)
      setVariables([])
    }
  }, [workspaceId])

  useEffect(() => {
    setVariables(null)
    load()
  }, [load])

  const nameValid = NAME_PATTERN.test(name)
  const nameTaken = (variables || []).some((v) => v.name === name)

  async function handleAdd(e) {
    e.preventDefault()
    setSaving(true)
    try {
      const { variable } = await apiFetch(`/api/workspaces/${workspaceId}/variables/${name}`, {
        method: 'PUT',
        body: { value },
      })
      setVariables((prev) => [...(prev || []), variable].sort((a, b) => a.name.localeCompare(b.name)))
      toast.success(`Variable ${variable.name} saved.`)
      setName('')
      setValue('')
    } catch (err) {
      toast.error(`Couldn’t save variable: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  async function handleEdit(e) {
    e.preventDefault()
    setEditBusy(true)
    try {
      const { variable } = await apiFetch(`/api/workspaces/${workspaceId}/variables/${editingName}`, {
        method: 'PUT',
        body: { value: editValue },
      })
      setVariables((prev) => prev.map((v) => (v.name === variable.name ? variable : v)))
      toast.success(`Variable ${variable.name} updated.`)
      setEditingName(null)
      setEditValue('')
    } catch (err) {
      toast.error(`Couldn’t update variable: ${err.message}`)
    } finally {
      setEditBusy(false)
    }
  }

  async function handleDelete(varName) {
    if (!window.confirm(`Delete variable ${varName}? Workflows referencing {{vars.${varName}}} will resolve it as empty.`)) {
      return
    }
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/variables/${varName}`, { method: 'DELETE' })
      setVariables((prev) => prev.filter((v) => v.name !== varName))
      toast.success(`Variable ${varName} deleted.`)
    } catch (err) {
      toast.error(`Couldn’t delete variable: ${err.message}`)
    }
  }

  return (
    <div className="secrets-page">
      <div className="secrets-page__header">
        <h1 className="secrets-page__title">Variables</h1>
        <p className="secrets-page__subtitle">
          Plain configuration values — environment base URLs, channel names, thresholds —
          referenced from any node in this workspace as <code>{'{{vars.NAME}}'}</code>.
          Values are visible here and in run logs; put anything sensitive in{' '}
          <strong>Secrets</strong> instead, where it is encrypted and masked.
        </p>
      </div>

      {error && <p className="secrets-page__error">{error}</p>}

      <form className="secrets-page__add" onSubmit={handleAdd}>
        <div className="secrets-page__add-fields">
          <label className="secrets-page__field">
            <span>Name</span>
            <input
              value={name}
              placeholder="API_BASE_URL"
              onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
              maxLength={64}
            />
          </label>
          <label className="secrets-page__field secrets-page__field--grow">
            <span>Value</span>
            <input
              value={value}
              placeholder="https://api.staging.example.com"
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
            {saving ? 'Saving…' : 'Add variable'}
          </button>
        </div>
        {name && !nameValid && (
          <p className="secrets-page__hint secrets-page__hint--warn">
            Names start with a letter and use only letters, numbers, and underscores.
          </p>
        )}
        {nameTaken && (
          <p className="secrets-page__hint secrets-page__hint--warn">
            {name} already exists — use “Edit value” below to change it.
          </p>
        )}
      </form>

      {variables === null ? (
        <SkeletonRows count={3} height={44} />
      ) : variables.length === 0 ? (
        <div className="secrets-page__empty">
          <p>No variables yet.</p>
          <p className="secrets-page__hint">
            Add one above, then use it in a node — for example an HTTP URL of{' '}
            <code>{'{{vars.API_BASE_URL}}/orders'}</code>. Changing the variable
            re-points every workflow that references it.
          </p>
        </div>
      ) : (
        <ul className="secrets-page__list">
          {variables.map((v) => (
            <li key={v.name} className="secrets-page__item">
              <div className="secrets-page__item-row">
                <div className="secrets-page__item-main">
                  <code className="secrets-page__name">{v.name}</code>
                  <code className="secrets-page__value">{v.value}</code>
                </div>
                <div className="secrets-page__item-meta">
                  {v.created_by_name && <span>added by {v.created_by_name}</span>}
                  <span>updated {formatDate(v.updated_at)}</span>
                </div>
                <div className="secrets-page__item-actions">
                  <button
                    className="secrets-page__btn"
                    onClick={() => {
                      setEditingName((cur) => (cur === v.name ? null : v.name))
                      setEditValue(v.value)
                    }}
                  >
                    Edit value
                  </button>
                  <button
                    className="secrets-page__btn secrets-page__btn--danger"
                    onClick={() => handleDelete(v.name)}
                  >
                    Delete
                  </button>
                </div>
              </div>
              {editingName === v.name && (
                <form className="secrets-page__rotate" onSubmit={handleEdit}>
                  <input
                    autoFocus
                    value={editValue}
                    placeholder="New value"
                    onChange={(e) => setEditValue(e.target.value)}
                    autoComplete="off"
                    maxLength={4096}
                  />
                  <button
                    className="secrets-page__btn secrets-page__btn--primary"
                    type="submit"
                    disabled={editBusy || !editValue.trim()}
                  >
                    {editBusy ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    type="button"
                    className="secrets-page__btn"
                    onClick={() => setEditingName(null)}
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
