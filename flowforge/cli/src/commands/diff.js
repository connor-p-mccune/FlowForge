// flowforge diff <workflow-id> <file> — drift detection: compare the live
// workflow against an exported document (POST /api/v1/workflows/:id/diff)
// and exit non-zero when they differ. The missing check in the GitOps loop:
// export/import promote definitions through git, and this answers whether
// production still matches what git says — a promotion someone forgot, or a
// hand-edit someone made in the app.
//
//   flowforge export 6f0c… > workflows/sync.json    # checked into git
//   flowforge diff 6f0c… workflows/sync.json        # CI: fail on drift
//
// The report reads from the file's perspective: "+ added" exists live but
// not in the file, "- removed" is in the file but gone live.

const fs = require('fs')
const { bold, gray, green, red, yellow } = require('../format')

module.exports = async function diff(args, ctx) {
  const [workflowId, file] = args.positionals
  if (!workflowId || !file) {
    ctx.log('Usage: flowforge diff <workflow-id> <file.json>')
    return 1
  }

  let doc
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    ctx.log(`Could not read "${file}": ${err.message}`)
    return 1
  }
  if (!doc.graph_data) {
    ctx.log('The file is not a workflow export (expected { graph_data }).')
    return 1
  }

  const report = await ctx.api.post(`/api/v1/workflows/${workflowId}/diff`, {
    graph_data: doc.graph_data,
  })

  if (report.identical) {
    ctx.log(green(`No drift — the live workflow matches ${file}.`))
    return 0
  }

  ctx.log(red(bold(`Drift detected against ${file}:`)))
  for (const n of report.addedNodes) {
    ctx.log(`  ${green('+')} node ${bold(n.label)} ${gray(`(${n.type}) — live only`)}`)
  }
  for (const n of report.removedNodes) {
    ctx.log(`  ${red('-')} node ${bold(n.label)} ${gray(`(${n.type}) — in the file, gone live`)}`)
  }
  for (const n of report.changedNodes) {
    ctx.log(`  ${yellow('~')} node ${bold(n.label)} ${gray(`(${n.type}): ${n.changes.join(', ')}`)}`)
  }
  for (const e of report.addedEdges) {
    ctx.log(`  ${green('+')} connection ${e.description} ${gray('— live only')}`)
  }
  for (const e of report.removedEdges) {
    ctx.log(`  ${red('-')} connection ${e.description} ${gray('— in the file, gone live')}`)
  }

  const s = report.summary
  const total = s.addedNodes + s.removedNodes + s.changedNodes + s.addedEdges + s.removedEdges
  ctx.log(gray(`${total} difference${total === 1 ? '' : 's'} — re-export to accept the live graph, or re-import to restore the file's.`))
  return 1
}
