// flowforge approvals [--status pending] — what's waiting on a human right
// now, across every workspace the token can see. Pair with `flowforge
// approve <id>` / `flowforge reject <id>`.

const { table, statusColored, gray } = require('../format')

module.exports = async function approvals(args, ctx) {
  const status = args.flags.status || 'pending'
  const { approvals: list } = await ctx.api.get(
    `/api/v1/approvals?status=${encodeURIComponent(status)}`
  )
  if (!list || list.length === 0) {
    ctx.log(status === 'pending' ? 'Nothing is waiting for approval.' : `No ${status} approvals.`)
    return 0
  }
  ctx.log(
    table(
      list.map((a) => ({
        id: gray(a.id),
        workflow: a.workflowName ?? a.workflowId,
        message: a.message ?? '',
        status: statusColored(a.status),
        requested: a.requestedAt ?? '',
      })),
      [
        { key: 'id', label: 'ID' },
        { key: 'workflow', label: 'WORKFLOW' },
        { key: 'message', label: 'MESSAGE' },
        { key: 'status', label: 'STATUS' },
        { key: 'requested', label: 'REQUESTED' },
      ]
    )
  )
  return 0
}
