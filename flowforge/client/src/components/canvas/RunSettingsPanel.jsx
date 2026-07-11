import { useEffect, useState } from 'react'
import { apiFetch } from '../../services/api'
import { useToast } from '../../hooks/useToast'

// Per-workflow run limits: cap how many of this workflow's runs may be active
// at once, and choose what happens to a run submitted at the cap — park it
// until a slot frees ('queue') or refuse it with an error ('reject'). Saves
// through PUT /api/workflows/:id; that route requires the name, so the loaded
// name and description ride along unchanged.
export default function RunSettingsPanel({ workflowId, open, onClose }) {
  const [workflow, setWorkflow] = useState(null)
  const [limitInput, setLimitInput] = useState('') // '' = unlimited
  const [policy, setPolicy] = useState('queue')
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const toast = useToast()

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setError(null)
    setWorkflow(null)
    apiFetch(`/api/workflows/${workflowId}`)
      .then(({ workflow: wf }) => {
        if (cancelled) return
        setWorkflow(wf)
        setLimitInput(wf.max_concurrent_runs ? String(wf.max_concurrent_runs) : '')
        setPolicy(wf.concurrency_policy || 'queue')
      })
      .catch((err) => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [open, workflowId])

  if (!open) return null

  async function handleSave() {
    const trimmed = limitInput.trim()
    const limit = trimmed === '' ? null : Number(trimmed)
    if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
      setError('Limit must be a whole number from 1 to 100, or empty for unlimited')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await apiFetch(`/api/workflows/${workflowId}`, {
        method: 'PUT',
        body: {
          name: workflow.name,
          description: workflow.description ?? undefined,
          max_concurrent_runs: limit,
          concurrency_policy: policy,
        },
      })
      toast.success('Run limits saved')
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <aside className="webhook-panel run-settings" aria-label="Run limits">
      <div className="webhook-panel__header">
        <span className="webhook-panel__title">Run limits</span>
        <button className="webhook-panel__close" title="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="webhook-panel__body">
        <p className="webhook-panel__hint">
          Cap how many runs of this workflow execute at once — useful for
          singleton jobs (deploys, syncs) that must not overlap. Test runs are
          exempt.
        </p>
        {error && <p className="webhook-panel__error">{error}</p>}
        {!workflow && !error ? (
          <p className="webhook-panel__hint">Loading…</p>
        ) : (
          workflow && (
            <>
              <label className="run-settings__field">
                <span className="run-settings__label">Max concurrent runs</span>
                <input
                  type="number"
                  min="1"
                  max="100"
                  placeholder="Unlimited"
                  value={limitInput}
                  onChange={(e) => setLimitInput(e.target.value)}
                />
              </label>
              <label className="run-settings__field">
                <span className="run-settings__label">When at the limit</span>
                <select value={policy} onChange={(e) => setPolicy(e.target.value)}>
                  <option value="queue">Queue — wait for a free slot</option>
                  <option value="reject">Reject — refuse new runs with an error</option>
                </select>
              </label>
              <p className="webhook-panel__hint">
                {policy === 'reject'
                  ? 'Submissions at the cap fail immediately (409) — callers find out now instead of watching a run sit queued. Scheduled ticks are skipped, which is exactly “don’t overlap” for cron workflows.'
                  : 'Runs at the cap wait and start automatically once a slot frees. Order across waiting runs is not guaranteed.'}
              </p>
              <button className="webhook-panel__create" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save limits'}
              </button>
            </>
          )
        )}
      </div>
    </aside>
  )
}
