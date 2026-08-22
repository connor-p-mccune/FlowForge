// flowforge approve <approval-id> [--note "…"]
// flowforge reject  <approval-id> [--note "…"]
//
// Settle a waiting approval gate — the paused run continues immediately down
// the matching branch. Needs a token with the `approve` scope. Exposed as two
// commands so the intent is on the command line, not buried in a flag.
//
// A gate with a declared quorum may not settle on this response, so the verdict
// is read from `progress.settled` rather than assumed from a 2xx. A script that
// inferred "approved" from a successful call would act on a half-met quorum,
// which is the precise thing four-eyes exists to prevent.

const { green, red, yellow, gray } = require('../format')

function makeRespond(decision) {
  return async function respond(args, ctx) {
    const approvalId = args.positionals[0]
    if (!approvalId) {
      ctx.log(`Usage: flowforge ${decision} <approval-id> [--note "reason"]`)
      return 1
    }
    const body = { decision }
    if (args.flags.note) body.note = String(args.flags.note)

    const { approval, progress } = await ctx.api.post(
      `/api/v1/approvals/${approvalId}/respond`,
      body
    )
    const name = approval?.workflowName ?? approval?.workflowId ?? approvalId

    if (progress && progress.settled === false) {
      ctx.log(
        `${yellow('recorded')} — ${progress.approvals} of ${progress.needed} approvals for "${name}". ` +
          gray('The run is still waiting.')
      )
      return 0
    }

    const verdict = decision === 'approve' ? green('approved') : red('rejected')
    ctx.log(
      `${verdict} — "${name}" continues down the ${
        decision === 'approve' ? 'approved' : 'rejected'
      } branch.`
    )
    return 0
  }
}

module.exports = { approve: makeRespond('approve'), reject: makeRespond('reject') }
