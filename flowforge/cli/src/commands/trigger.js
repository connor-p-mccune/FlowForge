// flowforge trigger <workflow-id> [--data '{"k":"v"}'] [--key <idempotency>]
//                   [--watch] [--interval <seconds>]
//
// Starts a run. --data becomes the trigger payload; --key makes retries safe
// (the server's Idempotency-Key support); --watch polls the run to its end
// and exits non-zero unless it completed — wire it straight into CI.

const { watchExecution } = require('../watch')
const { gray } = require('../format')

module.exports = async function trigger(args, ctx) {
  const workflowId = args.positionals[0]
  if (!workflowId) {
    ctx.log('Usage: flowforge trigger <workflow-id> [--data <json>] [--key <idempotency-key>] [--watch]')
    return 1
  }

  let payload
  if (args.flags.data !== undefined) {
    try {
      payload = JSON.parse(args.flags.data)
    } catch {
      ctx.log('--data must be valid JSON, e.g. --data \'{"orderId": 42}\'')
      return 1
    }
  }

  const headers = args.flags.key ? { 'Idempotency-Key': String(args.flags.key) } : undefined
  const res = await ctx.api.post(`/api/v1/workflows/${workflowId}/trigger`, payload ?? {}, headers)

  const replayed = res.replayed ? ' (replayed — this key already triggered it)' : ''
  ctx.log(`Run ${res.execution.id} ${res.execution.status}${replayed}`)
  ctx.log(gray(`Poll: ${res.statusUrl}`))

  if (!args.flags.watch) return 0
  const intervalMs = args.flags.interval ? Number(args.flags.interval) * 1000 : 2000
  return watchExecution(ctx.api, res.execution.id, { log: ctx.log, intervalMs })
}
