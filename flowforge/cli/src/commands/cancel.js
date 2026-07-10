// flowforge cancel <execution-id> — stop a queued or running run. Cooperative
// on the server: the node in flight finishes, the rest is skipped.

module.exports = async function cancel(args, ctx) {
  const executionId = args.positionals[0]
  if (!executionId) {
    ctx.log('Usage: flowforge cancel <execution-id>')
    return 1
  }
  const res = await ctx.api.post(`/api/v1/executions/${executionId}/cancel`)
  ctx.log(
    res.cancelling
      ? `Run ${executionId} is winding down (the node in flight finishes first).`
      : `Run ${executionId} cancelled.`
  )
  return 0
}
