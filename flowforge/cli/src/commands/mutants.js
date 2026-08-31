// flowforge mutants <workflow-id> [--strict]
//
// `flowforge test` says whether the suite passes. This says whether passing
// means anything.
//
// It introduces a plausible bug — a condition wired backwards, a threshold off
// by one, an approval gate deleted — and re-runs every check the workflow has.
// A bug nothing catches is a gap in the checks, named precisely: not "coverage
// is 61%" but *"the approval gate can be deleted and every one of your tests
// still passes."*
//
// **Exits non-zero on a survivor only with `--strict`.** A survivor is evidence
// of a gap and not proof of one — an *equivalent* mutant, one that does not
// change behaviour, cannot be killed by anything, and identifying those is
// undecidable in general. Failing a build on a number that has irreducible
// noise in it is how a check earns its way out of a pipeline; the default
// reports and passes, and a team that has read its survivors can turn the gate
// on knowing what it costs.

const { bold, gray, green, red, yellow, cyan, table } = require('../format')

// Who caught it, ordered by how much it is worth. The linter costs nobody
// anything and the author never wrote it; a scenario is a payload somebody had
// to think of.
const CAUGHT_BY = {
  lint: () => gray('the linter'),
  guarantee: () => cyan('a guarantee'),
  test: () => green('a test'),
}

module.exports = async function mutants(args, ctx) {
  const workflowId = args.positionals[0]
  if (!workflowId) {
    ctx.log('Usage: flowforge mutants <workflow-id> [--strict]')
    return 1
  }

  const report = await ctx.api.post(`/api/v1/workflows/${workflowId}/mutations`, {})

  if (!report.available) {
    ctx.log(
      report.reason === 'no-mutations'
        ? 'Nothing to mutate: this workflow has no conditions, gates or removable steps.'
        : 'Nothing to mutate: the workflow is empty.'
    )
    return 0
  }

  const { mutants: list, summary } = report
  const survivors = list.filter((m) => !m.killed)

  ctx.log(bold(`Mutation testing ${report.workflowId}`))
  ctx.log(
    gray(
      `  ${summary.total} plausible bug(s) introduced · checked against ` +
        `${report.scenarios} scenario(s) and ${report.guarantees} guarantee(s)`
    )
  )
  ctx.log('')

  ctx.log(
    table(
      list.map((m) => ({
        verdict: m.killed ? green('caught') : red('MISSED'),
        bug: m.describe,
        by: m.killed ? (CAUGHT_BY[m.by] || (() => m.by))() : gray('—'),
      })),
      [
        { key: 'verdict', label: '' },
        { key: 'bug', label: 'IF THIS WERE THE BUG' },
        { key: 'by', label: 'CAUGHT BY' },
      ]
    )
  )

  if (survivors.length > 0) {
    ctx.log('')
    ctx.log(bold(`${survivors.length} bug(s) nothing would notice`))
    for (const m of survivors) {
      ctx.log(`  ${red('·')} ${m.describe}`)
    }
    ctx.log(
      gray(
        '\n  A scenario that asserts on what the workflow *decided* kills these;\n' +
          '  one that asserts only that the run completed does not.'
      )
    )
  }

  ctx.log('')
  ctx.log(
    gray(
      `  ${summary.killed}/${summary.total} caught (${summary.score}%) · ` +
        `${summary.byLint} by the linter · ${summary.byGuarantee} by a guarantee · ` +
        `${summary.byTest} by a test`
    )
  )

  if (report.scenarios === 0 && report.guarantees === 0) {
    ctx.log(
      yellow(
        '\n  This workflow has no scenarios and no guarantees, so the only thing checking it\n' +
          '  is the linter — and everything the linter cannot see gets through.'
      )
    )
  }

  if (args.flags.strict && survivors.length > 0) {
    ctx.log(
      red(`\n${survivors.length} mutation(s) survived.`) +
        gray(
          '\n  Some may be equivalent — a mutation that cannot change behaviour cannot be\n' +
            '  caught by anything, and no algorithm can tell those apart in general.'
        )
    )
    return 1
  }
  return 0
}
