import { useEffect, useState } from 'react'
import { apiFetch } from '../../services/api'
import { useToast } from '../../hooks/useToast'
import StatusBadgeSection from './StatusBadgeSection'

// Rate-limit window units, in seconds. The panel stores a window in seconds
// server-side but lets the user pick a friendlier unit; on load we show the
// largest unit the stored window divides into evenly.
const RATE_UNITS = { second: 1, minute: 60, hour: 3600 }
function splitWindow(seconds) {
  if (!seconds) return { value: '', unit: 'minute' }
  for (const unit of ['hour', 'minute']) {
    if (seconds % RATE_UNITS[unit] === 0) return { value: String(seconds / RATE_UNITS[unit]), unit }
  }
  return { value: String(seconds), unit: 'second' }
}

// Per-workflow run limits: cap how many of this workflow's runs may be active
// at once, and choose what happens to a run submitted at the cap — park it
// until a slot frees ('queue') or refuse it with an error ('reject'). Saves
// through PUT /api/workflows/:id; that route requires the name, so the loaded
// name and description ride along unchanged.
export default function RunSettingsPanel({ workflowId, open, onClose }) {
  const [workflow, setWorkflow] = useState(null)
  const [limitInput, setLimitInput] = useState('') // '' = unlimited
  const [policy, setPolicy] = useState('queue')
  // Rate limit: max run starts per window. '' max = no limit.
  const [rateMaxInput, setRateMaxInput] = useState('')
  const [rateWindowInput, setRateWindowInput] = useState('')
  const [rateUnit, setRateUnit] = useState('minute')
  const [priority, setPriority] = useState('normal') // default queue lane
  const [slaDurationInput, setSlaDurationInput] = useState('') // seconds, '' = no target
  const [slaSuccessInput, setSlaSuccessInput] = useState('') // percent, '' = no target
  const [heartbeatInput, setHeartbeatInput] = useState('') // minutes, '' = no expectation
  // Maintenance window: a cron (start) + duration (minutes). '' cron = none.
  const [maintCronInput, setMaintCronInput] = useState('')
  const [maintDurationInput, setMaintDurationInput] = useState('')
  // Error-handler workflow: '' = none. Options are the workspace's *deployed*
  // workflows (the runtime requirement), excluding this one (the route
  // refuses self-handling).
  const [handlerId, setHandlerId] = useState('')
  const [handlerOptions, setHandlerOptions] = useState([])
  // Cross-workflow dependencies (read-only impact analysis). null while
  // loading; a fetch failure just hides the section — it's informational.
  const [deps, setDeps] = useState(null)
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
    setDeps(null)
    apiFetch(`/api/workflows/${workflowId}/dependencies`)
      .then((d) => {
        if (!cancelled) setDeps(d)
      })
      .catch(() => {
        /* the impact section is informational — hide it if it can't load */
      })
    apiFetch(`/api/workflows/${workflowId}`)
      .then(({ workflow: wf }) => {
        if (cancelled) return
        setWorkflow(wf)
        setLimitInput(wf.max_concurrent_runs ? String(wf.max_concurrent_runs) : '')
        setPolicy(wf.concurrency_policy || 'queue')
        setRateMaxInput(wf.rate_limit_max ? String(wf.rate_limit_max) : '')
        {
          const { value, unit } = splitWindow(wf.rate_limit_window_seconds)
          setRateWindowInput(value)
          setRateUnit(unit)
        }
        setPriority(wf.default_priority || 'normal')
        // Stored in ms / as a 0..1 fraction; shown in the friendlier seconds / %.
        setSlaDurationInput(wf.sla_max_duration_ms ? String(wf.sla_max_duration_ms / 1000) : '')
        setSlaSuccessInput(
          wf.sla_min_success_rate != null ? String(Math.round(wf.sla_min_success_rate * 100)) : ''
        )
        setHeartbeatInput(
          wf.heartbeat_interval_minutes ? String(wf.heartbeat_interval_minutes) : ''
        )
        setMaintCronInput(wf.maintenance_cron || '')
        setMaintDurationInput(
          wf.maintenance_duration_minutes ? String(wf.maintenance_duration_minutes) : ''
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

    // Rate limit: max runs per window (converted to seconds). Empty max clears
    // the whole limit; a set max needs a positive window.
    const rateMaxTrim = rateMaxInput.trim()
    let rateMax = null
    let rateWindowSeconds = null
    if (rateMaxTrim !== '') {
      rateMax = Number(rateMaxTrim)
      if (!Number.isInteger(rateMax) || rateMax < 1) {
        setError('Rate limit must be a whole number of runs (1 or more), or empty for no limit')
        return
      }
      const windowValue = Number(rateWindowInput.trim())
      if (!Number.isInteger(windowValue) || windowValue < 1) {
        setError('Rate-limit window must be a whole number (1 or more)')
        return
      }
      rateWindowSeconds = windowValue * RATE_UNITS[rateUnit]
      if (rateWindowSeconds > 86400) {
        setError('Rate-limit window must be at most one day')
        return
      }
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
    const heartbeatTrim = heartbeatInput.trim()
    const heartbeatMinutes = heartbeatTrim === '' ? null : Number(heartbeatTrim)
    if (
      heartbeatMinutes !== null &&
      (!Number.isInteger(heartbeatMinutes) || heartbeatMinutes < 1 || heartbeatMinutes > 10080)
    ) {
      setError('Heartbeat must be a whole number of minutes from 1 to 10080, or empty for none')
      return
    }

    // Maintenance window: a cron (start) plus a duration in minutes. Empty cron
    // clears the window; a set cron needs a positive duration. The server
    // validates the cron syntax itself.
    const maintCron = maintCronInput.trim()
    let maintenanceCron = null
    let maintenanceDuration = null
    if (maintCron !== '') {
      maintenanceCron = maintCron
      maintenanceDuration = Number(maintDurationInput.trim())
      if (!Number.isInteger(maintenanceDuration) || maintenanceDuration < 1 || maintenanceDuration > 10080) {
        setError('Maintenance duration must be a whole number of minutes from 1 to 10080')
        return
      }
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
          rate_limit_max: rateMax,
          rate_limit_window_seconds: rateWindowSeconds,
          sla_max_duration_ms: durSeconds === null ? null : Math.round(durSeconds * 1000),
          sla_min_success_rate: successPct === null ? null : successPct / 100,
          heartbeat_interval_minutes: heartbeatMinutes,
          maintenance_cron: maintenanceCron,
          maintenance_duration_minutes: maintenanceDuration,
          error_workflow_id: handlerId || null,
          default_priority: priority,
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

              <div className="run-settings__section">Rate limit</div>
              <p className="webhook-panel__hint">
                Cap how many runs may <em>start</em> in a rolling window —
                independent of the concurrency cap above. Concurrency bounds how
                many run at once; this bounds how often they start, so a runaway
                schedule or a bursty webhook sender can’t hammer a downstream
                API. Over the limit, a run is refused (409); test runs are exempt.
              </p>
              <div className="run-settings__rate">
                <label className="run-settings__field run-settings__rate-max">
                  <span className="run-settings__label">Max runs</span>
                  <input
                    type="number"
                    min="1"
                    placeholder="No limit"
                    value={rateMaxInput}
                    onChange={(e) => setRateMaxInput(e.target.value)}
                  />
                </label>
                <label className="run-settings__field run-settings__rate-window">
                  <span className="run-settings__label">Per</span>
                  <div className="run-settings__rate-window-inputs">
                    <input
                      type="number"
                      min="1"
                      placeholder="1"
                      value={rateWindowInput}
                      onChange={(e) => setRateWindowInput(e.target.value)}
                      aria-label="Rate-limit window amount"
                    />
                    <select
                      value={rateUnit}
                      onChange={(e) => setRateUnit(e.target.value)}
                      aria-label="Rate-limit window unit"
                    >
                      <option value="second">second(s)</option>
                      <option value="minute">minute(s)</option>
                      <option value="hour">hour(s)</option>
                    </select>
                  </div>
                </label>
              </div>

              <label className="run-settings__field">
                <span className="run-settings__label">Default run priority</span>
                <select value={priority} onChange={(e) => setPriority(e.target.value)}>
                  <option value="high">High — picked up before other work</option>
                  <option value="normal">Normal (default)</option>
                  <option value="low">Low — yields to everything else</option>
                </select>
              </label>
              <p className="webhook-panel__hint">
                The queue lane this workflow’s runs take (API triggers can
                override per run with <code>?priority=</code>). Priority orders
                pickup — it never interrupts runs already executing — and test
                runs always ride the high lane.
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

              <div className="run-settings__section">Heartbeat</div>
              <p className="webhook-panel__hint">
                Optional dead-man’s switch: expect a successful run at least this
                often. If the workflow goes quiet — a schedule that stopped
                firing, a webhook sender that went away — the owner is notified
                once and the miss streams to the activity feed and outbound
                webhooks; the first success after that emits a recovery.
              </p>
              <label className="run-settings__field">
                <span className="run-settings__label">Expect a success every (minutes)</span>
                <input
                  type="number"
                  min="1"
                  max="10080"
                  placeholder="No expectation"
                  value={heartbeatInput}
                  onChange={(e) => setHeartbeatInput(e.target.value)}
                />
              </label>

              <div className="run-settings__section">Maintenance window</div>
              <p className="webhook-panel__hint">
                Automatically pause this workflow during a recurring window and
                resume it after — for a nightly migration, a downstream API’s own
                maintenance hour, or a deploy freeze. Inside the window no new
                runs start (in-flight runs finish); a manual pause is never
                touched by the schedule. Times are UTC.
              </p>
              <label className="run-settings__field">
                <span className="run-settings__label">Starts (cron)</span>
                <input
                  placeholder="0 2 * * 0  (02:00 every Sunday)"
                  value={maintCronInput}
                  onChange={(e) => setMaintCronInput(e.target.value)}
                  aria-label="Maintenance window cron"
                />
              </label>
              <label className="run-settings__field">
                <span className="run-settings__label">Lasts (minutes)</span>
                <input
                  type="number"
                  min="1"
                  max="10080"
                  placeholder="No window"
                  value={maintDurationInput}
                  onChange={(e) => setMaintDurationInput(e.target.value)}
                  aria-label="Maintenance window duration"
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

              {deps && (deps.dependsOn.length > 0 || deps.dependedOnBy.length > 0 || deps.cycle) && (
                <>
                  <div className="run-settings__section">Dependencies</div>
                  {deps.cycle && (
                    <p className="webhook-panel__error">
                      ⚠ Cross-workflow cycle: {deps.cycle.join(' → ')}. This would fail at run
                      time with a circular-reference error.
                    </p>
                  )}
                  {deps.dependsOn.length > 0 && (
                    <div className="run-settings__deps">
                      <span className="run-settings__label">Calls</span>
                      <ul className="run-settings__deps-list">
                        {deps.dependsOn.map((d) => (
                          <li key={d.id} title={d.id}>
                            {d.name}{' '}
                            <span className="run-settings__deps-via">({d.via.join(', ')})</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {deps.dependedOnBy.length > 0 && (
                    <div className="run-settings__deps">
                      <span className="run-settings__label">Called by</span>
                      <ul className="run-settings__deps-list">
                        {deps.dependedOnBy.map((d) => (
                          <li key={d.id} title={d.id}>
                            {d.name}{' '}
                            <span className="run-settings__deps-via">({d.via.join(', ')})</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <p className="webhook-panel__hint">
                    What this workflow references and what references it, across the
                    workspace — check before undeploying or deleting.
                  </p>
                </>
              )}

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
