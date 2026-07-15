import { useState } from 'react'

// Side-by-side diff of two runs (GET /api/executions/:id/compare/:otherId).
// One row per node: status → status, the signed duration delta, and whether
// the output changed; a changed row expands to the two outputs side by side.
// Base is always the older run, so the diff reads "what happened since".

function ms(v) {
  if (v == null) return '—'
  if (v < 1000) return `${Math.round(v)}ms`
  return `${(v / 1000).toFixed(1)}s`
}

function Delta({ value }) {
  if (value == null) return <span className="run-compare__delta">—</span>
  if (value === 0) return <span className="run-compare__delta">±0</span>
  const slower = value > 0
  return (
    <span className={`run-compare__delta run-compare__delta--${slower ? 'slower' : 'faster'}`}>
      {slower ? '+' : '−'}{ms(Math.abs(value))}
    </span>
  )
}

function SideOutput({ title, side }) {
  return (
    <div className="run-compare__output">
      <div className="run-compare__output-title">{title}</div>
      <pre className="run-compare__output-body">
        {side ? (side.error ? side.error : JSON.stringify(side.output, null, 2)) : 'did not run'}
      </pre>
    </div>
  )
}

export default function RunComparison({ data, nodes, onBack }) {
  const [openNodeId, setOpenNodeId] = useState(null)
  const { base, other, nodes: rows, summary } = data

  const labelFor = (row) =>
    nodes?.find((n) => n.id === row.nodeId)?.data?.label || row.nodeType || row.nodeId

  const runDelta =
    base.durationMs != null && other.durationMs != null ? other.durationMs - base.durationMs : null

  return (
    <div className="run-compare">
      <div className="exec-history__detail-header">
        <button className="exec-history__back" onClick={onBack}>
          ← All runs
        </button>
      </div>

      <div className="run-compare__header">
        <span className={`status-badge status-badge--${base.status}`}>{base.status}</span>
        <span className="run-compare__header-duration">{ms(base.durationMs)}</span>
        <span className="run-compare__arrow">→</span>
        <span className={`status-badge status-badge--${other.status}`}>{other.status}</span>
        <span className="run-compare__header-duration">{ms(other.durationMs)}</span>
        <Delta value={runDelta} />
      </div>

      <table className="run-compare__table">
        <thead>
          <tr>
            <th>Node</th>
            <th>Base</th>
            <th>This run</th>
            <th>Δ time</th>
            <th>Output</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const changed = row.statusChanged || row.outputChanged
            const open = openNodeId === row.nodeId
            return [
              <tr
                key={row.nodeId}
                className={`run-compare__row${changed ? ' run-compare__row--changed' : ''}`}
                onClick={() => setOpenNodeId(open ? null : row.nodeId)}
              >
                <td className="run-compare__node">{labelFor(row)}</td>
                <td>
                  {row.base ? (
                    <span className={`status-badge status-badge--${row.base.status}`}>
                      {row.base.status}
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
                <td>
                  {row.other ? (
                    <span className={`status-badge status-badge--${row.other.status}`}>
                      {row.other.status}
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
                <td>
                  <Delta value={row.durationDeltaMs} />
                </td>
                <td>
                  {row.base && row.other ? (
                    row.outputChanged ? (
                      <span className="run-compare__changed">changed</span>
                    ) : (
                      <span className="run-compare__same">same</span>
                    )
                  ) : (
                    '—'
                  )}
                </td>
              </tr>,
              open && (
                <tr key={`${row.nodeId}-detail`} className="run-compare__detail">
                  <td colSpan={5}>
                    <div className="run-compare__outputs">
                      <SideOutput title="Base" side={row.base} />
                      <SideOutput title="This run" side={row.other} />
                    </div>
                  </td>
                </tr>
              ),
            ]
          })}
        </tbody>
      </table>

      <p className="run-compare__summary">
        {summary.statusChanges} status change{summary.statusChanges === 1 ? '' : 's'} ·{' '}
        {summary.outputChanges} output change{summary.outputChanges === 1 ? '' : 's'}
        {summary.onlyInBase > 0 && <> · {summary.onlyInBase} only in base</>}
        {summary.onlyInOther > 0 && <> · {summary.onlyInOther} only in this run</>}
        {summary.slowestRegression && (
          <>
            {' '}
            · slowest regression:{' '}
            <strong>
              {nodes?.find((n) => n.id === summary.slowestRegression)?.data?.label ||
                summary.slowestRegression}
            </strong>
          </>
        )}
      </p>
    </div>
  )
}
