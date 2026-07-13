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

export default function InsightsPanel({ workflowId, open, onClose, nodes = [] }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setError(null)
    setData(null)
    apiFetch(`/api/workflows/${workflowId}/insights`)
      .then((d) => {
        if (!cancelled) setData(d)
      })
      .catch((e) => {
        if (!cancelled) setError(e.message)
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
