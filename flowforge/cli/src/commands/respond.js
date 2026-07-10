// flowforge approve <approval-id> [--note "…"]
// flowforge reject  <approval-id> [--note "…"]
//
// Settle a waiting approval gate — the paused run continues immediately down
// the matching branch. Needs a token with the `approve` scope. Exposed as two
// commands so the intent is on the command line, not buried in a flag.

const { green, red } = require('../format')

function makeRespond(decision) {
  return async function respond(args, ctx) {
    const approvalId = args.positionals[0]
    if (!approvalId) {
      ctx.log(`Usage: flowforge ${decision} <approval-id> [--note "reason"]`)
      return 1
    }
    const body = { decision }
    if (args.flags.note) body.note = String(args.flags.note)

    const { approval } = await ctx.api.post(`/api/v1/approvals/${approvalId}/respond`, body)
    const verdict = decision === 'approve' ? green('approved') : red('rejected')
    ctx.log(
      `${verdict} — "${approval.workflowName ?? approval.workflowId}" continues down the ${
        decision === 'approve' ? 'approved' : 'rejected'
      } branch.`
    )
    return 0
  }
}

module.exports = { approve: makeRespond('approve'), reject: makeRespond('reject') }
