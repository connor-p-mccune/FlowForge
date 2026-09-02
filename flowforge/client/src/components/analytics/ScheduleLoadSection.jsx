import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch } from '../../services/api'
import Skeleton from '../Skeleton'

// Where the scheduled load lands.
//
// The charts above this one are about what already happened. This is about what
// is going to — and the shape of it is not random, because cron is written by
// people and people write round numbers. Nobody schedules a report for 03:47.
//
// The bar chart is the argument. A peak of five means two different things
// depending on what the other twenty-three hours look like: a workspace idling
// at zero and spiking at midnight has a cheap fix, and one sitting at four all
// day does not. Printing the peak alone would leave a reader unable to tell
// those apart, which is why the profile is here rather than the number.

const HOURS = Array.from({ length: 24 }, (_, h) => h)

const duration = (ms) => (ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}m`)

// "Wed 03 Sep, 00:00 UTC" — fixed to UTC because the cron contract is, and a
// browser rendering it in local time would disagree with every other surface.
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function formatUtc(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${DAYS[d.getUTCDay()]} ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]}, ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  )
}

function Profile({ byHour, peakHour }) {
  const max = Math.max(1, ...byHour)
  return (
    <div className="sched__profile" role="img" aria-label="Peak concurrent scheduled runs by UTC hour">
      {HOURS.map((h) => (
        <div key={h} className="sched__bar-slot" title={`${String(h).padStart(2, '0')}:00 — ${byHour[h]} at once`}>
          <div
            className={`sched__bar${h === peakHour ? ' sched__bar--peak' : ''}`}
            style={{ height: `${Math.round((byHour[h] / max) * 100)}%` }}
          />
          {/* Every third hour, so the axis stays readable at any width. */}
          <span className="sched__tick">{h % 3 === 0 ? String(h).padStart(2, '0') : ''}</span>
        </div>
      ))}
    </div>
  )
}

export default function ScheduleLoadSection({ workspaceId }) {
  const [report, setReport] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    setReport(null)
    setError(null)
    apiFetch(`/api/workspaces/${workspaceId}/schedule`)
      .then((data) => {
        if (!cancelled) setReport(data)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  if (error) {
    return (
      <div className="analytics__panel">
        <div className="analytics__panel-title">Scheduled load</div>
        <div className="analytics__panel-empty">Unable to load — {error}</div>
      </div>
    )
  }

  if (!report) {
    return (
      <div className="analytics__panel" aria-hidden="true">
        <Skeleton width={160} height={14} />
        <Skeleton height={140} style={{ marginTop: 12 }} />
      </div>
    )
  }

  if (!report.available) {
    return (
      <div className="analytics__panel">
        <div className="analytics__panel-title">Scheduled load</div>
        <div className="analytics__panel-empty">
          {report.reason === 'nothing-measured'
            ? `${report.unmeasured.length} scheduled workflow${
                report.unmeasured.length === 1 ? ' has' : 's have'
              } never run — without a measured duration there is no occupancy to overlap.`
            : 'Nothing in this workspace runs on a schedule.'}
        </div>
      </div>
    )
  }

  const { peak, summary, clock, suggestion } = report
  const peakHour = peak.at ? new Date(peak.at).getUTCHours() : null

  return (
    <div className="analytics__panel">
      <div className="analytics__panel-title">
        Scheduled load
        <span className="analytics__panel-sub">
          {' '}
          · {summary.scheduled} workflow{summary.scheduled === 1 ? '' : 's'} over{' '}
          {report.horizonDays} days
        </span>
      </div>

      <p className="sched__headline">
        At most <strong>{peak.concurrent}</strong> run{peak.concurrent === 1 ? '' : 's'} at once
        {peak.at ? `, ${formatUtc(peak.at)}` : ''}.
      </p>

      <Profile byHour={peak.byHourUtc} peakHour={peakHour} />

      {/* The finding rather than a curiosity: a peak that is an accident of
          everyone independently picking midnight has a cheap fix, and one whose
          load is genuinely that high does not. */}
      {clock.onTheHour > 0 && (
        <p className="sched__note">
          {Math.round(clock.share * 100)}% of scheduled runs start on the hour
          {clock.atMidnight > 0 ? `, ${clock.atMidnight} of them at midnight` : ''}.
        </p>
      )}

      {suggestion && (
        <p className="sched__suggestion">
          Moving <strong>{suggestion.name}</strong> {suggestion.minutes} minutes later would drop
          the peak from {suggestion.peakBefore} to {suggestion.peakAfter}.
        </p>
      )}

      {peak.workflows.length > 0 && (
        <div className="analytics__table-wrap">
          <table className="analytics__table">
            <thead>
              <tr>
                <th>At the peak</th>
                <th>Cron</th>
                <th>Zone</th>
                <th className="analytics__th--num">Holds a slot</th>
              </tr>
            </thead>
            <tbody>
              {peak.workflows.map((w) => (
                <tr key={w.workflowId}>
                  <td>
                    <Link className="analytics__wf-link" to={`/workflow/${w.workflowId}`}>
                      {w.name}
                    </Link>
                  </td>
                  <td>
                    <code className="sched__cron">{w.cron}</code>
                  </td>
                  {/* The zone earns its column: three identical crons are only
                      the same instant if they share one. */}
                  <td className="analytics__muted">{w.timeZone || 'UTC'}</td>
                  <td className="analytics__td--num">{duration(w.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {summary.lowerBound && (
        <p className="sched__note sched__note--warn">
          {summary.unmeasured} scheduled workflow{summary.unmeasured === 1 ? '' : 's'} ha
          {summary.unmeasured === 1 ? 's' : 've'} never run, so this peak is a floor:{' '}
          {report.unmeasured.map((u) => u.name).join(', ')}.
        </p>
      )}
    </div>
  )
}
