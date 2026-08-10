// flowforge rollback <execution-id> [--yes]
//
// Runs the compensating actions for a failed or cancelled run — refunds,
// releases, deletions — newest side effect first.
//
// Two things about the shape of this command are deliberate.
//
// It **shows the plan before it acts**, and requires `--yes` to act at all.
// Every other CLI command either reads or starts a run the workflow already
// describes; this one fires irreversible effects at production systems from a
// terminal, so the default is a preview. `backfill` sets the same precedent for
// the same reason.
//
// It **exits non-zero on a partial rollback**, not just on a transport error.
// A partial unwind means the world is inconsistent in a known way and a person
// has to look — the exact condition a pipeline should stop for. Exit 0 means
// every compensation took.

const { table, statusColored, gray, green, yellow, red } = require('../format')

function printPlan(ctx, compensations) {
  ctx.log(
    table(
      compensations.map((c) => ({
        seq: gray(String(c.seq)),
        node: c.node_id,
        undoes: c.target_node_id,
        status: statusColored(c.status),
        attempts: c.attempts > 1 ? yellow(`${c.attempts}×`) : gray('1×'),
        error: c.error ?? '',
      })),
      [
        { key: 'seq', label: '#' },
        { key: 'node', label: 'COMPENSATION' },
        { key: 'undoes', label: 'UNDOES' },
        { key: 'status', label: 'STATUS' },
        { key: 'attempts', label: 'TRIES' },
        { key: 'error', label: 'ERROR' },
      ]
    )
  )
}

module.exports = async function rollback(args, ctx) {
  const executionId = args.positionals[0]
  if (!executionId) {
    ctx.log('Usage: flowforge rollback <execution-id> [--yes]')
    return 1
  }

  const { execution, compensations = [] } = await ctx.api.get(`/api/v1/executions/${executionId}`)

  if (execution.status !== 'failed' && execution.status !== 'cancelled') {
    ctx.log(red(`Run ${execution.id} is ${execution.status} — only a failed or cancelled run unwinds.`))
    return 1
  }

  if (compensations.length > 0) {
    ctx.log(`Run ${execution.id} — rollback ${statusColored(execution.rollbackStatus ?? 'none')}`)
    printPlan(ctx, compensations)
    ctx.log('')
  }

  const outstanding = compensations.filter((c) => c.status !== 'succeeded')
  if (compensations.length > 0 && outstanding.length === 0) {
    ctx.log(green('Nothing outstanding — every compensation for this run already succeeded.'))
    return 0
  }

  if (!args.flags.yes) {
    ctx.log(
      outstanding.length > 0
        ? yellow(`${outstanding.length} compensation(s) outstanding.`)
        : yellow('This run has not been unwound yet.')
    )
    ctx.log(gray('Re-run with --yes to execute the compensating actions. They are not reversible.'))
    return 0
  }

  const result = await ctx.api.post(`/api/v1/executions/${executionId}/rollback`)
  ctx.log('')
  ctx.log(
    result.outcome === 'completed'
      ? green(`Rollback completed — ${result.compensations.length} compensation(s) ran.`)
      : red(`Rollback partial — ${result.compensations.filter((c) => c.status === 'failed').length} still failing.`)
  )
  for (const c of result.compensations) {
    ctx.log(
      `  ${statusColored(c.status)} ${c.nodeId ?? c.node_id} undoing ${c.targetNodeId ?? c.target_node_id}` +
        (c.error ? gray(` — ${c.error}`) : '')
    )
  }
  // A partial rollback leaves the world inconsistent in a known way. That is
  // exactly the condition a pipeline should stop for.
  return result.outcome === 'completed' ? 0 : 1
}
