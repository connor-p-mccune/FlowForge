// flowforge explain <execution-id> — why did this run do what it did?
//
// `run` lists a run's steps and their statuses. It will tell you the email step
// says `skipped`, which is the fact somebody already has when they come asking.
// This says *why*: the decision that closed the path to it, the outcome that
// decision took, and — for an FXL condition — the values it read to take it.
//
// The runtime counterpart to `effects`. That one says what a run could do and
// what would have to be true first; this says what one run did, and which of
// those conditions decided it.
//
// `--node <id>` narrows to one node, which is how the question is actually
// asked: nobody wants a run explained, they want to know why *that* did not
// happen.

const { bold, gray, green, red, yellow, cyan } = require('../format')

const MARK = {
  succeeded: green('ran'),
  failed: red('failed'),
  skipped: yellow('skipped'),
}

// The sentence. Three reasons a step does not run, in the order they answer the
// question: a decision chose against it, something above it failed and the run
// never got there, or somebody stopped the run.
function why(step, ctx) {
  const b = step.because
  if (!b) {
    ctx.log(gray('    nothing in this run accounts for it'))
    return
  }
  if (b.kind === 'upstream-failure') {
    ctx.log(`    ${cyan(b.label)} failed above it, so the run never got here`)
    if (b.error) ctx.log(gray(`      ${b.error}`))
    return
  }
  if (b.kind === 'cancelled') {
    // Not a graph fact at all, which is exactly why it has to be said.
    ctx.log(gray('    the run was cancelled before it got here'))
    return
  }
  ctx.log(`    ${cyan(b.label)} was ${cyan(String(b.outcome))}, and that branch does not reach it`)
  if (b.expression) {
    const reads = b.reads.map((r) => `${r.path} was ${r.value}`).join(', ')
    ctx.log(gray(`      ${b.expression}${reads ? ` — ${reads}` : ''}`))
  }
}

module.exports = async function explain(args, ctx) {
  const executionId = args.positionals[0]
  if (!executionId) {
    ctx.log('Usage: flowforge explain <execution-id> [--node <node-id>]')
    return 1
  }

  const report = await ctx.api.get(`/api/v1/executions/${executionId}/explain`)
  if (!report.available) {
    ctx.log(
      report.reason === 'workflow-gone'
        ? 'The workflow this run belongs to has been deleted, so there is no graph to explain it against.'
        : 'Nothing to explain: the run has no graph.'
    )
    return 0
  }

  const { steps, decisions, summary } = report

  // The narrow form, which is how the question is actually asked.
  const wanted = args.flags.node
  if (wanted) {
    const step = steps.find((s) => s.nodeId === wanted || s.label === wanted)
    if (!step) {
      ctx.log(red(`No node "${wanted}" in this run.`))
      return 1
    }
    ctx.log(`${bold(step.label)} ${MARK[step.status] || gray(step.status)}`)
    if (step.status === 'failed' && step.error) ctx.log(red(`    ${step.error}`))
    if (step.status === 'skipped' || step.status === 'not-reached') why(step, ctx)
    return 0
  }

  ctx.log(bold(`Why ${report.name || report.workflowId} did what it did`) + gray(`  ·  ${report.status}`))

  // Decisions first: they are the causes, and every skipped step below points
  // back at one of them.
  if (decisions.length > 0) {
    ctx.log('')
    ctx.log(bold('What each decision decided'))
    for (const d of decisions) {
      if (!d.outcome) {
        ctx.log(`  ${d.label} ${gray(`— ${d.status}, so it decided nothing`)}`)
        continue
      }
      const closed = d.closed.length > 0 ? gray(` (closing ${d.closed.join(', ')})`) : ''
      ctx.log(`  ${d.label} ${gray('→')} ${cyan(d.outcome)}${closed}`)
      if (d.expression) {
        const reads = d.reads.map((r) => `${r.path} was ${r.value}`).join(', ')
        ctx.log(gray(`      ${d.expression}${reads ? ` — ${reads}` : ''}`))
      }
    }
  }

  const missing = steps.filter((s) => s.status === 'skipped' || s.status === 'not-reached')
  if (missing.length > 0) {
    ctx.log('')
    ctx.log(bold('What did not run'))
    for (const step of missing) {
      ctx.log(`  ${step.label}`)
      why(step, ctx)
    }
  }

  const failed = steps.filter((s) => s.status === 'failed')
  for (const step of failed) {
    ctx.log('')
    ctx.log(`${red('Failed:')} ${step.label}`)
    if (step.error) ctx.log(gray(`    ${step.error}`))
  }

  ctx.log('')
  ctx.log(
    gray(
      `  ${summary.ran} ran · ${summary.skipped} skipped · ${summary.failed} failed · ` +
        `${summary.decisions} decision(s)`
    )
  )
  // Said rather than hidden: a report claiming to explain everything that
  // quietly does not is worse than one that says which rows it could not.
  if (summary.unexplained > 0) {
    ctx.log(
      yellow(`  ${summary.unexplained} skipped step(s) no settled decision in this run accounts for.`)
    )
  }
  return 0
}
