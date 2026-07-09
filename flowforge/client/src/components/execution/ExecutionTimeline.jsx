// Gantt-style view of a finished run: one row per step, its bar positioned and
// sized by the step's start/finish inside the run's wall-time window. Bars
// sharing a vertical band ran concurrently (the engine executes independent
// branches in parallel), which makes this the quickest way to see where a
// slow run actually spent its time.

function fmtMs(ms) {
  if (!Number.isFinite(ms)) return '—'
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

export default function ExecutionTimeline({ steps, nodes }) {
  const labelFor = (step) =>
    nodes?.find((n) => n.id === step.nodeId)?.data?.label || step.type || step.nodeId

  const timed = (steps || []).filter((s) => s.startedAt && s.finishedAt)
  if (timed.length === 0) {
    return <p className="exec-panel__empty">No timing data recorded for this run.</p>
  }

  const start = Math.min(...timed.map((s) => +new Date(s.startedAt)))
  const end = Math.max(...timed.map((s) => +new Date(s.finishedAt)))
  const span = Math.max(end - start, 1)

  return (
    <div className="exec-timeline">
      <p className="exec-timeline__caption">
        Total wall time {fmtMs(end - start)}. Bars that overlap vertically ran in parallel.
      </p>
      <ol className="exec-timeline__rows">
        {steps.map((s) => {
          const hasBar = Boolean(s.startedAt && s.finishedAt)
          const from = hasBar ? +new Date(s.startedAt) : 0
          const to = hasBar ? +new Date(s.finishedAt) : 0
          const left = hasBar ? ((from - start) / span) * 100 : 0
          // Even instant steps get a sliver of bar so their timing reads.
          const width = hasBar ? Math.max(((to - from) / span) * 100, 0.8) : 0
          return (
            <li className="exec-timeline__row" key={s.nodeId}>
              <span className="exec-timeline__label" title={labelFor(s)}>
                {labelFor(s)}
              </span>
              <span className="exec-timeline__track">
                {hasBar && (
                  <span
                    className={`exec-timeline__bar exec-timeline__bar--${s.status}`}
                    style={{ left: `${left}%`, width: `${width}%` }}
                    title={`${labelFor(s)}: ${s.status} — ${fmtMs(to - from)}`}
                  />
                )}
              </span>
              <span className="exec-timeline__duration">
                {hasBar ? fmtMs(to - from) : '—'}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
