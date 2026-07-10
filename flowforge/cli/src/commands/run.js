// flowforge run <execution-id> [--watch] — one run with its steps. --watch
// keeps polling until the run settles and exits non-zero unless it completed.

const { watchExecution } = require('../watch')
const { table, statusColored, gray, formatDuration } = require('../format')

module.exports = async function run(args, ctx) {
  const executionId = args.positionals[0]
  if (!executionId) {
    ctx.log('Usage: flowforge run <execution-id> [--watch]')
    return 1
  }

  if (args.flags.watch) {
    const intervalMs = args.flags.interval ? Number(args.flags.interval) * 1000 : 2000
    return watchExecution(ctx.api, executionId, { log: ctx.log, intervalMs })
  }

  const { execution, steps } = await ctx.api.get(`/api/v1/executions/${executionId}`)
  const duration = formatDuration(execution.startedAt, execution.finishedAt)
  ctx.log(`Run ${execution.id} — ${statusColored(execution.status)}${duration ? ` in ${duration}` : ''}`)
  if (steps && steps.length > 0) {
    ctx.log(
      table(
        steps.map((step) => ({
          status: statusColored(step.status),
          node: step.node_id,
          type: gray(step.node_type ?? ''),
          duration: formatDuration(step.started_at, step.finished_at),
          error: step.error ?? '',
        })),
        [
          { key: 'status', label: 'STATUS' },
          { key: 'node', label: 'NODE' },
          { key: 'type', label: 'TYPE' },
          { key: 'duration', label: 'DURATION' },
          { key: 'error', label: 'ERROR' },
        ]
      )
    )
  }
  return execution.status === 'failed' ? 1 : 0
}
