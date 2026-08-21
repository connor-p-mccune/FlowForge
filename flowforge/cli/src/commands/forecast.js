// flowforge forecast <workflow-id> [--cap N] — a predictive estimate of the
// workflow's next-run duration and its likely bottleneck, from
// GET /api/v1/workflows/:id/forecast.
//
// Two estimates, because they answer different questions. The critical path is
// the duration with a slot always free; the makespan under the cap is what will
// actually happen. --cap models a different one without changing anything.

const { bold, gray, yellow, green } = require('../format')

function ms(v) {
  if (v == null) return '—'
  if (v < 1000) return `${Math.round(v)}ms`
  if (v < 10_000) return `${(v / 1000).toFixed(1)}s`
  return `${Math.round(v / 1000)}s`
}

// The concurrency block, when there is anything to say. Silent for a graph
// narrower than the cap: reporting "contention 1.0×" on every chain-shaped
// workflow would train people to skip the section that matters.
function reportConcurrency(c, ctx) {
  if (!c) return
  ctx.log('')
  ctx.log(bold('Under the parallelism cap') + gray(`  (${c.cap} slots)`))

  const contended = c.contention != null && c.contention > 1.01
  const line = `${ms(c.makespanMs)}${c.contention == null ? '' : `  ${c.contention.toFixed(2)}× the critical path`}`
  ctx.log(`  Makespan        ${contended ? yellow(line) : green(line)}`)
  if (c.queuedMs > 0) {
    ctx.log(`  Queued          ${ms(c.queuedMs)} ${gray('spent ready, waiting for a slot')}`)
  }
  if (c.averageParallelism != null) {
    ctx.log(
      `  Usable slots    ${c.averageParallelism.toFixed(2)} ${gray('— the ceiling on any speedup for this graph')}`
    )
  }
  if (c.knee) {
    const helps = c.knee.cap > c.cap
    ctx.log(
      `  Knee            ${helps ? yellow(String(c.knee.cap)) : String(c.knee.cap)} slots → ${ms(c.knee.idealMakespanMs)}` +
        gray(helps ? '  (raising the cap would help)' : '  (the cap is already enough)')
    )
  }

  // The one link people act on: the node that spent longest waiting for a slot
  // rather than for data — a delay with no edge in the graph explaining it.
  const worst = (c.chain || [])
    .filter((l) => l.waitedFor === 'slot' && l.queuedMs > 0)
    .sort((a, b) => b.queuedMs - a.queuedMs)[0]
  if (worst) {
    ctx.log(`  Worst wait      ${worst.nodeId} ${gray(`waited ${ms(worst.queuedMs)} for capacity`)}`)
  }
}

module.exports = async function forecast(args, ctx) {
  const workflowId = args.positionals[0]
  if (!workflowId) {
    ctx.log('Usage: flowforge forecast <workflow-id> [--cap N]')
    return 1
  }
  const cap = args.flags.cap ? `?cap=${encodeURIComponent(args.flags.cap)}` : ''
  const data = await ctx.api.get(`/api/v1/workflows/${workflowId}/forecast${cap}`)

  if (!data.available) {
    ctx.log(data.reason === 'cycle' ? 'No forecast: the graph has a cycle.' : 'No forecast: the workflow is empty.')
    return 0
  }

  ctx.log(bold('Run forecast'))
  ctx.log(`  Critical path   ${ms(data.estimatedMs)} typical   ${gray(`${ms(data.estimatedP95Ms)} at p95`)}`)
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
    ctx.log(`  Longest chain   ${gray(data.criticalPath.join(' → '))}`)
  }

  reportConcurrency(data.concurrency, ctx)
  return 0
}
