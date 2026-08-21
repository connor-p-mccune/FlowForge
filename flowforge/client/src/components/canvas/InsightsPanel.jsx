import { useEffect, useState } from 'react'
import { apiFetch } from '../../services/api'

// Run insights for the open workflow: success rate, throughput, duration
// percentiles, an SLA scorecard, the slowest steps, and a hand-drawn sparkline
// of recent run durations with anomalous runs marked. Read-only — it renders
// GET /api/workflows/:id/insights, the same rollup the CLI and public API serve.

function fmtMs(v) {
  if (v == null) return '—'
  if (v < 1000) return `${Math.round(v)}ms`
  if (v < 10_000) return `${(v / 1000).toFixed(1)}s`
  return `${Math.round(v / 1000)}s`
}

function fmtPct(v) {
  return v == null ? '—' : `${(v * 100).toFixed(1)}%`
}

// Duration trend → a glyph + label. A significant degradation is the only one
// worth alarming on; a significant improvement is quietly good; everything else
// (flat, or a direction the test couldn't confirm) reads as steady.
function trendDisplay(trend) {
  if (!trend) return null
  if (trend.direction === 'degrading' && trend.significant) {
    return { glyph: '↗', label: 'Slower over time', cls: 'insights__trend--bad' }
  }
  if (trend.direction === 'improving' && trend.significant) {
    return { glyph: '↘', label: 'Faster over time', cls: 'insights__trend--good' }
  }
  return { glyph: '→', label: 'Steady', cls: 'insights__trend--flat' }
}

// A tiny inline sparkline of recent durations, oldest → newest, with anomalous
// runs drawn as red dots. Hand-rendered SVG (no chart dependency) — the panel
// needs one shape, and the anomaly overlay is the whole point.
function Sparkline({ runs }) {
  const timed = runs.filter((r) => typeof r.durationMs === 'number').reverse()
  if (timed.length < 2) return null
  const W = 240
  const H = 44
  const pad = 4
  const values = timed.map((r) => r.durationMs)
  const max = Math.max(...values)
  const min = Math.min(...values)
  const span = max - min || 1
  const x = (i) => pad + (i * (W - 2 * pad)) / (timed.length - 1)
  const y = (v) => H - pad - ((v - min) / span) * (H - 2 * pad)
  const points = timed.map((r, i) => `${x(i).toFixed(1)},${y(r.durationMs).toFixed(1)}`).join(' ')
  return (
    <svg
      className="insights__spark"
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      height={H}
      preserveAspectRatio="none"
      role="img"
      aria-label="Recent run durations"
    >
      <polyline fill="none" stroke="#4f46e5" strokeWidth="1.5" points={points} />
      {timed.map((r, i) =>
        r.isAnomaly ? <circle key={r.id} cx={x(i)} cy={y(r.durationMs)} r="2.6" fill="#ef4444" /> : null
      )}
    </svg>
  )
}

// Makespan against the number of execution slots, as a small line with the
// current cap marked. The shape is the argument: a curve that has already
// flattened says more capacity buys nothing, and one still falling at the
// marker says it does.
function CapCurve({ curve, cap }) {
  if (!curve || curve.length < 2) return null
  const W = 240
  const H = 40
  const pad = 5
  const values = curve.map((p) => p.makespanMs)
  const max = Math.max(...values)
  const min = Math.min(...values)
  const span = max - min || 1
  const x = (i) => pad + (i * (W - 2 * pad)) / (curve.length - 1)
  const y = (v) => H - pad - ((v - min) / span) * (H - 2 * pad)
  const points = curve.map((p, i) => `${x(i).toFixed(1)},${y(p.makespanMs).toFixed(1)}`).join(' ')
  const currentIndex = curve.findIndex((p) => p.cap === cap)
  return (
    <svg
      className="insights__spark"
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      height={H}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Run duration against execution slots, from ${curve[0].cap} to ${curve[curve.length - 1].cap}`}
    >
      <polyline fill="none" stroke="#4f46e5" strokeWidth="1.5" points={points} />
      {currentIndex >= 0 && (
        <circle cx={x(currentIndex)} cy={y(curve[currentIndex].makespanMs)} r="3" fill="#4f46e5" />
      )}
    </svg>
  )
}

// What the engine's parallelism cap does to the forecast above.
//
// The forecast is a longest path, which is the duration with a slot always
// free. The engine runs at most EXEC_MAX_PARALLEL nodes at once, so for a graph
// wider than that the two disagree — and the gap is time the canvas cannot
// explain, because the node holding the slot may be on an unrelated branch.
//
// Deliberately silent when the cap costs nothing: a section reading
// “contention 1.0×” on every chain-shaped workflow is one people learn to skip.
function Concurrency({ concurrency, labelFor }) {
  if (!concurrency) return null
  const { cap, makespanMs, queuedMs, contention, averageParallelism, knee, curve } = concurrency
  const binds = contention != null && contention > 1.01
  if (!binds) return null

  const worstWait = (concurrency.chain || [])
    .filter((l) => l.waitedFor === 'slot' && l.queuedMs > 0)
    .sort((a, b) => b.queuedMs - a.queuedMs)[0]

  return (
    <>
      <div className="insights__section">Concurrency · {cap} slots</div>
      <div className="insights__forecast">
        <span className="insights__forecast-est">{fmtMs(makespanMs)}</span>
        <span className="insights__forecast-p95">{contention.toFixed(2)}× the critical path</span>
      </div>
      <ul className="insights__sla">
        <SlaRow ok={queuedMs === 0}>{fmtMs(queuedMs)} spent waiting for a slot</SlaRow>
        {averageParallelism != null && (
          <SlaRow ok>
            this graph can use {averageParallelism.toFixed(1)} slots at most
          </SlaRow>
        )}
        {knee && <SlaRow ok={knee.cap <= cap}>{knee.cap} slots would reach {fmtMs(knee.idealMakespanMs)}</SlaRow>}
      </ul>
      <CapCurve curve={curve} cap={cap} />
      {worstWait && (
        <p className="webhook-panel__hint">
          <strong>{labelFor(worstWait.nodeId)}</strong> waits {fmtMs(worstWait.queuedMs)} for
          capacity, not for data — nothing on the canvas shows that.
        </p>
      )}
    </>
  )
}

function SlaRow({ ok, children }) {
  // ok === false is a breach; null/true both render as met (an unmet-but-unknown
  // target shouldn't shout).
  const breach = ok === false
  return (
    <li className={breach ? 'insights__sla-item insights__sla-item--breach' : 'insights__sla-item insights__sla-item--ok'}>
      <span aria-hidden="true">{breach ? '✗' : '✓'}</span> {children}
    </li>
  )
}

// One detected step in the workflow's duration, with what changed alongside it.
//
// The trend above says "slower over time", which is where this panel used to
// stop and where the actual question begins. A change point turns that into a
// date, a size, the step that moved and the deploy that landed in the gap — and
// the case worth designing for is the one with *no* deploy in the gap, because
// "nothing you did caused this" is the finding that stops somebody re-reading
// their own diff for an afternoon.
function ChangePoint({ change, labelFor }) {
  const worse = change.direction === 'worse'
  const size = change.ratio
    ? `${change.ratio.toFixed(1)}×`
    : `${fmtMs(Math.abs(change.delta))}`
  return (
    <li className={`regression regression--${worse ? 'worse' : 'better'}`}>
      <div className="regression__head">
        <span className="regression__glyph" aria-hidden="true">{worse ? '↗' : '↘'}</span>
        <span className="regression__shift">
          {fmtMs(change.before.median)} → {fmtMs(change.after.median)}
        </span>
        <span className="regression__size">{size} {worse ? 'slower' : 'faster'}</span>
      </div>
      <div className="regression__when">
        {new Date(change.at).toLocaleString()} · {change.before.runs} runs before,{' '}
        {change.after.runs} after
      </div>
      {change.cause === 'external' ? (
        <p className="regression__cause">
          Nothing was deployed in this window — the cause is outside this workflow.
        </p>
      ) : (
        change.deploys.map((deploy) => (
          <p className="regression__cause" key={deploy.version}>
            <strong>Version {deploy.version}</strong>
            {deploy.createdBy ? ` by ${deploy.createdBy}` : ''}
            {deploy.changed?.changedNodes?.length ? (
              <>
                {' — changed '}
                {deploy.changed.changedNodes
                  .map((n) => `${n.label} (${n.changes.join(', ')})`)
                  .join(', ')}
              </>
            ) : null}
          </p>
        ))
      )}
      {change.cause === 'ambiguous' && (
        <p className="regression__cause">More than one deploy landed in this window.</p>
      )}
      {change.steps.map((step) => (
        <p className="regression__step" key={step.nodeId}>
          {labelFor(step.nodeId)}: {fmtMs(step.before)} → {fmtMs(step.after)}
        </p>
      ))}
    </li>
  )
}

export default function InsightsPanel({ workflowId, open, onClose, nodes = [] }) {
  const [data, setData] = useState(null)
  const [forecast, setForecast] = useState(null)
  const [regressions, setRegressions] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setError(null)
    setData(null)
    setForecast(null)
    setRegressions(null)
    apiFetch(`/api/workflows/${workflowId}/insights`)
      .then((d) => {
        if (!cancelled) setData(d)
      })
      .catch((e) => {
        if (!cancelled) setError(e.message)
      })
    // The forecast is a separate, non-blocking fetch — an unavailable forecast
    // shouldn't hide the insights, and vice versa.
    apiFetch(`/api/workflows/${workflowId}/forecast`)
      .then((f) => {
        if (!cancelled) setForecast(f)
      })
      .catch(() => {
        /* forecast is best-effort in the panel */
      })
    // Same treatment: a workflow with too little history to segment must not
    // stop the rest of the panel rendering, and vice versa.
    apiFetch(`/api/workflows/${workflowId}/regressions`)
      .then((r) => {
        if (!cancelled) setRegressions(r)
      })
      .catch(() => {
        /* change-point detection is best-effort in the panel */
      })
    return () => {
      cancelled = true
    }
  }, [open, workflowId])

  if (!open) return null

  const labelFor = (id) => nodes.find((n) => n.id === id)?.data?.label || id

  return (
    <aside className="webhook-panel insights-panel" aria-label="Run insights">
      <div className="webhook-panel__header">
        <span className="webhook-panel__title">Run insights</span>
        <button className="webhook-panel__close" title="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="webhook-panel__body">
        {error && <p className="webhook-panel__error">{error}</p>}
        {!data && !error && <p className="webhook-panel__hint">Loading…</p>}
        {data && data.window.runs === 0 && (
          <p className="webhook-panel__hint">
            No runs yet. Insights appear once this workflow has run a few times.
          </p>
        )}
        {data && data.window.runs > 0 && (
          <>
            <div className="insights__stats">
              <div className="insights__stat">
                <span className="insights__stat-value">{fmtPct(data.successRate)}</span>
                <span className="insights__stat-label">Success</span>
              </div>
              <div className="insights__stat">
                <span className="insights__stat-value">{data.throughput.perDay ?? '—'}</span>
                <span className="insights__stat-label">Runs / day</span>
              </div>
              <div className={`insights__stat${data.anomalyCount ? ' insights__stat--alert' : ''}`}>
                <span className="insights__stat-value">{data.anomalyCount}</span>
                <span className="insights__stat-label">Anomalies</span>
              </div>
            </div>

            <Sparkline runs={data.recentRuns} />

            {(() => {
              const t = trendDisplay(data.trend)
              return t ? (
                <div className={`insights__trend ${t.cls}`} title={`Mann-Kendall trend test${data.trend.tau != null ? ` · τ=${data.trend.tau}` : ''}`}>
                  <span className="insights__trend-glyph" aria-hidden="true">{t.glyph}</span>
                  {t.label}
                </div>
              ) : null
            })()}

            <div className="insights__section">Duration · completed runs</div>
            <div className="insights__percentiles">
              {['p50', 'p90', 'p95', 'p99'].map((p) => (
                <div key={p} className="insights__pct">
                  <span className="insights__pct-label">{p.toUpperCase()}</span>
                  <span className="insights__pct-value">{fmtMs(data.duration[p])}</span>
                </div>
              ))}
            </div>

            {forecast && forecast.available && (
              <>
                <div className="insights__section">Forecast · next run</div>
                <div className="insights__forecast">
                  <span className="insights__forecast-est">{fmtMs(forecast.estimatedMs)}</span>
                  <span className="insights__forecast-p95">{fmtMs(forecast.estimatedP95Ms)} at p95</span>
                </div>
                {forecast.bottleneck && (
                  <div className="insights__forecast-bottleneck">
                    Bottleneck: <strong>{labelFor(forecast.bottleneck.nodeId)}</strong>{' '}
                    {fmtMs(forecast.bottleneck.p50)}
                  </div>
                )}
                {forecast.coverage && forecast.coverage.ratio < 1 && (
                  <p className="webhook-panel__hint">
                    {forecast.coverage.nodesWithHistory}/{forecast.coverage.workNodes} steps have
                    timing history — the estimate sharpens as the workflow runs.
                  </p>
                )}
                <Concurrency concurrency={forecast.concurrency} labelFor={labelFor} />
              </>
            )}

            {data.sla && (
              <>
                <div className="insights__section">SLA</div>
                <ul className="insights__sla">
                  {data.sla.maxDurationMs != null && (
                    <SlaRow ok={data.sla.durationCompliant}>
                      p95 ≤ {fmtMs(data.sla.maxDurationMs)}
                    </SlaRow>
                  )}
                  {data.sla.minSuccessRate != null && (
                    <SlaRow ok={data.sla.successRateCompliant}>
                      success ≥ {fmtPct(data.sla.minSuccessRate)}
                    </SlaRow>
                  )}
                </ul>
              </>
            )}

            {regressions?.changePoints?.length > 0 && (
              <>
                <div className="insights__section">What changed, and when</div>
                <ul className="insights__regressions">
                  {regressions.changePoints.map((change) => (
                    <ChangePoint key={change.at} change={change} labelFor={labelFor} />
                  ))}
                </ul>
              </>
            )}

            {data.slowestSteps && data.slowestSteps.length > 0 && (
              <>
                <div className="insights__section">Slowest steps</div>
                <ul className="insights__steps">
                  {data.slowestSteps.map((s) => (
                    <li key={s.nodeId} className="insights__step">
                      <span className="insights__step-name" title={s.nodeType || ''}>
                        {labelFor(s.nodeId)}
                      </span>
                      <span className="insights__step-time">{fmtMs(s.avgDurationMs)}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>
    </aside>
  )
}
