import { useEffect, useState } from 'react'
import { apiFetch } from '../../services/api'
import { useToast } from '../../hooks/useToast'
import StatusBadgeSection from './StatusBadgeSection'

// Per-workflow run limits: cap how many of this workflow's runs may be active
// at once, and choose what happens to a run submitted at the cap — park it
// until a slot frees ('queue') or refuse it with an error ('reject'). Saves
// through PUT /api/workflows/:id; that route requires the name, so the loaded
// name and description ride along unchanged.
export default function RunSettingsPanel({ workflowId, open, onClose }) {
  const [workflow, setWorkflow] = useState(null)
  const [limitInput, setLimitInput] = useState('') // '' = unlimited
  const [policy, setPolicy] = useState('queue')
  const [slaDurationInput, setSlaDurationInput] = useState('') // seconds, '' = no target
  const [slaSuccessInput, setSlaSuccessInput] = useState('') // percent, '' = no target
  // Error-handler workflow: '' = none. Options are the workspace's *deployed*
  // workflows (the runtime requirement), excluding this one (the route
  // refuses self-handling).
  const [handlerId, setHandlerId] = useState('')
  const [handlerOptions, setHandlerOptions] = useState([])
  // Step cache: { entries, hits } for the section below. null while loading;
  // a fetch failure just hides the numbers — the panel's main job is settings.
  const [cacheStats, setCacheStats] = useState(null)
  const [clearing, setClearing] = useState(false)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const toast = useToast()

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setError(null)
    setWorkflow(null)
    apiFetch(`/api/workflows/${workflowId}/cache`)
      .then(({ cache }) => {
        if (!cancelled) setCacheStats(cache)
      })
      .catch(() => {
        /* stats are a nicety — the settings form still works without them */
      })
    apiFetch(`/api/workflows/${workflowId}`)
      .then(({ workflow: wf }) => {
        if (cancelled) return
        setWorkflow(wf)
        setLimitInput(wf.max_concurrent_runs ? String(wf.max_concurrent_runs) : '')
        setPolicy(wf.concurrency_policy || 'queue')
        // Stored in ms / as a 0..1 fraction; shown in the friendlier seconds / %.
        setSlaDurationInput(wf.sla_max_duration_ms ? String(wf.sla_max_duration_ms / 1000) : '')
        setSlaSuccessInput(
          wf.sla_min_success_rate != null ? String(Math.round(wf.sla_min_success_rate * 100)) : ''
        )
        setHandlerId(wf.error_workflow_id || '')
        return apiFetch(`/api/workspaces/${wf.workspace_id}/workflows`).then(
          ({ workflows: list }) => {
            if (cancelled) return
            setHandlerOptions(
              (list || []).filter((w) => w.status === 'deployed' && w.id !== workflowId)
            )
          }
        )
      })
      .catch((err) => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [open, workflowId])

  if (!open) return null

  async function handleClearCache() {
    setClearing(true)
    try {
      const { cleared } = await apiFetch(`/api/workflows/${workflowId}/cache`, {
        method: 'DELETE',
      })
      setCacheStats({ entries: 0, hits: 0 })
      toast.success(
        cleared === 1 ? 'Cleared 1 cached step result' : `Cleared ${cleared} cached step results`
      )
    } catch (err) {
      toast.error(err.message)
    } finally {
      setClearing(false)
    }
  }

  async function handleSave() {
    const trimmed = limitInput.trim()
    const limit = trimmed === '' ? null : Number(trimmed)
    if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
      setError('Limit must be a whole number from 1 to 100, or empty for unlimited')
      return
    }

    // SLA targets: seconds → ms, percent → fraction. Empty clears the target.
    const durTrim = slaDurationInput.trim()
    const durSeconds = durTrim === '' ? null : Number(durTrim)
    if (durSeconds !== null && (!Number.isFinite(durSeconds) || durSeconds <= 0)) {
      setError('Max run duration must be a positive number of seconds, or empty for no target')
      return
    }
    const successTrim = slaSuccessInput.trim()
    const successPct = successTrim === '' ? null : Number(successTrim)
    if (successPct !== null && (!Number.isFinite(successPct) || successPct < 0 || successPct > 100)) {
      setError('Min success rate must be a percentage from 0 to 100, or empty for no target')
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
          sla_max_duration_ms: durSeconds === null ? null : Math.round(durSeconds * 1000),
          sla_min_success_rate: successPct === null ? null : successPct / 100,
          error_workflow_id: handlerId || null,
        },
      })
      toast.success('Run settings saved')
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

              <div className="run-settings__section">SLA targets</div>
              <p className="webhook-panel__hint">
                Optional health objectives. When a finished run breaches one — too
                slow, statistically abnormal, or a success rate that dips below the
                floor — the owner is notified and the breach streams to the activity
                feed and any outbound webhooks.
              </p>
              <label className="run-settings__field">
                <span className="run-settings__label">Max run duration (seconds)</span>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  placeholder="No target"
                  value={slaDurationInput}
                  onChange={(e) => setSlaDurationInput(e.target.value)}
                />
              </label>
              <label className="run-settings__field">
                <span className="run-settings__label">Min success rate (%)</span>
                <input
                  type="number"
                  min="0"
                  max="100"
                  placeholder="No target"
                  value={slaSuccessInput}
                  onChange={(e) => setSlaSuccessInput(e.target.value)}
                />
              </label>

              <div className="run-settings__section">Error handler</div>
              <p className="webhook-panel__hint">
                Optionally run another workflow whenever a real run of this one
                fails — it receives the failure (workflow, run id, failed node,
                error message) as its trigger data, so escalation is just
                another workflow. Only deployed workflows can be handlers.
              </p>
              <label className="run-settings__field">
                <span className="run-settings__label">On failure, run</span>
                <select value={handlerId} onChange={(e) => setHandlerId(e.target.value)}>
                  <option value="">Nothing (default)</option>
                  {/* A saved handler that's been deleted or undeployed still
                      renders, so the select shows the truth instead of
                      silently displaying "Nothing". */}
                  {handlerId && !handlerOptions.some((w) => w.id === handlerId) && (
                    <option value={handlerId}>Unavailable workflow</option>
                  )}
                  {handlerOptions.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
              {handlerId && !handlerOptions.some((w) => w.id === handlerId) && (
                <p className="webhook-panel__hint">
                  The current handler is no longer deployed in this workspace —
                  failures are not being escalated. Pick another or clear it.
                </p>
              )}

              <button className="webhook-panel__create" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save settings'}
              </button>

              <div className="run-settings__section">Step cache</div>
              <p className="webhook-panel__hint">
                Nodes with caching enabled reuse a recorded output while its TTL
                lasts. Invalidation is automatic — any change to a node’s config
                or input is a new cache key — but if the upstream <em>data</em>{' '}
                changed behind an identical request, clear the cache to force the
                next run to re-execute everything.
              </p>
              {cacheStats && (
                <p className="webhook-panel__hint">
                  {cacheStats.entries === 0
                    ? 'No live cached results.'
                    : `${cacheStats.entries} live cached ${
                        cacheStats.entries === 1 ? 'result' : 'results'
                      }, reused ${cacheStats.hits} ${cacheStats.hits === 1 ? 'time' : 'times'}.`}
                </p>
              )}
              <button
                className="webhook-panel__create"
                onClick={handleClearCache}
                disabled={clearing || (cacheStats && cacheStats.entries === 0)}
              >
                {clearing ? 'Clearing…' : 'Clear cached results'}
              </button>
              <StatusBadgeSection workflowId={workflowId} initialToken={workflow.badge_token} />
            </>
          )
        )}
      </div>
    </aside>
  )
}
