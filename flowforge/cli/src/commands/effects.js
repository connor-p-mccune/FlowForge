// flowforge effects <workflow-id> [--ungated] — what a run of this workflow can
// do to the outside world, and what has to be true first.
//
// The question a promotion review opens with, and the one no other command here
// answers: `lint` is about a node's config, `types` about a value's shape,
// `lineage` about where a value came from, `verify` about a property somebody
// thought to declare, `paths` about which branches an input can take. None of
// them says *"this can charge a card, and only if the approval was granted"*.
//
// `--ungated` is the CI shape: exit non-zero when an effect has no
// preconditions at all. A workflow that reaches a payments API on every run is
// a legitimate thing to want, and it is also exactly what a gate somebody
// routed around looks like — so the gate is opt-in per pipeline rather than a
// judgement this makes for everybody.
//
// `--deep` follows sub-workflow calls. Without it, a call is one line reading
// "calls workflow 4f2a", which is true and tells a reviewer nothing: the
// workflow they are reviewing can charge a card, three boxes and one call away.
// With it, the call is expanded into what the callee actually does, and each
// effect's preconditions are the *conjunction* of the caller's gate on the call
// and the callee's gate on the effect.

const { bold, gray, green, red, yellow, cyan, table } = require('../format')

// A short, sortable badge per effect kind. The kind is what a reviewer scans
// for first — "does this send email?" — so it leads each row.
const KIND_LABEL = {
  http: 'http',
  email: 'email',
  slack: 'slack',
  'sub-workflow': 'workflow',
  model: 'model',
}

// The conditions as one readable clause. Empty for an unconditional effect,
// where the *absence* is the finding.
function conditionsOf(effect) {
  if (effect.always) return red('always')
  return effect.conditions.map((c) => `${c.label} = ${cyan(c.outcome)}`).join(' and ')
}

// Where the effect actually lives, when that is not the workflow being asked
// about. The chain is what makes an inherited effect legible: "Charge card" in
// a report about Orders is confusing until it says it is reached through
// Fulfilment.
function whereOf(effect) {
  if (!effect.via || effect.via.length === 0) return ''
  return gray(` via ${effect.via.map((v) => v.name).join(' → ')}`)
}

module.exports = async function effects(args, ctx) {
  const workflowId = args.positionals[0]
  if (!workflowId) {
    ctx.log('Usage: flowforge effects <workflow-id> [--deep] [--ungated]')
    return 1
  }
  // Two endpoints, one question. `reach` returns the same effect shape with a
  // `via` chain and workflow-attributed conditions, so everything below reads
  // either without knowing which it got.
  const report = await ctx.api.get(
    `/api/v1/workflows/${workflowId}/${args.flags.deep ? 'reach' : 'effects'}`
  )

  if (!report.available) {
    ctx.log(
      report.reason === 'cycle'
        ? 'No effect report: the graph has a cycle, so no run of it happens at all.'
        : 'No effect report: the workflow is empty.'
    )
    return 0
  }

  const { effects: list, summary, decisions } = report
  if (list.length === 0) {
    ctx.log(green('This workflow reaches nothing outside FlowForge.'))
    return 0
  }

  ctx.log(bold('What a run can do'))
  ctx.log(
    table(
      list.map((e) => ({
        kind: KIND_LABEL[e.kind] || e.kind,
        node: `${e.label}${whereOf(e)}`,
        target: e.target ?? yellow('dynamic'),
        when: conditionsOf(e),
      })),
      [
        { key: 'kind', label: 'KIND' },
        { key: 'node', label: 'NODE' },
        { key: 'target', label: 'REACHES' },
        { key: 'when', label: 'WHEN' },
      ]
    )
  )

  // The inverse, and the sentence somebody actually says out loud: *if this
  // rejects, what can still happen?*
  // The inverse view is a per-graph one: "if this rejects, what can still
  // happen" is a question about one set of decisions, and composing it across a
  // call chain would be a different report rather than this one with more rows.
  const gating = (decisions || []).filter((d) => d.outcomes.some((o) => o.gates.length > 0))
  if (gating.length > 0) {
    ctx.log('')
    ctx.log(bold('What each decision rules out'))
    for (const decision of gating) {
      for (const outcome of decision.outcomes) {
        if (outcome.gates.length === 0) continue
        const names = outcome.gates.map((id) => list.find((e) => e.nodeId === id)?.label || id)
        ctx.log(
          `  ${decision.label} ${gray('≠')} ${cyan(outcome.name)} ${gray('→')} ` +
            `${names.join(', ')} ${gray('cannot happen')}`
        )
      }
    }
  }

  ctx.log('')
  if (args.flags.deep) {
    // The number the shallow report would have given, beside the one this gave,
    // so the difference is a fact rather than something to work out.
    ctx.log(
      gray(
        `  ${summary.total} effects · ${summary.direct} in this workflow · ` +
          `${summary.inherited} reached through ${summary.workflows} other workflow(s) · ` +
          `${summary.unconditional} on every run`
      )
    )
    for (const stop of report.unresolved || []) {
      ctx.log(
        yellow(
          `  Not followed (${stop.reason}): ${stop.workflowId}` +
            (stop.reason === 'not-visible' ? ' — this token cannot see it' : '')
        )
      )
    }
  } else {
    ctx.log(
      gray(
        `  ${summary.total} effects · ${summary.gated} gated · ${summary.unconditional} on every run` +
          (summary.dynamicTargets
            ? ` · ${summary.dynamicTargets} whose destination the graph does not determine`
            : '')
      )
    )
    if (list.some((e) => e.kind === 'sub-workflow')) {
      ctx.log(
        gray('  A sub-workflow call is one line here and an entire workflow at run time — --deep expands it.')
      )
    }
  }

  if (args.flags.ungated && summary.unconditional > 0) {
    const names = list.filter((e) => e.always).map((e) => e.label).join(', ')
    ctx.log(red(`\n${summary.unconditional} effect(s) run unconditionally: ${names}`))
    return 1
  }
  return 0
}
