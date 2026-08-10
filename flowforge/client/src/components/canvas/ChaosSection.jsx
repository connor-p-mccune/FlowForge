import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../../services/api'
import { useToast } from '../../hooks/useToast'

// Chaos profile controls, inside the run settings panel.
//
// The UI is deliberately opinionated about the two things that make this a tool
// rather than a hazard, because both are easy to get wrong at 2am:
//
//   * **Scope is a choice you have to make**, and the real-run option says what
//     it does in plain words rather than being a checkbox labelled "production".
//   * **The expiry is offered as a duration, not a date.** Nobody wants to think
//     about a timestamp; everyone can answer "for how long?" — and the field is
//     mandatory precisely so a profile can't be armed forever by inattention.
//
// Rules are edited as JSON. A form for three modes with per-mode fields would be
// a lot of surface for a feature used by whoever is already comfortable with the
// node ids they're targeting — and the server validates and explains, which is
// the part that actually has to be right.

const DURATIONS = [
  { label: '1 hour', ms: 3600_000 },
  { label: '4 hours', ms: 4 * 3600_000 },
  { label: '1 day', ms: 24 * 3600_000 },
  { label: '7 days', ms: 7 * 24 * 3600_000 },
]

const EXAMPLE = `[
  { "mode": "fail", "nodeType": "action-http", "probability": 0.5, "message": "API down" },
  { "mode": "delay", "nodeId": "http-1", "delayMs": 5000 },
  { "mode": "stub", "nodeId": "ai-1", "output": { "text": "canned" } }
]`

function formatExpiry(iso) {
  if (!iso) return ''
  const ms = Date.parse(iso) - Date.now()
  if (!Number.isFinite(ms)) return ''
  if (ms <= 0) return 'expired'
  const hours = ms / 3600_000
  if (hours < 1) return `${Math.round(ms / 60_000)} min left`
  if (hours < 48) return `${Math.round(hours)} h left`
  return `${Math.round(hours / 24)} days left`
}

export default function ChaosSection({ workflowId }) {
  const toast = useToast()
  const [state, setState] = useState(null) // { profile, active }
  const [open, setOpen] = useState(false)
  const [scope, setScope] = useState('dry-run')
  const [durationMs, setDurationMs] = useState(DURATIONS[1].ms)
  const [rulesText, setRulesText] = useState(EXAMPLE)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setState(await apiFetch(`/api/workflows/${workflowId}/chaos`))
    } catch {
      setState({ profile: null, active: false })
    }
  }, [workflowId])

  useEffect(() => {
    load()
  }, [load])

  async function handleArm(e) {
    e.preventDefault()
    setError(null)
    let rules
    try {
      rules = JSON.parse(rulesText)
    } catch (err) {
      setError(`Rules are not valid JSON — ${err.message}`)
      return
    }
    setBusy(true)
    try {
      const result = await apiFetch(`/api/workflows/${workflowId}/chaos`, {
        method: 'PUT',
        body: { scope, expiresAt: new Date(Date.now() + durationMs).toISOString(), rules },
      })
      setState(result)
      setOpen(false)
      toast.success('Chaos profile armed.')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function handleDisarm() {
    setBusy(true)
    try {
      await apiFetch(`/api/workflows/${workflowId}/chaos`, { method: 'DELETE' })
      await load()
      toast.success('Chaos profile disarmed.')
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusy(false)
    }
  }

  const profile = state?.profile

  return (
    <>
      <div className="run-settings__section">Chaos</div>
      <p className="webhook-panel__hint">
        Inject deliberate faults so the failure paths — retries, error branches,
        the error-handler workflow — can be exercised on purpose. Test runs only
        unless you widen it, and every profile expires.
      </p>

      {profile && (
        <p className={`chaos__status${state.active ? ' chaos__status--armed' : ''}`}>
          {state.active ? '⚡ Armed' : 'Expired'} · {profile.rules.length}{' '}
          {profile.rules.length === 1 ? 'rule' : 'rules'} ·{' '}
          {profile.scope === 'all' ? 'all runs' : 'test runs only'}
          {state.active && <> · {formatExpiry(profile.expiresAt)}</>}
        </p>
      )}

      {!open && (
        <div className="chaos__buttons">
          <button className="webhook-panel__create" onClick={() => setOpen(true)}>
            {profile ? 'Replace profile' : 'Arm a profile'}
          </button>
          {profile && (
            <button className="webhook-panel__create" onClick={handleDisarm} disabled={busy}>
              Disarm
            </button>
          )}
        </div>
      )}

      {open && (
        <form className="chaos__form" onSubmit={handleArm}>
          <label className="run-settings__field">
            <span className="run-settings__label">Applies to</span>
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="dry-run">Test runs only (safe)</option>
              <option value="all">Every run, including production traffic</option>
            </select>
          </label>
          {scope === 'all' && (
            <p className="chaos__warning">
              Real runs will fail on purpose. Owner-only, recorded in the audit log, and
              announced in the workspace feed.
            </p>
          )}

          <label className="run-settings__field">
            <span className="run-settings__label">Expires after</span>
            <select value={durationMs} onChange={(e) => setDurationMs(Number(e.target.value))}>
              {DURATIONS.map((d) => (
                <option key={d.ms} value={d.ms}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>

          <label className="run-settings__field">
            <span className="run-settings__label">Rules (JSON)</span>
            <textarea
              className="chaos__rules"
              rows={7}
              value={rulesText}
              onChange={(e) => setRulesText(e.target.value)}
              spellCheck={false}
            />
          </label>

          {error && <p className="webhook-panel__error">{error}</p>}

          <div className="chaos__buttons">
            <button className="webhook-panel__create" type="submit" disabled={busy}>
              {busy ? 'Arming…' : 'Arm profile'}
            </button>
            <button className="webhook-panel__create" type="button" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </>
  )
}
