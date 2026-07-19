// flowforge unpause <workflow-id> — release the kill switch a `pause` set, so
// new runs are accepted again. Idempotent; needs a `manage`-scoped token.
//
// Named `unpause` at the CLI (not `resume`) because `flowforge resume` already
// means "continue a failed *run*". This resumes a paused *workflow* — a
// different subject — so the two commands stay unambiguous.

const { green } = require('../format')

module.exports = async function unpause(args, ctx) {
  const workflowId = args.positionals[0]
  if (!workflowId) {
    ctx.log('Usage: flowforge unpause <workflow-id>')
    return 1
  }
  const res = await ctx.api.post(`/api/v1/workflows/${workflowId}/resume`)
  ctx.log(green(`Workflow ${res.workflowId} resumed — new runs are accepted again.`))
  return 0
}
