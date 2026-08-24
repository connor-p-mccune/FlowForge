// flowforge converge <workflow-id> [--strict] — where parallel branches
// collide, and which of those collisions the graph itself resolves.
//
// A node with several incoming edges gets its input from `Object.assign` over
// the upstream outputs, so when two branches both produce a `status`, exactly
// one survives. The engine picks by longest-path depth — a contributor
// downstream of another overrides it, which is what the canvas looks like it
// means — and that removes every trace of how the graph was stored from the
// answer. What it cannot remove is the ambiguity: two branches at the *same*
// depth are genuinely concurrent, so something arbitrary has to break the tie,
// and here that is the canonical edge sort. Alphabetical. Deterministic, and
// not an opinion about the workflow.
//
// So the report has two halves and only one of them wants attention. Collisions
// the graph settles are listed as settled and cost nobody anything. Ties are
// the finding, and `--strict` is the CI shape: exit non-zero when the graph
// contains a value nothing decides.

const { bold, gray, green, red, yellow, cyan, table } = require('../format')

// Who wins, said in one clause. The winner is the interesting half — the
// contributors are already in the row above it.
function decidedBy(collision) {
  const winner = collision.contributors.find((c) => c.nodeId === collision.decidedBy)
  if (!winner) return yellow('depends on the branch')
  return collision.resolution === 'dataflow'
    ? `${cyan(winner.label)} ${gray('(ran later)')}`
    : `${cyan(winner.label)} ${gray('(alphabetical)')}`
}

module.exports = async function converge(args, ctx) {
  const workflowId = args.positionals[0]
  if (!workflowId) {
    ctx.log('Usage: flowforge converge <workflow-id> [--strict]')
    return 1
  }
  const report = await ctx.api.get(`/api/v1/workflows/${workflowId}/convergence`)

  if (!report.available) {
    ctx.log(
      report.reason === 'cycle'
        ? 'No convergence report: the graph has a cycle, so no run of it happens at all.'
        : 'No convergence report: the workflow is empty.'
    )
    return 0
  }

  const { joins, summary } = report
  if (joins.length === 0) {
    ctx.log(green('No converging branch supplies a field another one also supplies.'))
    return 0
  }

  const rows = []
  for (const join of joins) {
    for (const found of join.collisions) {
      rows.push({
        node: join.label,
        field: found.key,
        from: found.contributors.map((c) => c.label).join(' + '),
        wins: decidedBy(found),
        settled: found.resolution === 'dataflow' ? gray('graph') : red('tie-break'),
      })
    }
  }

  ctx.log(bold('Where parallel branches collide'))
  ctx.log(
    table(rows, [
      { key: 'node', label: 'AT' },
      { key: 'field', label: 'FIELD' },
      { key: 'from', label: 'SUPPLIED BY' },
      { key: 'wins', label: 'WINS' },
      { key: 'settled', label: 'DECIDED BY' },
    ])
  )

  // The two shapes that make a tie worse, called out because a reviewer
  // scanning the table would otherwise have to hold both in their head.
  const shapeShifting = joins.flatMap((j) =>
    j.collisions.filter((c) => !c.sameType && c.resolution === 'tie-break')
      .map((c) => ({ join: j, collision: c }))
  )
  if (shapeShifting.length > 0) {
    ctx.log('')
    ctx.log(bold('Differently shaped, so the winner changes what downstream sees'))
    for (const { join, collision } of shapeShifting) {
      const shapes = collision.contributors.map((c) => `${c.label} ${gray(c.type)}`).join(gray(' vs '))
      ctx.log(`  ${join.label}.${collision.key} ${gray('←')} ${shapes}`)
    }
  }

  ctx.log('')
  ctx.log(
    gray(
      `  ${summary.collisions} collision(s) at ${summary.joins} join(s) · ` +
        `${summary.dataflow} settled by the graph · ${summary.tieBroken} decided by a tie-break`
    )
  )

  if (args.flags.strict && summary.tieBroken > 0) {
    ctx.log(
      red(
        `\n${summary.tieBroken} field(s) are decided by nothing in the graph. ` +
          'Order the branches, or rename one side of the collision.'
      )
    )
    return 1
  }
  return 0
}
