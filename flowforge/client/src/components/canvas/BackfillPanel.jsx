import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../../services/api'
import { useToast } from '../../hooks/useToast'

// Default window: the last seven days. Long enough to be useful for the common
// case ("it's been broken since last week"), short enough that the first
// preview someone sees is a number they can reason about.
function defaultRange() {
  const to = new Date()
  const from = new Date(to.getTime() - 7 * 86400000)
  // <input type="datetime-local"> wants a local-ish "YYYY-MM-DDTHH:mm" with no
  // zone. We treat the value as UTC on the way out (see toIso) rather than
  // guessing the browser's zone, because every other timestamp in this panel —
  // and every logical date the server returns — is UTC.
  const fmt = (d) => d.toISOString().slice(0, 16)
  return { from: fmt(from), to: fmt(to) }
}

const toIso = (value) => (value ? new Date(`${value}:00Z`).toISOString() : '')

function formatUtc(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toISOString().replace('T', ' ').slice(0, 16) + 'Z'
}

// Schedule backfill: re-run a scheduled workflow over a window of the past.
//
// The panel is built around the preview rather than the submit button. This is
// the only surface in the app where one click creates hundreds of runs, and the
// difference between an hourly and a per-minute schedule over the same week is
// 168 runs versus 10,080 — so the count is computed server-side first, shown
// prominently, and the submit button stays disabled until it exists.
export default function BackfillPanel({ workflowId, open, onClose }) {
  const [range, setRange] = useState(defaultRange)
  const [skipExisting, setSkipExisting] = useState(true)
  const [plan, setPlan] = useState(null)
  const [planning, setPlanning] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [batches, setBatches] = useState([])
  const [error, setError] = useState(null)
  const toast = useToast()

  const loadBatches = useCallback(() => {
    apiFetch(`/api/workflows/${workflowId}/backfills`)
      .then(({ backfills }) => setBatches(backfills || []))
      .catch(() => {
        /* history is informational — the form still works without it */
      })
  }, [workflowId])

  useEffect(() => {
    if (!open) return
    setPlan(null)
    setError(null)
    loadBatches()
  }, [open, workflowId, loadBatches])

  // Any change to the window invalidates the plan on screen. Clearing it (rather
  // than leaving a stale count next to new dates) is what stops someone
  // submitting a range they never previewed.
  function updateRange(patch) {
    setRange((prev) => ({ ...prev, ...patch }))
    setPlan(null)
  }

  async function handlePreview() {
    setPlanning(true)
    setError(null)
    try {
      const result = await apiFetch(`/api/workflows/${workflowId}/backfill`, {
        method: 'POST',
        body: { preview: true, from: toIso(range.from), to: toIso(range.to), skipExisting },
      })
      setPlan(result)
    } catch (err) {
      setError(err.message)
      setPlan(null)
    } finally {
      setPlanning(false)
    }
  }

  async function handleSubmit() {
    setSubmitting(true)
    setError(null)
    try {
      const result = await apiFetch(`/api/workflows/${workflowId}/backfill`, {
        method: 'POST',
        body: { from: toIso(range.from), to: toIso(range.to), skipExisting },
      })
      toast.success(
        `Queued ${result.created} run${result.created === 1 ? '' : 's'} on the ${result.priority} lane`
      )
      setPlan(null)
      loadBatches()
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleCancelBatch(backfillId) {
    try {
      const { cancelled } = await apiFetch(
        `/api/workflows/${workflowId}/backfills/${backfillId}/cancel`,
        { method: 'POST' }
      )
      toast.success(`Cancelled ${cancelled} queued run${cancelled === 1 ? '' : 's'}`)
      loadBatches()
    } catch (err) {
      toast.error(err.message)
    }
  }

  if (!open) return null

  return (
    <div className="backfill-panel">
      <div className="backfill-panel__header">
        <h3 className="backfill-panel__title">⏮ Backfill</h3>
        <button className="backfill-panel__close" onClick={onClose} aria-label="Close backfill">
          ×
        </button>
      </div>

      <p className="webhook-panel__hint">
        Re-run this workflow for the times its schedule <em>would</em> have fired. Each
        run carries the instant it represents as <code>{'{{trigger.logicalDate}}'}</code>,
        so a workflow that processes “yesterday” processes the right yesterday.
      </p>

      <label className="run-settings__field">
        <span className="run-settings__label">From (UTC)</span>
        <input
          type="datetime-local"
          value={range.from}
          onChange={(e) => updateRange({ from: e.target.value })}
          aria-label="Backfill window start"
        />
      </label>
      <label className="run-settings__field">
        <span className="run-settings__label">To (UTC)</span>
        <input
          type="datetime-local"
          value={range.to}
          onChange={(e) => updateRange({ to: e.target.value })}
          aria-label="Backfill window end"
        />
      </label>
      <label className="backfill-panel__check">
        <input
          type="checkbox"
          checked={skipExisting}
          onChange={(e) => {
            setSkipExisting(e.target.checked)
            setPlan(null)
          }}
        />
        <span>Skip times that already have a run</span>
      </label>

      {error && <div className="backfill-panel__error">{error}</div>}

      <div className="backfill-panel__actions">
        <button className="backfill-panel__btn" onClick={handlePreview} disabled={planning}>
          {planning ? 'Planning…' : 'Preview'}
        </button>
        {/* Deliberately unavailable until a plan exists: nobody should be able
            to create runs for a window whose size they haven't seen. */}
        <button
          className="backfill-panel__btn backfill-panel__btn--primary"
          onClick={handleSubmit}
          disabled={!plan || plan.willRun === 0 || submitting}
        >
          {submitting ? 'Queueing…' : plan ? `Run ${plan.willRun} backfill(s)` : 'Run backfill'}
        </button>
      </div>

      {plan && (
        <div className="backfill-panel__plan">
          <div className="backfill-panel__count">
            {plan.willRun} run{plan.willRun === 1 ? '' : 's'}
            <span className="backfill-panel__count-sub">
              {' '}
              from {plan.total} occurrence{plan.total === 1 ? '' : 's'}
              {plan.skipped > 0 && ` · ${plan.skipped} already ran`}
            </span>
          </div>
          <div className="backfill-panel__meta">
            {plan.cron} [{plan.timeZone}] · {formatUtc(plan.from)} → {formatUtc(plan.to)}
          </div>
          <ul className="backfill-panel__occurrences">
            {plan.occurrences.slice(0, 6).map((o) => (
              <li
                key={o.logicalDate}
                className={o.alreadyRan ? 'backfill-panel__occurrence--ran' : undefined}
              >
                {formatUtc(o.logicalDate)}
                {o.alreadyRan && <span className="backfill-panel__ran-tag"> already ran</span>}
              </li>
            ))}
            {plan.occurrences.length > 6 && (
              <li className="backfill-panel__more-note">
                … and {plan.occurrences.length - 6} more
              </li>
            )}
          </ul>
        </div>
      )}

      {batches.length > 0 && (
        <>
          <div className="run-settings__section">Recent backfills</div>
          <ul className="backfill-panel__batches">
            {batches.map((b) => {
              const settled = b.completed + b.failed + b.cancelled
              return (
                <li key={b.backfillId} className="backfill-panel__batch">
                  <div className="backfill-panel__batch-head">
                    <span>
                      {formatUtc(b.firstLogicalDate)} → {formatUtc(b.lastLogicalDate)}
                    </span>
                    {b.active > 0 && (
                      <button
                        className="backfill-panel__cancel"
                        onClick={() => handleCancelBatch(b.backfillId)}
                      >
                        Stop
                      </button>
                    )}
                  </div>
                  {/* Progress is derived from the runs, so it stays honest even
                      if a run is cancelled or replayed outside this panel. */}
                  <div className="backfill-panel__progress">
                    <div
                      className="backfill-panel__progress-bar"
                      style={{ width: `${b.total ? (settled / b.total) * 100 : 0}%` }}
                    />
                  </div>
                  <div className="backfill-panel__batch-meta">
                    {settled}/{b.total} settled
                    {b.failed > 0 && <span className="backfill-panel__failed"> · {b.failed} failed</span>}
                    {b.active > 0 && <span> · {b.active} queued</span>}
                  </div>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}
