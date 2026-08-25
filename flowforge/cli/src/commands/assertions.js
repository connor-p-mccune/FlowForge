// flowforge assertions <workflow-id> [--strict]
//
// What this workflow says must never happen, and whether it has.
//
// `verify` checks declared invariants over the *graph* — statically, over every
// execution the graph admits. This checks the ones no graph analysis reaches:
// properties of data and outcomes, judged against the runs that actually
// happened.
//
// **Exits non-zero on a violation *or* on a broken assertion**, and the second
// half is the part worth arguing for. An assertion whose predicate throws on
// every run reports zero violations, so a build gated on violations alone would
// be passing on a check that has never once worked. Broken is not holding.

const { bold, gray, green, red, yellow, cyan, table } = require('../format')

const when = (iso) => (iso ? String(iso).replace('T', ' ').slice(0, 19) : '—')

const STATE = {
  holding: () => green('holding'),
  violated: () => red('VIOLATED'),
  broken: () => yellow('broken'),
  unchecked: () => gray('unchecked'),
}

module.exports = async function assertions(args, ctx) {
  const workflowId = args.positionals[0]
  if (!workflowId) {
    ctx.log('Usage: flowforge assertions <workflow-id> [--strict]')
    return 1
  }

  const report = await ctx.api.get(`/api/v1/workflows/${workflowId}/assertions`)
  const list = report.assertions || []
  const { summary } = report

  if (list.length === 0) {
    ctx.log(gray('This workflow declares nothing that must never happen.'))
    ctx.log(
      gray('  Develop a predicate with `flowforge query`, then pin the one you never want to match.')
    )
    return 0
  }

  ctx.log(bold('What must never happen'))
  ctx.log(
    table(
      list.map((a) => ({
        state: (STATE[a.state] || STATE.unchecked)(),
        name: a.enabled ? a.name : gray(`${a.name} (off)`),
        checked: String(a.checked),
        seen: a.violations > 0 ? red(String(a.violations)) : gray('0'),
      })),
      [
        { key: 'state', label: 'STATE' },
        { key: 'name', label: 'ASSERTION' },
        { key: 'checked', label: 'RUNS' },
        { key: 'seen', label: 'VIOLATIONS' },
      ]
    )
  )

  // The counterexample is the whole value of a violation: a report that said
  // "this happened" without naming the run would leave somebody grepping.
  const violated = list.filter((a) => a.state === 'violated')
  if (violated.length > 0) {
    ctx.log('')
    ctx.log(bold('Counterexamples'))
    for (const a of violated) {
      ctx.log(`  ${red(a.name)}`)
      ctx.log(`    ${gray('predicate')} ${cyan(a.predicate)}`)
      ctx.log(
        `    ${gray('last matched')} ${a.lastViolationExecutionId || '—'}` +
          gray(` at ${when(a.lastViolationAt)}`)
      )
    }
  }

  const broken = list.filter((a) => a.state === 'broken')
  if (broken.length > 0) {
    ctx.log('')
    ctx.log(bold('Never evaluated'))
    for (const a of broken) {
      ctx.log(`  ${yellow(a.name)} ${gray(`— ${a.lastError}`)}`)
    }
    ctx.log(
      gray(
        '  These have thrown on every run and never once completed, so they are reporting\n' +
          '  zero violations without checking anything.'
      )
    )
  }

  ctx.log('')
  ctx.log(
    gray(
      `  ${summary.total} assertion(s) · ${summary.holding} holding · ` +
        `${summary.violated} violated · ${summary.broken} broken · ${summary.unchecked} unchecked`
    )
  )

  // A violation is a failure. So is an assertion nobody can evaluate — gating on
  // violations alone would pass a build whose only check has never worked.
  if (summary.violated > 0 || summary.broken > 0) return 1
  if (args.flags.strict && summary.unchecked > 0) {
    ctx.log(
      yellow(
        `\n${summary.unchecked} assertion(s) have not seen a run yet. ` +
          'Failing because --strict wants every one exercised.'
      )
    )
    return 1
  }
  return 0
}
