// flowforge impact <workflow-id> <file> [--strict] — what does this change
// *mean*?
//
// `diff` tells you the live workflow and your file have drifted. `lint` tells
// you the candidate is valid. `contract` tells you whether it breaks its
// callers. `preview` replays last week's traffic and tells you what the outputs
// would have done. None of them says what the edit does to the properties
// somebody was relying on — and the change that matters most is the one that is
// structurally tiny.
//
// Deleting one edge and wiring a trigger at the node behind it removes an
// approval from a payment path. It is a one-line diff and it passes every other
// check in this CLI.
//
// The exit code splits along the line the report is built on. Findings some
// other gate already refuses — a broken guarantee, an introduced lint error —
// fail the build on their own, because a pipeline that runs this and not those
// should still stop. Everything else is legal and deployable, and `--strict` is
// how a pipeline says it wants to stop for those too.

const { readDocument } = require('../document')
const { bold, gray, green, red, yellow, cyan } = require('../format')

// How each finding reads, and how loudly. The order is the report's, not this
// map's — the server sorts by what a reviewer should read first.
const TONE = {
  'ungated-effect': red,
  'guarantee-broken': red,
  'lint-error': red,
  'unsafe-repeat': yellow,
  'new-effect': yellow,
  'dead-branch': yellow,
  'dynamic-target': yellow,
  'unresolved-tie': yellow,
  'lint-warning': gray,
}

module.exports = async function impact(args, ctx) {
  const [workflowId, file] = args.positionals
  if (!workflowId || !file) {
    ctx.log('Usage: flowforge impact <workflow-id> <file> [--strict]')
    return 1
  }

  // The same reader every other document-taking command uses, so a `.flow`
  // file that can be linted and merged can also be reviewed. It goes over the
  // wire as text and the server parses it, which is why a syntax error arrives
  // carrying the line the parser found.
  const doc = readDocument(file)
  if (doc.error) {
    ctx.log(red(doc.error))
    return 1
  }
  if (!doc.isFlow && !doc.payload.graph_data) {
    ctx.log('The file is not a workflow export (expected { graph_data }).')
    return 1
  }
  const body = doc.isFlow ? doc.payload : { graph_data: doc.payload.graph_data }

  const report = await ctx.api.post(`/api/v1/workflows/${workflowId}/impact`, body)
  if (!report.available) {
    ctx.log('No impact report: the deployed workflow is empty, so there is nothing to compare.')
    return 0
  }

  const { findings, resolved, summary, nodes } = report
  ctx.log(bold(`What this change does to ${report.name || workflowId}`))

  if (findings.length === 0 && resolved.length === 0) {
    ctx.log(green('\n  Nothing this change does alters what the workflow guarantees.'))
    return 0
  }

  for (const f of findings) {
    const paint = TONE[f.code] || yellow
    // The blocking marker earns its column: it is the difference between "some
    // other gate will stop this anyway" and "nothing else is going to say it".
    const mark = f.blocking ? red('!') : ' '
    ctx.log(`\n${mark} ${paint(f.summary)}`)
    ctx.log(gray(`    ${f.detail}`))
  }

  if (resolved.length > 0) {
    ctx.log('')
    ctx.log(bold('What it fixes'))
    for (const r of resolved) ctx.log(`  ${green('✓')} ${r.summary}`)
  }

  // Two findings on two different ids may be one node having been replaced, and
  // nothing in the ids can say so. Printed only when there is a pair that could
  // be misread that way.
  if (nodes.added.length > 0 && nodes.removed.length > 0) {
    ctx.log('')
    ctx.log(
      gray(
        `  ${nodes.added.length} node(s) added and ${nodes.removed.length} removed — a finding ` +
          'reported as both fixed and introduced may be one node redrawn.'
      )
    )
  }

  ctx.log('')
  ctx.log(
    gray(
      `  ${summary.introduced} introduced · ${summary.resolved} resolved · ` +
        `${summary.blocking} another gate already refuses`
    )
  )

  if (summary.blocking > 0) {
    ctx.log(red(`  ${summary.blocking} finding(s) would be refused at deploy anyway.`))
    return 1
  }
  if (summary.review > 0) {
    ctx.log(
      cyan(
        `  ${summary.review} finding(s) are legal and deployable. Nothing else in this CLI says them.`
      )
    )
    return args.flags.strict ? 1 : 0
  }
  return 0
}
