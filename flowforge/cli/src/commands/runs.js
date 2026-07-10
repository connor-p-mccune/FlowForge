// flowforge runs <workflow-id> [--limit N] — a workflow's recent runs,
// newest first, as the server summarizes them.

const { table, statusColored, gray, formatDuration } = require('../format')

module.exports = async function runs(args, ctx) {
  const workflowId = args.positionals[0]
  if (!workflowId) {
    ctx.log('Usage: flowforge runs <workflow-id> [--limit N]')
    return 1
  }
  const limit = args.flags.limit ? `?limit=${encodeURIComponent(args.flags.limit)}` : ''
  const { executions } = await ctx.api.get(`/api/v1/workflows/${workflowId}/executions${limit}`)
  if (!executions || executions.length === 0) {
    ctx.log('No runs yet.')
    return 0
  }
  ctx.log(
    table(
      executions.map((run) => ({
        id: gray(run.id),
        status: statusColored(run.status),
        trigger: run.triggerType ?? '',
        started: run.startedAt ?? '',
        duration: formatDuration(run.startedAt, run.finishedAt),
      })),
      [
        { key: 'id', label: 'ID' },
        { key: 'status', label: 'STATUS' },
        { key: 'trigger', label: 'TRIGGER' },
        { key: 'started', label: 'STARTED' },
        { key: 'duration', label: 'DURATION' },
      ]
    )
  )
  return 0
}
