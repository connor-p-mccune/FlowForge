// flowforge repeats <workflow-id> [--strict] — what happens twice.
//
// Every other check here asks whether one run of a workflow is right. This asks
// what happens when a step runs a second time, which is not a rare event: the
// engine retries most nodes three times by default, on every run, and a retry
// fires on a timeout — exactly the case where the far side may already have
// done the work.
//
// The output leads with the steps the engine repeats *by itself*, because those
// are the ones that need no crash, no resume, and no bad luck beyond a slow
// response. Everything below them is about a worse day.
//
// `--strict` gates on that same number. It is not the whole report on purpose:
// a workflow whose crash recovery would park for a person is working as
// designed, and failing a build for it would teach somebody to stop running
// this.

const { bold, gray, green, red, yellow, cyan, table } = require('../format')

// How each verdict reads in a table, and how loudly.
const VERDICT = {
  unsafe: red('unsafe'),
  unknown: yellow('unknown'),
  opaque: yellow('opaque'),
  billed: cyan('billed'),
  guarded: green('guarded'),
  safe: gray('safe'),
}

// The one-line judgement on the workflow's recovery policy. `resume` is the
// interesting one because it is an assertion about the graph rather than a
// preference, and this is the only place it gets checked.
const RECOVERY = {
  contradicted: (r) =>
    red(`recovery_policy is "${r.policy}", and the graph says otherwise — ${r.why}`),
  unverified: (r) =>
    yellow(`recovery_policy is "${r.policy}", and this cannot confirm it — ${r.why}`),
  'blocks-recovery': (r) =>
    gray(`recovery_policy is "${r.policy}": ${r.why}`),
  consistent: (r) => green(`recovery_policy is "${r.policy}" — ${r.why}`),
}

module.exports = async function repeats(args, ctx) {
  const workflowId = args.positionals[0]
  if (!workflowId) {
    ctx.log('Usage: flowforge repeats <workflow-id> [--strict]')
    return 1
  }

  const report = await ctx.api.get(`/api/v1/workflows/${workflowId}/repeats`)
  if (!report.available) {
    ctx.log('No repeat report: the workflow is empty.')
    return 0
  }

  const { steps, summary, recovery } = report
  if (steps.length === 0) {
    ctx.log(green('Nothing this workflow does would change if a step ran twice.'))
    return 0
  }

  ctx.log(bold(`What happens twice in ${report.name || workflowId}`))
  ctx.log(
    table(
      steps.map((s) => ({
        verdict: VERDICT[s.verdict] || s.verdict,
        node: s.calls ? `${s.label} ${gray(`→ ${s.calls.name}`)}` : s.label,
        // The distinction the whole command turns on: a node the engine
        // retries by itself, against one that needs a crash or a resume.
        when: s.retried ? red(`retried ×${summary.maxAttempts}`) : gray('on resume'),
        why: gray(s.why),
      })),
      [
        { key: 'verdict', label: 'REPEAT' },
        { key: 'node', label: 'NODE' },
        { key: 'when', label: 'WHEN' },
        { key: 'why', label: 'WHY' },
      ]
    )
  )

  ctx.log('')
  ctx.log(`${bold('Recovery:')} ${(RECOVERY[recovery.verdict] || RECOVERY.consistent)(recovery)}`)

  // A declaration the runner cannot send is worse than no declaration: the
  // author believes they are covered. Called out separately because it is the
  // one finding here with a wrong belief attached rather than a missing one.
  if (summary.declaredButUnsendable > 0) {
    ctx.log(
      yellow(
        `\n  ${summary.declaredButUnsendable} node(s) declare "idempotent" on a type that sends no key.`
      ) + gray('\n  The declaration does nothing; the linter flags the same nodes.')
    )
  }

  ctx.log('')
  ctx.log(
    gray(
      `  ${summary.steps} step(s) a repeat would touch · ${summary.unsafe} unsafe · ` +
        `${summary.guarded} guarded · ${summary.billed} billed twice` +
        (summary.unknown + summary.opaque > 0
          ? ` · ${summary.unknown + summary.opaque} the graph does not settle`
          : '')
    )
  )

  if (summary.retriedUnsafe === 0) {
    ctx.log(green('  Nothing the engine retries on its own would do its work twice.'))
    return 0
  }

  const names = steps
    .filter((s) => s.retried && (s.verdict === 'unsafe' || s.verdict === 'unknown'))
    .map((s) => s.label)
  ctx.log(
    red(
      `  ${summary.retriedUnsafe} step(s) the engine retries by itself would repeat their work: ` +
        names.join(', ')
    )
  )
  ctx.log(gray('  No crash needed — a timeout on a request that landed is enough.'))

  return args.flags.strict ? 1 : 0
}
