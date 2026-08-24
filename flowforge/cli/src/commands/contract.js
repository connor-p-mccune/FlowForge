// flowforge contract <workflow-id> [file] [--strict]
//
// A workflow's return type is a promise to the workflows that call it as a
// sub-workflow, and the author who breaks that promise is not the author who
// finds out. Rename a field in the return node and the workflow still lints,
// the dependency graph still resolves, and somebody else's `{{sub.orderId}}`
// quietly starts arriving `undefined`.
//
// With a file, this is the promotion gate: would importing that definition
// break anybody in the target workspace? Without one, it reads the current
// promise and who depends on it — the question somebody asks *before* editing.
//
// Two levels, and only one is a build failure. `breaking` describes the shape:
// a field went, a type grew, a required field became optional. `broken` counts
// callers whose reference stops resolving. A contract can narrow with nobody
// relying on the part that went, and stopping a deployment for that is how a
// check earns its way out of a pipeline. `--strict` fails on the shape too, for
// a team that treats the contract itself as the artefact.

const { bold, gray, green, red, yellow, cyan } = require('../format')
const { readDocument } = require('../document')

const VERDICT = {
  breaking: red('breaking'),
  additive: cyan('additive'),
  compatible: green('compatible'),
}

// The shape change, as the lines somebody would write in a changelog.
function describeChange(change, ctx) {
  const lines = []
  for (const f of change.removed) lines.push(`  ${red('−')} ${f.path} ${gray(`(was ${f.was})`)}`)
  for (const f of change.widened) {
    lines.push(`  ${yellow('~')} ${f.path} ${gray(`${f.was} → ${f.now}`)}`)
  }
  for (const f of change.weakened) {
    lines.push(`  ${yellow('?')} ${f.path} ${gray('is no longer always present')}`)
  }
  for (const f of change.added) lines.push(`  ${green('+')} ${f.path} ${gray(`(${f.now})`)}`)
  if (lines.length === 0) return
  ctx.log(bold('What changed'))
  for (const line of lines) ctx.log(line)
}

module.exports = async function contract(args, ctx) {
  const workflowId = args.positionals[0]
  if (!workflowId) {
    ctx.log('Usage: flowforge contract <workflow-id> [file] [--strict]')
    return 1
  }

  const file = args.positionals[1]
  let report
  if (file) {
    const doc = readDocument(file)
    if (doc.error) {
      ctx.log(doc.error)
      return 1
    }
    const body = doc.isFlow
      ? doc.payload
      : { graph_data: doc.payload.graph_data || doc.payload }
    report = await ctx.api.post(`/api/v1/workflows/${workflowId}/contract`, body)
  } else {
    report = await ctx.api.get(`/api/v1/workflows/${workflowId}/contract`)
  }

  if (!report.available) {
    ctx.log(
      report.reason === 'unreadable'
        ? "This workflow's stored graph could not be read, so it has no contract to compare."
        : 'Workflow not found.'
    )
    return 1
  }

  const { change, callers, summary } = report
  const broken = callers.filter((c) => c.breaks.length > 0)

  ctx.log(bold(`Contract for ${report.name}`))
  ctx.log(`  ${gray('returns')} ${report.after.describe}`)
  if (file) {
    ctx.log(`  ${gray('change')}  ${VERDICT[change.verdict] || change.verdict}`)
  }
  ctx.log('')

  if (file) {
    describeChange(change, ctx)
    if (change.removed.length || change.widened.length || change.weakened.length || change.added.length) {
      ctx.log('')
    }
  }

  if (callers.length === 0) {
    ctx.log(gray('Nothing in this workspace calls this workflow.'))
    return change.verdict === 'breaking' && args.flags.strict ? 1 : 0
  }

  if (broken.length === 0) {
    ctx.log(
      `${green('✓')} ${callers.length} caller${callers.length === 1 ? '' : 's'}, ` +
        'every reference still resolves.'
    )
    for (const caller of callers) ctx.log(gray(`    ${caller.name}`));
  } else {
    ctx.log(bold(`${summary.references} reference(s) would stop resolving`))
    for (const caller of broken) {
      ctx.log(`  ${red(caller.name)}`)
      for (const b of caller.breaks) {
        ctx.log(
          `    ${gray('{{')}${cyan(b.reference)}${gray('}}')} in ${b.label}` +
            gray(` — no "${b.missing}"`) +
            (b.suggestion ? gray(`; did you mean "${b.suggestion}"?`) : '')
        )
      }
    }
    const untouched = callers.length - broken.length
    if (untouched > 0) {
      ctx.log(gray(`\n  ${untouched} other caller(s) unaffected.`))
    }
  }

  ctx.log('')
  ctx.log(
    gray(
      `  ${summary.callers} caller(s) · ${summary.broken} broken · ` +
        `contract is ${change.verdict}`
    )
  )

  if (summary.broken > 0) return 1
  if (args.flags.strict && change.verdict === 'breaking') {
    ctx.log(
      yellow(
        '\nThe contract narrowed, though nobody references the part that went. ' +
          'Failing because --strict treats the contract itself as the artefact.'
      )
    )
    return 1
  }
  return 0
}
