// flowforge resume <execution-id> [--watch] [--interval <seconds>]
//
// Continues a failed or cancelled run from where it stopped. Steps that
// already succeeded are reused (the server marks them 'reused'), so only the
// failed remainder re-executes — an approval that was already granted is not
// asked again. --watch polls the new run to its end and exits non-zero unless
// it completed, same as trigger --watch.

const { watchExecution } = require('../watch')
const { gray } = require('../format')

module.exports = async function resume(args, ctx) {
  const executionId = args.positionals[0]
  if (!executionId) {
    ctx.log('Usage: flowforge resume <execution-id> [--watch]')
    return 1
  }

  const res = await ctx.api.post(`/api/v1/executions/${executionId}/resume`)
  ctx.log(`Run ${res.execution.id} ${res.execution.status} (continues ${res.resumedFrom})`)
  ctx.log(gray(`Poll: ${res.statusUrl}`))

  if (!args.flags.watch) return 0
  const intervalMs = args.flags.interval ? Number(args.flags.interval) * 1000 : 2000
  return watchExecution(ctx.api, res.execution.id, { log: ctx.log, intervalMs })
}
