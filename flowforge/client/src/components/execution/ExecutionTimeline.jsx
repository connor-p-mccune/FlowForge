// Gantt-style view of a finished run: one row per step, its bar positioned and
// sized by the step's start/finish inside the run's wall-time window. Bars
// sharing a vertical band ran concurrently (the engine executes independent
// branches in parallel), which makes this the quickest way to see where a
// slow run actually spent its time.
//
// When the server supplies a critical path (the longest dependency-respecting
// chain of steps — the ones that actually set the run's duration), those rows
// are highlighted, so the answer to "what do I speed up?" is visible at a
// glance: shortening anything off the path buys nothing.
//
// The bars used to leave one thing unexplained. The engine runs at most
// EXEC_MAX_PARALLEL nodes at once, so on a wide graph the bars arrive in tidy
// waves — and nothing said why, because the reason is not in the graph: a node
// was ready and sat waiting for a slot somebody else was holding. Given the
// schedule analysis (GET /api/executions/:id/schedule) each row grows a hollow
// **queued** segment immediately before its bar, covering exactly the interval
// between when the node could have started and when it did. Time that used to
// be an unexplained gap becomes the widest thing on the row.

function fmtMs(ms) {
  if (!Number.isFinite(ms)) return '—'
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

export default function ExecutionTimeline({ steps, nodes, criticalPath, schedule }) {
  const labelFor = (step) =>
    nodes?.find((n) => n.id === step.nodeId)?.data?.label || step.type || step.nodeId
  const labelForId = (id) => nodes?.find((n) => n.id === id)?.data?.label || id

  const timed = (steps || []).filter((s) => s.startedAt && s.finishedAt)
  if (timed.length === 0) {
    return <p className="exec-panel__empty">No timing data recorded for this run.</p>
  }

  const start = Math.min(...timed.map((s) => +new Date(s.startedAt)))
  const end = Math.max(...timed.map((s) => +new Date(s.finishedAt)))
  const span = Math.max(end - start, 1)

  const criticalIds = new Set(criticalPath?.path || [])
  const wall = end - start
  const critMs = criticalPath?.totalMs || 0
  const critPct = wall > 0 ? Math.round((critMs / wall) * 100) : 0

  const perNode = schedule?.perNode || {}
  const queuedMs = schedule?.observed?.queuedMs || 0
  const idealMs = schedule?.idealMakespanMs

  return (
    <div className="exec-timeline">
      <p className="exec-timeline__caption">
        Total wall time {fmtMs(wall)}. Bars that overlap vertically ran in parallel.
      </p>
      {criticalIds.size > 0 && (
        <p className="exec-timeline__critical-note">
          <span className="exec-timeline__critical-swatch" aria-hidden="true" />
          <span>
            <strong>Critical path</strong> — the longest dependency chain, {criticalIds.size}{' '}
            {criticalIds.size === 1 ? 'step' : 'steps'} totalling {fmtMs(critMs)} ({critPct}% of
            wall time). Speeding up a step off this path won’t make the run finish sooner.
          </span>
        </p>
      )}
      {queuedMs > 0 && (
        <p className="exec-timeline__queued-note">
          <span className="exec-timeline__queued-swatch" aria-hidden="true" />
          <span>
            <strong>Waiting for a slot</strong> — {fmtMs(queuedMs)} across the run, at{' '}
            {schedule.cap} concurrent {schedule.cap === 1 ? 'step' : 'steps'}. These nodes had
            their data and nowhere to run
            {Number.isFinite(idealMs) && idealMs < wall
              ? `; with capacity for all of them the same work takes ${fmtMs(idealMs)}`
              : ''}
            .
          </span>
        </p>
      )}
      <ol className="exec-timeline__rows">
        {steps.map((s) => {
          const hasBar = Boolean(s.startedAt && s.finishedAt)
          const from = hasBar ? +new Date(s.startedAt) : 0
          const to = hasBar ? +new Date(s.finishedAt) : 0
          const left = hasBar ? ((from - start) / span) * 100 : 0
          // Even instant steps get a sliver of bar so their timing reads.
          const width = hasBar ? Math.max(((to - from) / span) * 100, 0.8) : 0
          const isCritical = criticalIds.has(s.nodeId)

          // The queued segment ends exactly where the bar begins and is as wide
          // as the wait, so it is positioned from the bar rather than from the
          // analysis's own origin — the two cannot drift apart.
          const wait = perNode[s.nodeId]
          const waited = wait?.cause?.kind === 'slot' ? wait.queuedMs || 0 : 0
          const queueWidth = hasBar && waited > 0 ? Math.min((waited / span) * 100, left) : 0

          return (
            <li
              className={`exec-timeline__row${isCritical ? ' exec-timeline__row--critical' : ''}`}
              key={s.nodeId}
            >
              <span className="exec-timeline__label" title={labelFor(s)}>
                {labelFor(s)}
              </span>
              <span className="exec-timeline__track">
                {queueWidth > 0 && (
                  <span
                    className="exec-timeline__queued"
                    style={{ left: `${left - queueWidth}%`, width: `${queueWidth}%` }}
                    title={`${labelFor(s)}: ready, waiting ${fmtMs(waited)} for a slot held by ${labelForId(wait.cause.nodeId)}`}
                  />
                )}
                {hasBar && (
                  <span
                    className={`exec-timeline__bar exec-timeline__bar--${s.status}${
                      isCritical ? ' exec-timeline__bar--critical' : ''
                    }`}
                    style={{ left: `${left}%`, width: `${width}%` }}
                    title={`${labelFor(s)}: ${s.status} — ${fmtMs(to - from)}${
                      isCritical ? ' (critical path)' : ''
                    }`}
                  />
                )}
              </span>
              <span className="exec-timeline__duration">
                {hasBar ? fmtMs(to - from) : '—'}
                {waited > 0 && (
                  <span className="exec-timeline__waited" title="Time spent ready, waiting for a slot">
                    +{fmtMs(waited)}
                  </span>
                )}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
