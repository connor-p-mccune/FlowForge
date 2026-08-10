// flowforge release <workflow-id> [--promote] [--rollback] [--wait <seconds>]
//
// Progressive delivery from a pipeline. Without a flag it reports the running
// canary and **exits by the recommendation** — 0 to promote, 1 to roll back, 2
// to keep waiting — so a CI job is `if flowforge release $ID; then …` and
// nothing has to parse a p-value in bash.
//
// Exit 2 for "wait" rather than 1 is the deliberate part: a pipeline that
// treats "not enough evidence yet" as failure will roll back every healthy
// release that happens to be young, which is the opposite of what a canary is
// for. Three states need three codes.
//
// --wait polls until the recommendation stops being `wait`, for the job that
// deploys the canary and then blocks on the verdict.

const { bold, gray, red, green, yellow } = require('../format')

const EXIT = { promote: 0, rollback: 1, wait: 2 }

const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)

function renderArm(ctx, label, subtitle, stats) {
  const bound = stats.failureRateInterval
    ? gray(` (≤ ${pct(stats.failureRateInterval.upper)})`)
    : ''
  ctx.log(
    `  ${bold(label.padEnd(7))} ${gray(subtitle.padEnd(18))} ` +
      `${String(stats.runs).padStart(5)} runs   ${pct(stats.failureRate).padStart(6)} failed${bound}`
  )
}

function render(ctx, report) {
  if (!report.active) {
    ctx.log(gray('No canary is running for this workflow.'))
    return
  }
  const colour = report.recommendation === 'rollback'
    ? red
    : report.recommendation === 'promote'
      ? green
      : yellow
  ctx.log(bold(`Canary · ${report.percent}% of runs · ${report.state}`))
  ctx.log(`  ${colour(report.verdict)} — ${report.reason}`)
  ctx.log('')
  renderArm(ctx, 'canary', 'new definition', report.canary)
  renderArm(ctx, 'stable', 'deployed version', report.stable)
  if (report.successTest) {
    ctx.log(gray(`  failure rate  p = ${report.successTest.pValue.toFixed(4)}`))
  }
  if (report.durationTest) {
    ctx.log(gray(`  duration      p = ${report.durationTest.pValue.toFixed(4)}`))
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

module.exports = async function release(args, ctx) {
  const [workflowId] = args.positionals
  if (!workflowId) {
    ctx.log('Usage: flowforge release <workflow-id> [--promote] [--rollback] [--wait <seconds>]')
    return 1
  }

  if (args.flags.promote) {
    const result = await ctx.api.post(`/api/v1/workflows/${workflowId}/canary/promote`, {})
    ctx.log(green(`Promoted as version ${result.version}.`))
    return 0
  }

  if (args.flags.rollback) {
    const reason = typeof args.flags.rollback === 'string' ? args.flags.rollback : undefined
    const result = await ctx.api.post(`/api/v1/workflows/${workflowId}/canary/rollback`, { reason })
    ctx.log(yellow(`Rolled back: ${result.reason}. The canary definition is unchanged.`))
    return 0
  }

  const deadline = args.flags.wait
    ? Date.now() + Math.max(0, Number(args.flags.wait)) * 1000
    : null

  for (;;) {
    const report = await ctx.api.get(`/api/v1/workflows/${workflowId}/canary`)
    if (!report.active) {
      render(ctx, report)
      return 1
    }
    const done = report.recommendation !== 'wait' || !deadline || Date.now() >= deadline
    if (done) {
      render(ctx, report)
      if (report.recommendation === 'wait' && deadline) {
        ctx.log(gray('Gave up waiting for a verdict.'))
      }
      return EXIT[report.recommendation] ?? 2
    }
    await sleep(10000)
  }
}

module.exports.EXIT = EXIT
