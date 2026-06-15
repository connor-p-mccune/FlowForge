import { formatNumber, formatPercent, formatDuration } from './format'

export default function SummaryCards({ summary }) {
  const cards = [
    {
      label: 'Total Executions',
      value: formatNumber(summary.totalExecutions),
      sub: `${formatNumber(summary.successful)} completed · ${formatNumber(summary.failed)} failed`,
    },
    {
      label: 'Success Rate',
      value: formatPercent(summary.successRate),
      sub: summary.running ? `${formatNumber(summary.running)} still running` : 'of all runs in range',
    },
    {
      label: 'Avg Duration',
      value: formatDuration(summary.avgDurationMs),
      sub: 'per execution',
    },
  ]

  return (
    <div className="analytics__cards">
      {cards.map((c) => (
        <div key={c.label} className="analytics__card">
          <div className="analytics__card-label">{c.label}</div>
          <div className="analytics__card-value">{c.value}</div>
          <div className="analytics__card-sub">{c.sub}</div>
        </div>
      ))}
    </div>
  )
}
