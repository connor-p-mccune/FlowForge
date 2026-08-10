// flowforge types <workflow-id> [--node <id>] [--json] — the inferred data
// schema of a workflow (GET /api/v1/workflows/:id/types).
//
// The question this answers is "what can I reference here?", asked from a
// terminal instead of a canvas. Every node's input and output shape is derived
// from the runners' contracts and propagated across the graph, so it holds for
// a workflow that has never run — unlike anything reconstructed from history.
//
// --node narrows to one node and lists its full reference paths, which is the
// form you actually paste into a config: `{{http-1.body}}`. --json prints the
// machine-readable lattice for a script to diff across a promotion.
//
// Exits non-zero when the analysis found a type error, so it doubles as a
// narrower CI gate than `lint` when that is all you want to fail on.

const { bold, gray, red, yellow, green, cyan } = require('../format')

module.exports = async function types(args, ctx) {
  const [workflowId] = args.positionals
  if (!workflowId) {
    ctx.log('Usage: flowforge types <workflow-id> [--node <node-id>] [--json]')
    return 1
  }

  const report = await ctx.api.get(`/api/v1/workflows/${workflowId}/types`)

  if (args.flags.json) {
    ctx.log(JSON.stringify(report, null, 2))
    return report.diagnostics.some((d) => d.severity === 'error') ? 1 : 0
  }

  const only = args.flags.node
  if (only) {
    const entry = report.nodes[only]
    if (!entry) {
      ctx.log(red(`No node "${only}" in this workflow.`))
      return 1
    }
    ctx.log(`${bold(only)}`)
    ctx.log(`  ${gray('in ')} ${entry.input.described}`)
    ctx.log(`  ${gray('out')} ${entry.output.described}`)
    if (entry.output.fields.length > 0) {
      ctx.log('')
      ctx.log(gray('  references:'))
      for (const field of entry.output.fields) {
        const mark = field.optional ? gray(' (optional)') : ''
        ctx.log(`    ${cyan(`{{${only}.${field.path}}}`)} ${gray(field.type)}${mark}`)
      }
    }
    return 0
  }

  if (report.order.length === 0) {
    ctx.log(gray('Nothing to analyse — the graph is empty or contains a cycle.'))
    return 0
  }

  for (const nodeId of report.order) {
    const entry = report.nodes[nodeId]
    ctx.log(`${bold(nodeId.padEnd(18))} ${entry.output.described}`)
  }

  const errors = report.diagnostics.filter((d) => d.severity === 'error')
  const warnings = report.diagnostics.filter((d) => d.severity === 'warning')
  if (errors.length === 0 && warnings.length === 0) {
    ctx.log('')
    ctx.log(green('No type problems.'))
    return 0
  }

  ctx.log('')
  for (const finding of [...errors, ...warnings]) {
    const badge = finding.severity === 'error' ? red('error  ') : yellow('warning')
    ctx.log(`  ${badge} ${finding.message} ${gray(`[${finding.nodeId}]`)}`)
  }
  return errors.length > 0 ? 1 : 0
}
