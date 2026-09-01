import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch } from '../../services/api'
import Skeleton from '../Skeleton'

// Where a review should start.
//
// Everything else on this page is about *volume* — how many runs, how fast, how
// much they cost. None of it says which workflow matters, because a thousand
// runs that write a log and a thousand that charge a card look identical in a
// bar chart.
//
// This ranks the same workspace by consequence instead: what a run can do to
// the outside world (including the effects inside sub-workflows it calls),
// multiplied by how often it runs. It sits below the charts rather than beside
// them because it answers a different question and mixing the two would suggest
// the numbers compose.

// One outward action a day reads differently from a thousand, and the column
// has to stay scannable: whole numbers above ten, one decimal below, because
// 0.1/day and 0.9/day differ and 431 and 431.4 do not.
const rate = (n) => (n >= 10 ? Math.round(n).toLocaleString() : String(Math.round(n * 10) / 10))

// The interval, collapsed when its ends agree — "412" says more than
// "412 – 412".
function Exposure({ floor, ceiling }) {
  if (ceiling === 0) return <span className="analytics__muted">0</span>
  if (floor === ceiling) return <strong>{rate(ceiling)}</strong>
  return (
    <span>
      <span className="analytics__muted">{rate(floor)}</span>
      <span className="analytics__muted"> – </span>
      <strong>{rate(ceiling)}</strong>
    </span>
  )
}

// The checks, counted and never summed. Four scenarios do not make a workflow
// four units safer — they might all assert the same trivial thing — so this
// lists what exists and stops there. "Nothing" is the finding.
function Assurance({ assurance }) {
  if (!assurance.checked) return <span className="exposure__unchecked">nothing</span>
  const parts = []
  if (assurance.scenarios) parts.push(`${assurance.scenarios} scenario${assurance.scenarios === 1 ? '' : 's'}`)
  if (assurance.guarantees) parts.push(`${assurance.guarantees} guarantee${assurance.guarantees === 1 ? '' : 's'}`)
  if (assurance.assertions) parts.push(`${assurance.assertions} assertion${assurance.assertions === 1 ? '' : 's'}`)
  if (assurance.drift) parts.push('drift')
  return <span className="exposure__checked">{parts.join(', ')}</span>
}

function Row({ row }) {
  return (
    <tr>
      <td className="analytics__td--num">
        <Exposure {...row.exposure} />
      </td>
      <td>
        <Link className="analytics__wf-link" to={`/workflow/${row.workflowId}`}>
          {row.name}
        </Link>
        {/* A called-only workflow scores zero because its consequence was
            charged to its callers. Saying so is the difference between "safe"
            and "counted elsewhere". */}
        {row.attributed && (
          <span className="analytics__muted"> via {row.calledBy.join(', ')}</span>
        )}
      </td>
      <td className="analytics__td--num">
        {row.runs.direct === 0 ? <span className="analytics__muted">—</span> : rate(row.runs.perDay)}
      </td>
      <td className="analytics__td--num">
        {row.effects.total === 0 ? (
          <span className="analytics__muted">none</span>
        ) : (
          <>
            {row.effects.total}
            {row.effects.inherited > 0 && (
              <span className="exposure__offcanvas"> {row.effects.inherited} off-canvas</span>
            )}
          </>
        )}
      </td>
      <td>
        <Assurance assurance={row.assurance} />
      </td>
    </tr>
  )
}

export default function ExposureSection({ workspaceId, days }) {
  const [report, setReport] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    setReport(null)
    setError(null)
    apiFetch(`/api/workspaces/${workspaceId}/exposure?days=${days}`)
      .then((data) => {
        if (!cancelled) setReport(data)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, days])

  if (error) {
    return (
      <div className="analytics__panel exposure__panel">
        <div className="analytics__panel-title">Where a review should start</div>
        <div className="analytics__panel-empty">Unable to load — {error}</div>
      </div>
    )
  }

  if (!report) {
    return (
      <div className="analytics__panel exposure__panel" aria-hidden="true">
        <Skeleton width={200} height={14} />
        <Skeleton height={160} style={{ marginTop: 12 }} />
      </div>
    )
  }

  const { summary } = report
  if (summary.workflows === 0) {
    return (
      <div className="analytics__panel exposure__panel">
        <div className="analytics__panel-title">Where a review should start</div>
        <div className="analytics__panel-empty">
          {summary.unreadable > 0
            ? `No workflow here could be read (${summary.unreadable} unreadable).`
            : 'No workflows in this workspace yet.'}
        </div>
      </div>
    )
  }

  return (
    <div className="analytics__panel exposure__panel">
      <div className="analytics__panel-title">
        Where a review should start
        <span className="analytics__panel-sub">
          {' '}
          · outward actions per day over {report.windowDays} days
        </span>
      </div>

      {/* The line worth repeating: not how many workflows are unchecked, but
          how much of what the workspace does sits on them. */}
      {summary.unchecked > 0 ? (
        <p className="exposure__headline">
          <strong>{Math.round(summary.uncheckedShare * 100)}%</strong> of what this workspace does
          to the outside world sits on {summary.unchecked} workflow
          {summary.unchecked === 1 ? '' : 's'} nothing is checking.
        </p>
      ) : (
        <p className="exposure__headline exposure__headline--clear">
          Every workflow that does anything has something checking it.
        </p>
      )}

      <div className="analytics__table-wrap">
        <table className="analytics__table">
          <thead>
            <tr>
              <th className="analytics__th--num">Per day</th>
              <th>Workflow</th>
              <th className="analytics__th--num">Runs/day</th>
              <th className="analytics__th--num">Reaches</th>
              <th>Checked by</th>
            </tr>
          </thead>
          <tbody>
            {report.workflows.map((row) => (
              <Row key={row.workflowId} row={row} />
            ))}
          </tbody>
        </table>
      </div>

      <p className="exposure__note">
        A range means gates are doing the work: the left number is what a run does whatever
        happens, the right is what it does if every gate goes the effectful way. The order is by
        the right-hand number, because a gate nobody has tested is not evidence.
        {summary.offCanvas > 0 && (
          <>
            {' '}
            {summary.offCanvas} of these effects happen inside a workflow somebody called — no
            single canvas shows them.
          </>
        )}
      </p>
    </div>
  )
}
