// flowforge check <workflow-id> — a reliability gate for CI. Evaluates the
// workflow's current health from its insights (SLA compliance + degradation
// trend, and anomalies under --strict) and exits non-zero if anything fails, so
// a deploy pipeline can block on "is this workflow healthy right now?".
//
//   flowforge check <id> [--min-success-rate PCT] [--max-p95 SECONDS] [--strict]
//
// Thresholds come from the flags if given, otherwise from the workflow's own SLA
// targets. A check with no data to judge (or no threshold) is skipped, not
// failed — an unexercised workflow isn't unhealthy, just unknown.

const { bold, green, red, yellow, gray } = require('../format')

function ms(v) {
  if (v == null) return '—'
  if (v < 1000) return `${Math.round(v)}ms`
  if (v < 10_000) return `${(v / 1000).toFixed(1)}s`
  return `${Math.round(v / 1000)}s`
}
const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)

// One evaluated check. status: 'pass' | 'fail' | 'skip'.
function line(status, label, detail) {
  const mark = status === 'pass' ? green('✓') : status === 'fail' ? red('✗') : gray('–')
  return `  ${mark} ${label}${detail ? gray(`  ${detail}`) : ''}`
}

module.exports = async function check(args, ctx) {
  const workflowId = args.positionals[0]
  if (!workflowId) {
    ctx.log('Usage: flowforge check <workflow-id> [--min-success-rate PCT] [--max-p95 SECONDS] [--strict]')
    return 1
  }
  const data = await ctx.api.get(`/api/v1/workflows/${workflowId}/insights`)
  const sla = data.sla || {}

  // Resolve thresholds: explicit flags win, else the workflow's SLA targets.
  const minSuccess =
    args.flags['min-success-rate'] != null
      ? Number(args.flags['min-success-rate']) / 100
      : sla.minSuccessRate ?? null
  const maxP95Ms =
    args.flags['max-p95'] != null ? Number(args.flags['max-p95']) * 1000 : sla.maxDurationMs ?? null

  const checks = []

  if (minSuccess != null) {
    if (data.successRate == null) {
      checks.push({ status: 'skip', label: 'Success rate', detail: 'no settled runs' })
    } else {
      const ok = data.successRate >= minSuccess
      checks.push({
        status: ok ? 'pass' : 'fail',
        label: 'Success rate',
        detail: `${pct(data.successRate)} vs floor ${pct(minSuccess)}`,
      })
    }
  }

  if (maxP95Ms != null) {
    const p95 = data.duration?.p95
    if (p95 == null) {
      checks.push({ status: 'skip', label: 'p95 duration', detail: 'no completed runs' })
    } else {
      const ok = p95 <= maxP95Ms
      checks.push({
        status: ok ? 'pass' : 'fail',
        label: 'p95 duration',
        detail: `${ms(p95)} vs budget ${ms(maxP95Ms)}`,
      })
    }
  }

  // A significant degrading trend is always a failure — it's the leading
  // indicator the whole feature exists to catch.
  if (data.trend) {
    const degrading = data.trend.direction === 'degrading' && data.trend.significant
    checks.push({
      status: degrading ? 'fail' : 'pass',
      label: 'Duration trend',
      detail: degrading ? 'getting slower over time' : 'steady',
    })
  }

  if (args.flags.strict) {
    const ok = !data.anomalyCount
    checks.push({
      status: ok ? 'pass' : 'fail',
      label: 'Anomalies',
      detail: `${data.anomalyCount || 0} in window`,
    })
  }

  if (checks.length === 0) {
    ctx.log(yellow('No health thresholds to check.'))
    ctx.log(gray('Set SLA targets on the workflow, or pass --min-success-rate / --max-p95.'))
    return 0
  }

  ctx.log(bold(`Health check — ${workflowId}`))
  for (const c of checks) ctx.log(line(c.status, c.label, c.detail))

  const failed = checks.filter((c) => c.status === 'fail').length
  ctx.log('')
  if (failed > 0) {
    ctx.log(red(`✗ ${failed} check${failed === 1 ? '' : 's'} failed`))
    return 1
  }
  ctx.log(green('✓ healthy'))
  return 0
}
