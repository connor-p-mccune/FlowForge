// flowforge merge <workflow-id> <file> [--yes] [--ours|--theirs] [--base <v>]
//
// The step `diff` stops one short of. `diff` tells you git and production have
// diverged; this reconciles them, keeping both sides' work instead of making
// you pick one to throw away.
//
//   flowforge export 6f0c… > workflows/sync.json   # checked into git
//   flowforge diff  6f0c… workflows/sync.json      # CI: drift detected
//   flowforge merge 6f0c… workflows/sync.json      # preview the reconciliation
//   flowforge merge 6f0c… workflows/sync.json --yes
//
// Two shape decisions, both mirroring how the merge itself behaves.
//
// It **previews by default**. A merge rewrites a workflow definition that may
// be running in production, so seeing the result before it lands is the
// default, exactly as with `backfill` and `rollback`.
//
// It **exits 2 on conflicts**, distinct from 1. A conflict is not a failure —
// it is a merge that needs a person, and a pipeline that treats "needs review"
// identically to "broken" cannot tell the difference between a colleague's edit
// and an outage. `release` already uses 2 for the same reason.

const fs = require('fs')
const { bold, gray, green, red, yellow } = require('../format')

function readDocument(file, ctx) {
  let doc
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    ctx.log(red(`Could not read "${file}": ${err.message}`))
    return null
  }
  if (!doc.graph_data) {
    ctx.log(red('The file is not a workflow export (expected { graph_data }).'))
    return null
  }
  return doc
}

module.exports = async function merge(args, ctx) {
  const [workflowId, file] = args.positionals
  if (!workflowId || !file) {
    ctx.log('Usage: flowforge merge <workflow-id> <file.json> [--yes] [--ours|--theirs] [--base <version>]')
    return 1
  }
  if (args.flags.ours && args.flags.theirs) {
    ctx.log(red('Pick one of --ours or --theirs, not both.'))
    return 1
  }

  const doc = readDocument(file, ctx)
  if (!doc) return 1

  const strategy = args.flags.ours ? 'ours' : args.flags.theirs ? 'theirs' : 'manual'
  const body = { graph_data: doc.graph_data, strategy, apply: Boolean(args.flags.yes) }
  if (args.flags.base) body.baseVersion = args.flags.base

  const report = await ctx.api.post(`/api/v1/workflows/${workflowId}/merge`, body)

  const baseLabel = report.base?.version
    ? `version ${report.base.version}`
    : report.base?.note || 'an empty base'
  ctx.log(gray(`Merging ${file} into the live workflow, against ${baseLabel}.`))

  const s = report.summary || {}
  ctx.log(
    `  ${green(`+${s.added ?? 0}`)} added   ` +
      `${yellow(`~${s.changed ?? 0}`)} changed   ` +
      `${red(`-${s.removed ?? 0}`)} removed   ` +
      gray(`${s.unchanged ?? 0} unchanged`)
  )

  for (const dropped of report.droppedEdges || []) {
    ctx.log(
      yellow(`  ! connection ${dropped.source} → ${dropped.target} dropped — ${dropped.reason}`)
    )
  }

  if (!report.clean) {
    ctx.log('')
    ctx.log(red(bold(`${report.conflicts.length} conflict${report.conflicts.length === 1 ? '' : 's'} — nothing was written:`)))
    for (const c of report.conflicts) ctx.log(`  ${red('✗')} ${c.description}`)
    ctx.log('')
    ctx.log(
      gray('Resolve them on the canvas, or re-run with --ours (keep the live value) or --theirs (take the file’s).')
    )
    // Distinct from 1: a conflict is a merge that needs a person, not a broken
    // command. A pipeline that conflates the two can't tell a colleague's edit
    // from an outage.
    return 2
  }

  if (report.lint && report.lint.errors > 0) {
    ctx.log('')
    ctx.log(red(`The merged graph has ${report.lint.errors} lint error(s):`))
    for (const issue of report.lint.issues.filter((i) => i.severity === 'error')) {
      ctx.log(`  ${red('⛔')} ${issue.message}`)
    }
  } else if (report.lint && report.lint.warnings > 0) {
    ctx.log(gray(`The merged graph lints clean (${report.lint.warnings} warning(s)).`))
  }

  ctx.log('')
  if (report.applied) {
    ctx.log(green('Merged into the live workflow. Deploy when you’re ready — merging changed the canvas, not what’s running.'))
    return report.lint && report.lint.errors > 0 ? 1 : 0
  }

  ctx.log(green('Merges cleanly.'))
  ctx.log(gray('Re-run with --yes to write it to the live workflow.'))
  return 0
}
