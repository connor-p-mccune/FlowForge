// flowforge export <workflow-id> — print the workflow's portable document
// (GET /api/v1/workflows/:id/export) to stdout as pretty JSON. Deliberately
// unix-y: redirect it to a file and check it into git, and workflow
// definitions get diffs, history, and code review like everything else.
//
//   flowforge export 6f0c… > workflows/nightly-sync.json

module.exports = async function exportWorkflow(args, ctx) {
  const workflowId = args.positionals[0]
  if (!workflowId) {
    ctx.log('Usage: flowforge export <workflow-id>  (redirect stdout to a file)')
    return 1
  }
  const doc = await ctx.api.get(`/api/v1/workflows/${workflowId}/export`)
  ctx.log(JSON.stringify(doc, null, 2))
  return 0
}
