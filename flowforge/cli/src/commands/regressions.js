// flowforge regressions <workflow-id> [--limit N] [--json] — when this
// workflow's duration changed, and what changed with it
// (GET /api/v1/workflows/:id/regressions).
//
// `insights` reports a trend, which is a direction. This reports a **date**, a
// size, the step that moved, and the deploy that landed in the gap — which is
// the difference between "it's getting slower" and something somebody can open.
//
// The natural place for it is straight after a promotion:
//
//   flowforge release $WF --promote
//   flowforge regressions $WF
//
// It exits non-zero only on a change *for the worse*, so the build fails on the
// regression its own deploy caused and the message names the version. An
// improvement is reported and passes; a history too short to analyse passes,
// because failing every young workflow's build is how a check gets removed.

const { bold, gray, red, green, yellow, cyan } = require('../format')

module.exports = async function regressions(args, ctx) {
  const [workflowId] = args.positionals
  if (!workflowId) {
    ctx.log('Usage: flowforge regressions <workflow-id> [--limit N] [--json]')
    return 1
  }

  const query = args.flags.limit ? `?limit=${encodeURIComponent(args.flags.limit)}` : ''
  const report = await ctx.api.get(`/api/v1/workflows/${workflowId}/regressions${query}`)

  if (args.flags.json) {
    ctx.log(JSON.stringify(report, null, 2))
    return report.ok ? 0 : 1
  }

  if (!report.analysed) {
    ctx.log(gray(`Not enough completed runs to analyse (${report.runs || 0} so far).`))
    return 0
  }

  if (report.changePoints.length === 0) {
    ctx.log(green(`✓ No change in duration across the last ${report.runs} runs.`))
    return 0
  }

  for (const change of report.changePoints) {
    const worse = change.direction === 'worse'
    const arrow = worse ? red('↑') : green('↓')
    const size = change.ratio ? `${change.ratio.toFixed(1)}×` : `${Math.abs(Math.round(change.delta))}ms`
    ctx.log(
      `${arrow} ${bold(`${ms(change.before.median)} → ${ms(change.after.median)}`)} ` +
        `${worse ? red(`(${size} slower)`) : green(`(${size} faster)`)} ` +
        gray(`at ${change.at}`)
    )
    ctx.log(
      gray(
        `    ${change.before.runs} runs before, ${change.after.runs} after · ` +
          `p=${change.pValue.toExponential(1)}`
      )
    )

    if (change.cause === 'external') {
      // The most useful finding in the list, because it is the one that stops
      // somebody re-reading a diff that explains nothing.
      ctx.log(yellow('    nothing was deployed in this window — the cause is outside this workflow'))
    } else {
      for (const deploy of change.deploys) {
        const who = deploy.createdBy ? ` by ${deploy.createdBy}` : ''
        ctx.log(`    ${cyan(`version ${deploy.version}`)}${gray(` deployed ${deploy.createdAt}${who}`)}`)
        for (const node of deploy.changed?.changedNodes || []) {
          ctx.log(gray(`      changed ${node.label}: ${node.changes.join(', ')}`))
        }
        if (deploy.changed?.addedNodes?.length) {
          ctx.log(gray(`      added ${deploy.changed.addedNodes.join(', ')}`))
        }
        if (deploy.changed?.removedNodes?.length) {
          ctx.log(gray(`      removed ${deploy.changed.removedNodes.join(', ')}`))
        }
      }
      if (change.cause === 'ambiguous') {
        ctx.log(gray('    more than one deploy landed in this window'))
      }
    }

    for (const step of change.steps) {
      ctx.log(
        gray(`    step ${step.nodeId}: ${ms(step.before)} → ${ms(step.after)}`)
      )
    }
    ctx.log('')
  }

  return report.ok ? 0 : 1
}

function ms(value) {
  if (value == null) return '—'
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`
}
