// flowforge import <workspace-id> <file> — create a draft workflow from a
// portable export document (POST /api/v1/workspaces/:id/workflows/import).
// The other half of `flowforge export`: together they let CI promote a
// definition that lives in git into another environment.
//
//   flowforge export 6f0c… > workflows/sync.json      # on staging
//   flowforge import $PROD_WS workflows/sync.json     # on prod
//
// --name overrides the document's name (e.g. suffixing the environment).
// The import lands as a draft — deploying stays a deliberate act in the app.

const fs = require('fs')
const { bold, gray } = require('../format')

module.exports = async function importWorkflow(args, ctx) {
  const [workspaceId, file] = args.positionals
  if (!workspaceId || !file) {
    ctx.log('Usage: flowforge import <workspace-id> <file.json> [--name "New name"]')
    return 1
  }

  let doc
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    ctx.log(`Could not read "${file}": ${err.message}`)
    return 1
  }
  const name = args.flags.name || doc.name
  if (!name || !doc.graph_data) {
    ctx.log('The file is not a workflow export (expected { name, graph_data }).')
    return 1
  }

  const { workflow } = await ctx.api.post(
    `/api/v1/workspaces/${workspaceId}/workflows/import`,
    { name, graph_data: doc.graph_data }
  )
  ctx.log(`Imported ${bold(workflow.name)} as a draft.`)
  ctx.log(gray(`id: ${workflow.id} — review and deploy it in the app.`))
  return 0
}
