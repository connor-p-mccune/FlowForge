import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { formatNumber, formatPercent, formatDuration, formatRelative } from './format'

const COLUMNS = [
  { key: 'name', label: 'Workflow', numeric: false },
  { key: 'executions', label: 'Runs', numeric: true },
  { key: 'successRate', label: 'Success', numeric: true },
  { key: 'avgDurationMs', label: 'Avg Duration', numeric: true },
  { key: 'lastRun', label: 'Last Run', numeric: true },
]

function rateClass(rate) {
  if (rate == null) return 'analytics__muted'
  if (rate >= 0.9) return 'analytics__rate--good'
  if (rate >= 0.7) return 'analytics__rate--warn'
  return 'analytics__rate--bad'
}

// Client-side sortable table (the endpoint also accepts ?sort=&order=).
export default function WorkflowsTable({ workflows }) {
  const [sort, setSort] = useState({ key: 'executions', dir: 'desc' })

  const sorted = useMemo(() => {
    const rows = [...workflows]
    rows.sort((a, b) => {
      if (sort.key === 'name') {
        return sort.dir === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name)
      }
      let av = a[sort.key]
      let bv = b[sort.key]
      if (sort.key === 'lastRun') {
        av = av ? new Date(av).getTime() : 0
        bv = bv ? new Date(bv).getTime() : 0
      } else {
        av = av ?? -1
        bv = bv ?? -1
      }
      return sort.dir === 'asc' ? av - bv : bv - av
    })
    return rows
  }, [workflows, sort])

  function toggle(key) {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'name' ? 'asc' : 'desc' }
    )
  }

  return (
    <div className="analytics__table-wrap">
      <table className="analytics__table">
        <thead>
          <tr>
            {COLUMNS.map((c) => (
              <th
                key={c.key}
                className={c.numeric ? 'analytics__th--num' : undefined}
                onClick={() => toggle(c.key)}
              >
                {c.label}
                {sort.key === c.key && (
                  <span className="analytics__sort-ind">{sort.dir === 'asc' ? '▲' : '▼'}</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((w) => (
            <tr key={w.id}>
              <td>
                <Link className="analytics__wf-link" to={`/workflow/${w.id}`}>{w.name}</Link>
              </td>
              <td className="analytics__td--num">{formatNumber(w.executions)}</td>
              <td className={`analytics__td--num ${rateClass(w.successRate)}`}>
                {formatPercent(w.successRate)}
              </td>
              <td className="analytics__td--num">{formatDuration(w.avgDurationMs)}</td>
              <td className="analytics__td--num">{formatRelative(w.lastRun)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
