// flowforge export <workflow-id> [--flow] — print the workflow's portable
// document (GET /api/v1/workflows/:id/export) to stdout. Deliberately unix-y:
// redirect it to a file and check it into git, and workflow definitions get
// diffs, history, and code review like everything else.
//
//   flowforge export 6f0c… > workflows/nightly-sync.json
//   flowforge export 6f0c… --flow > workflows/nightly-sync.flow
//
// `--flow` asks for the reviewable text form instead of the JSON. Same
// definition, and the one a human is actually going to read in a pull request:
// nodes sorted by id with their config beneath them, connections gathered at
// the end, and no `exportedAt` — which is the field that makes `git diff` on an
// unchanged workflow non-empty. See docs/DSL.md.

module.exports = async function exportWorkflow(args, ctx) {
  const workflowId = args.positionals[0]
  if (!workflowId) {
    ctx.log('Usage: flowforge export <workflow-id> [--flow]  (redirect stdout to a file)')
    return 1
  }
  if (args.flags.flow) {
    const text = await ctx.api.getText(`/api/v1/workflows/${workflowId}/export?format=flow`)
    ctx.log(text.replace(/\n$/, ''))
    return 0
  }
  const doc = await ctx.api.get(`/api/v1/workflows/${workflowId}/export`)
  ctx.log(JSON.stringify(doc, null, 2))
  return 0
}
