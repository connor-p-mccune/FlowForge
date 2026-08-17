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
//
// The whole document travels, not just its graph: the declared guarantees,
// because a promotion that dropped them would ship the workflow without the
// assertions that were the reason it passed review, and the signature block,
// because that is what lets the far side answer "is this the definition that was
// approved?". The server reports its verdict and this prints it.

const fs = require('fs')
const { bold, gray, green, yellow, cyan } = require('../format')

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

  // Renaming a signed document invalidates its signature, because the name is
  // part of what was approved — the workflow this lands as is a different thing
  // from the one that was reviewed. Said up front rather than left to a 403.
  if (doc.signature && args.flags.name && args.flags.name !== doc.name) {
    ctx.log(
      yellow(
        `⚠ --name changes what was signed, so the signature will not verify. Re-sign after renaming.`
      )
    )
  }

  const response = await ctx.api.post(`/api/v1/workspaces/${workspaceId}/workflows/import`, {
    name,
    graph_data: doc.graph_data,
    ...(doc.guarantees ? { guarantees: doc.guarantees } : {}),
    ...(doc.signature ? { signature: doc.signature } : {}),
  })

  const { workflow, provenance } = response
  ctx.log(`Imported ${bold(workflow.name)} as a draft.`)
  ctx.log(gray(`id: ${workflow.id} — review and deploy it in the app.`))

  if (provenance) {
    if (provenance.status === 'trusted') {
      ctx.log(
        green(
          `✓ signed by ${provenance.signedBy?.name || 'a trusted key'} ` +
            `(${provenance.signedBy?.fingerprint})`
        )
      )
    } else {
      ctx.log(gray(`signature: ${provenance.status}`))
    }
    ctx.log(gray(`digest: ${cyan(provenance.digest)}`))
  }
  return 0
}
