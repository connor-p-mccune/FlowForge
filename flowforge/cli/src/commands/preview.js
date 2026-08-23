// flowforge preview <workflow-id> <file> [--runs N] [--strict] [--json] —
// what would this change have done to the runs we already had?
// (POST /api/v1/workflows/:id/preview).
//
// The last gate in the promotion sequence, and the only one that is about
// *behaviour* rather than about form:
//
//   flowforge diff    $WF workflows/sync.json    did it change?
//   flowforge lint    $WF workflows/sync.json    will it run?
//   flowforge verify  $WF                        does it still keep its promises?
//   flowforge preview $WF workflows/sync.json    what does it do?
//
// Each replayed run is a dry run against a definition the workflow does not
// hold, with every externally-effectful node settled from that run's own
// recorded output — so nothing fires, nothing is stored, and a routing
// difference is attributable to the change rather than to test mode.
//
// **`--strict` is how this fails a build, and it is opt-in for a reason**: most
// changes are meant to change something, so a diff in behaviour is the expected
// outcome of a deploy, not a defect. Without it the command reports and exits
// 0, which is the right default for a step whose job is to put the consequences
// in front of a reviewer. With it, a pipeline can demand that a promotion be
// behaviourally inert — which is exactly what a refactor, a rename, or a
// config-only edit claims to be.

const { readDocument } = require('../document')
const { bold, gray, red, green, yellow, cyan } = require('../format')

module.exports = async function preview(args, ctx) {
  const [workflowId, file] = args.positionals
  if (!workflowId || !file) {
    ctx.log('Usage: flowforge preview <workflow-id> <file> [--runs N] [--strict] [--json]')
    return 1
  }

  const doc = readDocument(file)
  if (doc.error) {
    ctx.log(red(doc.error))
    return 1
  }

  // A `.flow` file goes over as text and is parsed server-side; a JSON one is
  // reduced to its graph here, tolerating the three shapes an export or a
  // hand-written file takes.
  let payload
  if (doc.isFlow) {
    payload = doc.payload
  } else {
    const document = doc.payload
    const graphData = document?.graph_data || document?.graph || document
    if (!graphData || !Array.isArray(graphData.nodes) || !Array.isArray(graphData.edges)) {
      ctx.log(red(`${file} does not look like an exported workflow (no graph_data.nodes/edges).`))
      return 1
    }
    payload = { graph_data: { nodes: graphData.nodes, edges: graphData.edges } }
  }

  const report = await ctx.api.post(`/api/v1/workflows/${workflowId}/preview`, {
    ...payload,
    ...(args.flags.runs ? { runs: Number(args.flags.runs) } : {}),
  })

  if (args.flags.json) {
    ctx.log(JSON.stringify(report, null, 2))
    return exitCode(report, args.flags.strict)
  }

  if (!report.analysed) {
    ctx.log(gray('No run history to replay — nothing to compare this change against.'))
    return 0
  }

  if (report.changed.length === 0) {
    ctx.log(green(`✓ All ${report.runs} replayed runs behave identically.`))
    if (report.truncated) ctx.log(yellow('The preview ran out of time before replaying them all.'))
    return 0
  }

  ctx.log(
    bold(
      `${report.changed.length} of ${report.runs} replayed runs would behave differently.`
    )
  )
  ctx.log('')

  for (const entry of report.changed) {
    if (entry.error) {
      ctx.log(`${red('!')} ${entry.executionId} ${gray(entry.at)} — ${entry.error}`)
      continue
    }
    ctx.log(`${yellow('~')} ${entry.executionId} ${gray(entry.at)}`)
    if (entry.difference.statusChanged) {
      ctx.log(`    status ${entry.before.status} ${gray('→')} ${entry.after.status}`)
    }
    for (const route of entry.difference.routed) {
      ctx.log(`    ${cyan(route.nodeId)} routes ${fmt(route.before)} ${gray('→')} ${fmt(route.after)}`)
    }
    if (entry.difference.started.length) {
      ctx.log(green(`    now runs: ${entry.difference.started.join(', ')}`))
    }
    if (entry.difference.stopped.length) {
      ctx.log(red(`    no longer runs: ${entry.difference.stopped.join(', ')}`))
    }
  }

  ctx.log('')
  const { summary } = report
  ctx.log(
    gray(
      `${summary.statusChanges} status change${summary.statusChanges === 1 ? '' : 's'} · ` +
        `${summary.routingChanges} rerouted · ` +
        `${summary.nodesStarted.length} node${summary.nodesStarted.length === 1 ? '' : 's'} newly running · ` +
        `${summary.nodesStopped.length} no longer running`
    )
  )
  if (report.truncated) {
    ctx.log(yellow('The preview ran out of time — some runs were not replayed.'))
  }
  if (!args.flags.strict) {
    ctx.log(gray('Pass --strict to fail the build when a promotion changes behaviour.'))
  }

  return exitCode(report, args.flags.strict)
}

const fmt = (value) => (typeof value === 'string' ? `"${value}"` : String(value))

// Behaviour changing is the expected outcome of a deploy, so it fails the build
// only when the caller asked for a behaviourally inert promotion. A replay that
// errored is a different matter and always fails: the preview could not answer.
function exitCode(report, strict) {
  if (!report.analysed) return 0
  if (report.summary?.errors > 0) return 1
  return strict && report.changed.length > 0 ? 1 : 0
}

module.exports.exitCode = exitCode
