// flowforge lint <workflow-id> [file] [--strict] — the workflow linter as a
// CI gate (POST /api/v1/workflows/:id/lint). Without a file, lints the
// workflow as deployed; with a file, lints that exported document against
// the workflow's workspace — its real secret names, variable names, and
// sub-workflow targets — so a definition can be vetted *before* import:
//
//   flowforge lint 6f0c…                       # is the live workflow clean?
//   flowforge lint 6f0c… workflows/sync.json   # will this file run there?
//
// Exits non-zero on any error-severity issue; --strict fails on warnings
// too. Same rules as the app's 🔎 Issues panel, because it is the same
// linter.

const fs = require('fs')
const { bold, gray, red, yellow, green } = require('../format')

module.exports = async function lint(args, ctx) {
  const [workflowId, file] = args.positionals
  if (!workflowId) {
    ctx.log('Usage: flowforge lint <workflow-id> [file.json] [--strict]')
    return 1
  }

  let body = {}
  if (file) {
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
    body = { graph_data: doc.graph_data }
  }

  const report = await ctx.api.post(`/api/v1/workflows/${workflowId}/lint`, body)
  const target = file || 'the live workflow'

  for (const issue of report.issues) {
    const badge = issue.severity === 'error' ? red('error  ') : yellow('warning')
    const where = issue.nodeId ? gray(` [${issue.nodeId}]`) : ''
    ctx.log(`  ${badge} ${issue.message}${where}`)
  }

  const { errors, warnings } = report.summary
  if (errors === 0 && warnings === 0) {
    ctx.log(green(`No issues — ${target} lints clean.`))
    return 0
  }

  const counts = []
  if (errors) counts.push(red(`${errors} error${errors === 1 ? '' : 's'}`))
  if (warnings) counts.push(yellow(`${warnings} warning${warnings === 1 ? '' : 's'}`))
  ctx.log(bold(`${counts.join(', ')} in ${target}.`))

  if (errors > 0) return 1
  if (args.flags.strict && warnings > 0) {
    ctx.log(gray('Failing on warnings (--strict).'))
    return 1
  }
  return 0
}
