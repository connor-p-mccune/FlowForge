// flowforge forecast <workflow-id> — a predictive estimate of the workflow's
// next-run duration and its likely bottleneck, from GET /api/v1/workflows/:id/forecast.

const { bold, gray, yellow } = require('../format')

function ms(v) {
  if (v == null) return '—'
  if (v < 1000) return `${Math.round(v)}ms`
  if (v < 10_000) return `${(v / 1000).toFixed(1)}s`
  return `${Math.round(v / 1000)}s`
}

module.exports = async function forecast(args, ctx) {
  const workflowId = args.positionals[0]
  if (!workflowId) {
    ctx.log('Usage: flowforge forecast <workflow-id>')
    return 1
  }
  const data = await ctx.api.get(`/api/v1/workflows/${workflowId}/forecast`)

  if (!data.available) {
    ctx.log(data.reason === 'cycle' ? 'No forecast: the graph has a cycle.' : 'No forecast: the workflow is empty.')
    return 0
  }

  ctx.log(bold('Run forecast'))
  ctx.log(`  Estimated       ${ms(data.estimatedMs)} typical   ${gray(`${ms(data.estimatedP95Ms)} at p95`)}`)
  if (data.bottleneck) {
    ctx.log(`  Bottleneck      ${data.bottleneck.nodeId} ${gray(`(${data.bottleneck.nodeType ?? '?'}, ${ms(data.bottleneck.p50)})`)}`)
  }
  const cov = data.coverage
  const pct = cov.workNodes ? Math.round((cov.ratio || 0) * 100) : 0
  const covText = `${cov.nodesWithHistory}/${cov.workNodes} nodes have history (${pct}%)`
  ctx.log(`  Coverage        ${pct < 100 ? yellow(covText) : covText}`)
  if (pct < 100) {
    ctx.log(gray('  Some steps have no timing yet — the estimate will sharpen as the workflow runs.'))
  }
  if (data.criticalPath?.length) {
    ctx.log(`  Critical path   ${gray(data.criticalPath.join(' → '))}`)
  }
  return 0
}
