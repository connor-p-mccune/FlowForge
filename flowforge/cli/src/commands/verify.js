// flowforge verify <workflow-id> — check the workflow's declared path
// invariants (GET /api/v1/workflows/:id/guarantees).
//
// A different gate from `flowforge lint`, and the difference is worth stating
// because a pipeline usually wants both: lint asks *will this run?*, verify
// asks *does it still do what its author swore it did?*. A workflow can lint
// perfectly and have grown a second trigger that reaches the card charge
// without passing the approval — every node valid, every type checked, and the
// gate now optional.
//
// Exits non-zero on a violated invariant **and** on one that can no longer be
// checked, because a guarantee whose check quietly stopped running is the
// failure this is here to catch: delete the node it names and it stops failing
// forever.
//
// --facts additionally prints what is true of the graph regardless of what
// anyone declared, and --suggest prints the invariants that hold today and look
// deliberate — the ones worth pinning before an edit removes them.

const { bold, gray, red, green, yellow, cyan } = require('../format')

const MARK = { holds: green('✓'), violated: red('✗'), unknown: yellow('?') }

module.exports = async function verify(args, ctx) {
  const [workflowId] = args.positionals
  if (!workflowId) {
    ctx.log('Usage: flowforge verify <workflow-id> [--facts] [--suggest] [--json]')
    return 1
  }

  const report = await ctx.api.get(`/api/v1/workflows/${workflowId}/guarantees`)

  if (args.flags.json) {
    ctx.log(JSON.stringify(report, null, 2))
    return report.ok ? 0 : 1
  }

  if (report.analysed === false) {
    ctx.log(yellow(`⚠ ${report.reason === 'cycle' ? 'The graph contains a cycle' : 'The graph is empty'} — nothing can be verified against it.`))
  }

  if (report.results.length === 0) {
    ctx.log(gray('No guarantees declared.'))
    if (report.suggestions?.length) {
      ctx.log('')
      printSuggestions(ctx, report.suggestions)
    }
    return 0
  }

  for (const result of report.results) {
    ctx.log(`${MARK[result.status] || '?'} ${result.statement}`)
    if (result.note) ctx.log(gray(`    ${result.note}`))
    if (result.status === 'holds') {
      if (result.evidence) ctx.log(gray(`    ${result.evidence}`))
      continue
    }
    ctx.log(`    ${result.status === 'violated' ? red(result.message) : yellow(result.message)}`)
    if (result.counterexample?.length) {
      ctx.log(gray(`    counterexample: ${result.counterexample.join(' → ')}`))
    }
  }

  if (args.flags.facts && report.facts) {
    ctx.log('')
    ctx.log(bold('Always runs'))
    ctx.log(
      report.facts.alwaysRuns.length
        ? `  ${report.facts.alwaysRuns.map((f) => f.label).join(', ')}`
        : gray('  nothing — every node is behind a decision')
    )
    if (report.facts.decisions.length) {
      ctx.log(bold('Decisions'))
      for (const d of report.facts.decisions) {
        ctx.log(`  ${d.label} ${gray(`→ ${d.outcomes.join(' | ')}`)}`)
      }
    }
  }

  if (args.flags.suggest && report.suggestions?.length) {
    ctx.log('')
    printSuggestions(ctx, report.suggestions)
  }

  const broken = report.results.filter((r) => r.status !== 'holds').length
  ctx.log('')
  ctx.log(
    broken === 0
      ? green(`${report.results.length} guarantee${report.results.length === 1 ? '' : 's'} hold`)
      : red(`${broken} of ${report.results.length} guarantees no longer hold`)
  )
  return report.ok ? 0 : 1
}

function printSuggestions(ctx, suggestions) {
  ctx.log(bold('True today, and worth pinning'))
  for (const s of suggestions) {
    ctx.log(`  ${cyan(s.kind.padEnd(9))} ${s.statement}`)
  }
}
