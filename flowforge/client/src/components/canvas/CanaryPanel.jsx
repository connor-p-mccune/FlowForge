import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../../services/api'
import { useToast } from '../../hooks/useToast'

// Progressive delivery for the open workflow.
//
// The panel's job is to make one non-obvious thing obvious: while a canary is
// running, **stable traffic executes the last deployed version and canary
// traffic executes this canvas**. Everything else follows from that — which is
// why the header states it in words rather than assuming a mental model, and
// why the rollback button can honestly promise that nothing is lost.
//
// It polls while a canary is running, because watching the numbers accumulate
// *is* the activity; the endpoint is two counted queries, so this is cheap.

const POLL_MS = 15000

const fmtPct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)

function fmtMs(v) {
  if (v == null) return '—'
  if (v < 1000) return `${Math.round(v)}ms`
  if (v < 10_000) return `${(v / 1000).toFixed(1)}s`
  return `${Math.round(v / 1000)}s`
}

const median = (values) => {
  if (!values || values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const VERDICTS = {
  healthy: { label: 'No regression detected', cls: 'canary__verdict--good' },
  degraded: { label: 'Regression detected', cls: 'canary__verdict--bad' },
  failing: { label: 'Canary is failing', cls: 'canary__verdict--bad' },
  pending: { label: 'Gathering evidence', cls: 'canary__verdict--wait' },
}

// One arm's numbers. The failure rate carries its Wilson interval, because on a
// 12-run canary "0%" without a bound is a claim the sample cannot support.
function Arm({ title, subtitle, stats }) {
  return (
    <div className="canary__arm">
      <div className="canary__arm-head">
        <strong>{title}</strong>
        <span className="canary__arm-sub">{subtitle}</span>
      </div>
      <div className="canary__arm-stats">
        <span>
          <b>{stats.runs}</b> runs
        </span>
        <span>
          <b>{fmtPct(stats.failureRate)}</b> failed
          {stats.failureRateInterval && stats.runs > 0 && (
            <em>
              {' '}
              (≤ {fmtPct(stats.failureRateInterval.upper)})
            </em>
          )}
        </span>
        <span>
          <b>{fmtMs(median(stats.durations))}</b> median
        </span>
      </div>
    </div>
  )
}

export default function CanaryPanel({ workflowId, open, onClose }) {
  const toast = useToast()
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [percent, setPercent] = useState(10)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!workflowId) return
    try {
      setData(await apiFetch(`/api/workflows/${workflowId}/canary`))
      setError(null)
    } catch (err) {
      setError(err.message)
    }
  }, [workflowId])

  useEffect(() => {
    if (!open) return undefined
    load()
    const timer = setInterval(load, POLL_MS)
    return () => clearInterval(timer)
  }, [open, load])

  if (!open) return null

  async function act(path, body, method = 'POST') {
    setBusy(true)
    try {
      const result = await apiFetch(`/api/workflows/${workflowId}/canary${path}`, { method, body })
      await load()
      return result
    } catch (err) {
      toast.error(err.message)
      return null
    } finally {
      setBusy(false)
    }
  }

  const active = data?.active
  const verdict = active ? VERDICTS[data.verdict] || VERDICTS.pending : null

  return (
    <aside className="webhook-panel insights-panel" aria-label="Canary release">
      <div className="webhook-panel__header">
        <span className="webhook-panel__title">Canary release</span>
        <button className="webhook-panel__close" title="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="webhook-panel__body">
        {error && <p className="webhook-panel__error">{error}</p>}

        {!active && (
          <>
            <p className="webhook-panel__hint">
              Send a slice of this workflow’s runs to the graph on your canvas, and the rest to
              the last deployed version. Compare them, then promote or roll back.
            </p>
            <label className="canary__field">
              <span>Canary traffic</span>
              <input
                type="range"
                min={1}
                max={99}
                value={percent}
                onChange={(e) => setPercent(Number(e.target.value))}
              />
              <b>{percent}%</b>
            </label>
            <button
              className="secrets-page__btn secrets-page__btn--primary"
              disabled={busy}
              onClick={async () => {
                const started = await act('', { percent })
                if (started) toast.success(`Canary started at ${percent}%.`)
              }}
            >
              Start canary
            </button>
            <p className="webhook-panel__hint">
              Needs a deployed version to compare against — deploy once first.
            </p>
          </>
        )}

        {active && (
          <>
            <div className={`canary__verdict ${verdict.cls}`}>
              <strong>{verdict.label}</strong>
              <span>{data.reason}</span>
            </div>

            <p className="webhook-panel__hint">
              {data.state === 'rolled_back' ? (
                <>
                  Rolled back — every run is on the baseline version. Your canvas still has the
                  edits; raise the traffic below to try again.
                </>
              ) : (
                <>
                  <b>{data.percent}%</b> of runs execute <b>this canvas</b>; the rest execute the
                  last deployed version.
                </>
              )}
            </p>

            <Arm title="Canary" subtitle="your canvas" stats={data.canary} />
            <Arm title="Stable" subtitle="deployed version" stats={data.stable} />

            {data.successTest && (
              <p className="canary__test">
                Failure rate: p = {data.successTest.pValue.toFixed(3)}{' '}
                {data.successTest.significant ? '(significantly worse)' : '(no difference)'}
              </p>
            )}
            {data.durationTest && (
              <p className="canary__test">
                Duration: p = {data.durationTest.pValue.toFixed(3)}{' '}
                {data.durationTest.significant ? '(significantly slower)' : '(no difference)'}
              </p>
            )}

            <label className="canary__field">
              <span>Traffic</span>
              <input
                type="range"
                min={1}
                max={99}
                value={data.percent || percent}
                onChange={(e) => setPercent(Number(e.target.value))}
                onMouseUp={(e) => act('', { percent: Number(e.target.value) }, 'PUT')}
              />
              <b>{data.percent}%</b>
            </label>

            <div className="canary__actions">
              <button
                className="secrets-page__btn secrets-page__btn--primary"
                disabled={busy}
                onClick={async () => {
                  const result = await act('/promote')
                  if (result) toast.success(`Promoted as version ${result.version}.`)
                }}
              >
                Promote
              </button>
              <button
                className="secrets-page__btn"
                disabled={busy || data.state === 'rolled_back'}
                onClick={async () => {
                  const result = await act('/rollback', {})
                  if (result) toast.success('Rolled back — your canvas is unchanged.')
                }}
              >
                Roll back
              </button>
              <button
                className="secrets-page__btn secrets-page__btn--danger"
                disabled={busy}
                onClick={async () => {
                  const result = await act('', undefined, 'DELETE')
                  if (result) toast.success('Canary ended.')
                }}
              >
                End
              </button>
            </div>
            <p className="webhook-panel__hint">
              {data.auto
                ? 'Promotes or rolls back automatically once the evidence is clear.'
                : 'Automation is off — this reports, you decide.'}
            </p>
          </>
        )}
      </div>
    </aside>
  )
}
