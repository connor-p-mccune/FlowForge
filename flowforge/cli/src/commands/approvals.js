// flowforge approvals [--status pending] — what's waiting on a human right
// now, across every workspace the token can see. Pair with `flowforge
// approve <id>` / `flowforge reject <id>`.

const { table, statusColored, gray } = require('../format')

// What the gate asks for beyond one response from anybody. Blank for the
// overwhelming majority of approvals, so the column stays quiet until there is
// something in it worth reading.
function requirementOf(approval) {
  const parts = []
  if (approval.quorum > 1) parts.push(`${approval.quorum} approvals`)
  if (approval.requiredRole === 'owner') parts.push('owner')
  if (approval.separationOfDuties) parts.push('not the requester')
  return parts.join(' · ')
}

module.exports = async function approvals(args, ctx) {
  const status = args.flags.status || 'pending'
  const { approvals: list } = await ctx.api.get(
    `/api/v1/approvals?status=${encodeURIComponent(status)}`
  )
  if (!list || list.length === 0) {
    ctx.log(status === 'pending' ? 'Nothing is waiting for approval.' : `No ${status} approvals.`)
    return 0
  }
  const columns = [
    { key: 'id', label: 'ID' },
    { key: 'workflow', label: 'WORKFLOW' },
    { key: 'message', label: 'MESSAGE' },
    { key: 'status', label: 'STATUS' },
    { key: 'requested', label: 'REQUESTED' },
  ]
  // The column appears only when at least one row has something to put in it —
  // an always-present, usually-empty column is noise in a terminal.
  if (list.some((a) => requirementOf(a))) {
    columns.splice(3, 0, { key: 'requires', label: 'REQUIRES' })
  }
  ctx.log(
    table(
      list.map((a) => ({
        id: gray(a.id),
        workflow: a.workflowName ?? a.workflowId,
        message: a.message ?? '',
        requires: requirementOf(a),
        status: statusColored(a.status),
        requested: a.requestedAt ?? '',
      })),
      columns
    )
  )
  return 0
}
