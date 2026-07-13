// flowforge insights <workflow-id> [--limit N] — the workflow's run-insights
// rollup from GET /api/v1/workflows/:id/insights: success rate, duration
// percentiles, throughput, the slowest steps, and any anomalous runs.

const { table, bold, gray, red, green, yellow } = require('../format')

// Duration trend → a coloured one-liner. Only a confirmed degradation is
// alarming; a confirmed improvement is good; everything else reads as steady.
function trendLine(trend) {
  if (!trend) return null
  if (trend.direction === 'degrading' && trend.significant) return red('↗ slower over time')
  if (trend.direction === 'improving' && trend.significant) return green('↘ faster over time')
  return yellow('→ steady')
}

// Milliseconds → a compact human string. '—' for null so an empty stat reads as
// "no data" rather than "0ms".
function ms(v) {
  if (v == null) return '—'
  if (v < 1000) return `${Math.round(v)}ms`
  if (v < 10_000) return `${(v / 1000).toFixed(1)}s`
  return `${Math.round(v / 1000)}s`
}

function pct(v) {
  return v == null ? '—' : `${(v * 100).toFixed(1)}%`
}

module.exports = async function insights(args, ctx) {
  const workflowId = args.positionals[0]
  if (!workflowId) {
    ctx.log('Usage: flowforge insights <workflow-id> [--limit N]')
    return 1
  }
  const limit = args.flags.limit ? `?limit=${encodeURIComponent(args.flags.limit)}` : ''
  const data = await ctx.api.get(`/api/v1/workflows/${workflowId}/insights${limit}`)
  const { window, counts, successRate, throughput, duration, anomalyCount, slowestSteps, recentRuns } = data

  if (!window || window.runs === 0) {
    ctx.log('No runs yet.')
    return 0
  }

  ctx.log(bold('Run insights') + gray(`  (${window.runs} runs)`))
  ctx.log(
    `  Success rate   ${pct(successRate)}   ` +
      gray(`${counts.completed} ok · ${counts.failed} failed · ${counts.cancelled} cancelled`)
  )
  ctx.log(`  Throughput     ${throughput.perDay == null ? '—' : `${throughput.perDay}/day`}`)
  ctx.log(`  Anomalies      ${anomalyCount ? red(String(anomalyCount)) : '0'}`)
  const trend = trendLine(data.trend)
  if (trend) ctx.log(`  Trend          ${trend}`)

  ctx.log('')
  ctx.log(bold('Duration (completed runs)'))
  ctx.log(
    table(
      [{ p50: ms(duration.p50), p90: ms(duration.p90), p95: ms(duration.p95), p99: ms(duration.p99), max: ms(duration.max) }],
      [
        { key: 'p50', label: 'P50' },
        { key: 'p90', label: 'P90' },
        { key: 'p95', label: 'P95' },
        { key: 'p99', label: 'P99' },
        { key: 'max', label: 'MAX' },
      ]
    )
  )

  if (slowestSteps && slowestSteps.length) {
    ctx.log('')
    ctx.log(bold('Slowest steps'))
    ctx.log(
      table(
        slowestSteps.map((s) => ({
          node: gray(s.nodeId),
          type: s.nodeType ?? '',
          avg: ms(s.avgDurationMs),
          max: ms(s.maxDurationMs),
        })),
        [
          { key: 'node', label: 'NODE' },
          { key: 'type', label: 'TYPE' },
          { key: 'avg', label: 'AVG' },
          { key: 'max', label: 'MAX' },
        ]
      )
    )
  }

  const flagged = (recentRuns || []).filter((r) => r.isAnomaly)
  if (flagged.length) {
    ctx.log('')
    ctx.log(bold('Anomalous runs'))
    ctx.log(
      table(
        flagged.map((r) => ({
          id: gray(r.id),
          duration: ms(r.durationMs),
          score: red(r.anomalyScore == null ? '' : r.anomalyScore.toFixed(1)),
          severity: r.severity,
        })),
        [
          { key: 'id', label: 'ID' },
          { key: 'duration', label: 'DURATION' },
          { key: 'score', label: 'Z-SCORE' },
          { key: 'severity', label: 'SEVERITY' },
        ]
      )
    )
  }
  return 0
}
