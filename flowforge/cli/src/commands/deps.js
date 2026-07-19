// flowforge deps <workflow-id> — cross-workflow impact analysis. Prints what a
// workflow calls (sub-workflow / for-each nodes, error handler), what calls it,
// and any stale cross-workflow reference cycle it sits on.
//
// Exits non-zero when the workflow is on a cycle, so a CI check can catch a
// broken A→B→A reference before a run hits it. Otherwise 0.

const { table, statusColored, gray, yellow, red } = require('../format')

function printGroup(ctx, title, edges) {
  if (!edges || edges.length === 0) {
    ctx.log(gray(`${title}: none`))
    return
  }
  ctx.log(`${title}:`)
  ctx.log(
    table(
      edges.map((e) => ({
        id: gray(e.id),
        name: e.name,
        status: statusColored(e.status),
        via: e.via.join(', '),
      })),
      [
        { key: 'name', label: 'NAME' },
        { key: 'status', label: 'STATUS' },
        { key: 'via', label: 'VIA' },
        { key: 'id', label: 'ID' },
      ]
    )
  )
}

module.exports = async function deps(args, ctx) {
  const workflowId = args.positionals[0]
  if (!workflowId) {
    ctx.log('Usage: flowforge deps <workflow-id>')
    return 1
  }
  const res = await ctx.api.get(`/api/v1/workflows/${workflowId}/dependencies`)

  printGroup(ctx, 'Calls (this depends on)', res.dependsOn)
  ctx.log('')
  printGroup(ctx, 'Called by (depends on this)', res.dependedOnBy)

  if (res.cycle && res.cycle.length) {
    ctx.log('')
    ctx.log(red(`⚠ Cross-workflow cycle: ${res.cycle.join(' → ')}`))
    ctx.log(yellow('  This would fail at run time with a circular-reference error.'))
    return 1
  }
  return 0
}
