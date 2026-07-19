// flowforge pause <workflow-id> — the operational kill switch from the
// terminal: while paused, no new real run starts (manual, API, webhook,
// schedule, error-handler). In-flight runs settle normally and dry runs stay
// allowed. Idempotent. Needs a `manage`-scoped token, like promoting a
// definition — deliberately not `trigger`.
//
// Wire it into a deploy window: `flowforge pause <id>` before the maintenance,
// `flowforge resume <id>` after, and no cron tick or webhook fires a run into
// a half-migrated system in between.

const { green } = require('../format')

module.exports = async function pause(args, ctx) {
  const workflowId = args.positionals[0]
  if (!workflowId) {
    ctx.log('Usage: flowforge pause <workflow-id>')
    return 1
  }
  const res = await ctx.api.post(`/api/v1/workflows/${workflowId}/pause`)
  ctx.log(green(`Workflow ${res.workflowId} paused — new runs are held until you resume it.`))
  return 0
}
