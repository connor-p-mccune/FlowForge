// flowforge query <workflow-id> "<fxl>" [--limit N] [--explain] [--json]
//
// The command this whole feature exists for. `insights`, `regressions` and
// `drift` each answer one fixed question well; this answers the one somebody
// has at 3am, which is always specific and never anticipated:
//
//   flowforge query 6f0c… 'status == "failed" and steps.charge.output.status >= 500'
//   flowforge query 6f0c… 'durationMs > 60000 and trigger.order.total > 1000'
//
// The predicate is FXL — the same language as a condition node — so there is
// nothing new to learn and the whole stdlib is available.
//
// **Exits 1 when the query matches nothing.** That reads oddly for a search
// until you notice what it makes possible: `flowforge query <id> 'status ==
// "failed"' && page-oncall` is a monitor, and a query language whose exit code
// carries the answer composes with everything else in a pipeline. A malformed
// predicate exits 2, so a script can tell "no results" from "you typed it
// wrong" — the distinction `grep` gets right and most tools do not.

const { bold, gray, green, red, yellow, cyan, table } = require('../format')

const ms = (value) => {
  if (value == null) return '—'
  if (value < 1000) return `${Math.round(value)}ms`
  if (value < 60000) return `${(value / 1000).toFixed(1)}s`
  return `${(value / 60000).toFixed(1)}m`
}

const when = (iso) => (iso ? String(iso).replace('T', ' ').slice(0, 19) : '—')

const STATUS_COLOUR = {
  completed: green,
  failed: red,
  cancelled: yellow,
  running: cyan,
}

// A caret under the character the parser stopped at. The position is the whole
// value of a syntax error — without it somebody counts brackets.
function caret(source, position) {
  if (position == null || position < 0) return null
  return `  ${source}\n  ${' '.repeat(Math.min(position, source.length))}^`
}

module.exports = async function query(args, ctx) {
  const workflowId = args.positionals[0]
  const where = args.positionals.slice(1).join(' ')
  if (!workflowId || !where.trim()) {
    ctx.log('Usage: flowforge query <workflow-id> "<fxl predicate>" [--limit N] [--explain]')
    ctx.log('')
    ctx.log(gray('  status == "failed" and steps.charge.output.status >= 500'))
    ctx.log(gray('  durationMs > 60000 and trigger.order.total > 1000'))
    ctx.log(gray('  "charge" in steps and steps.charge.status == "failed"'))
    return 2
  }

  let result
  try {
    result = await ctx.api.post(`/api/v1/workflows/${workflowId}/query`, {
      where,
      limit: args.flags.limit != null ? Number(args.flags.limit) : undefined,
    })
  } catch (err) {
    // A predicate that does not parse comes back as a 400 carrying the
    // position. Exit 2 rather than 1: "you typed it wrong" is not "no results".
    const body = err.body || {}
    ctx.log(red(`Could not parse the predicate: ${body.error || err.message}`))
    const pointer = caret(where, body.position)
    if (pointer) ctx.log(gray(pointer))
    return 2
  }

  if (args.flags.json) {
    ctx.log(JSON.stringify(result, null, 2))
    return result.runs.length > 0 ? 0 : 1
  }

  const { runs, plan } = result

  if (runs.length === 0) {
    ctx.log(gray(`No runs match. ${plan.scanned} scanned.`))
    if (plan.evaluationErrors > 0) {
      // The difference between "nothing matched" and "nothing could be
      // evaluated", which a bare zero would hide.
      ctx.log(
        yellow(
          `  ${plan.evaluationErrors} run(s) could not be evaluated — the predicate threw on ` +
            'their shape. Check the field names.'
        )
      )
    }
    if (plan.truncated) {
      ctx.log(yellow(`  Stopped after ${plan.scanned}; there may be older matches.`))
    }
    return 1
  }

  ctx.log(
    table(
      runs.map((run) => ({
        when: when(run.createdAt),
        run: run.id.slice(0, 8),
        status: (STATUS_COLOUR[run.status] || ((s) => s))(run.status),
        took: ms(run.durationMs),
        waited: run.waitMs ? ms(run.waitMs) : gray('—'),
      })),
      [
        { key: 'when', label: 'WHEN' },
        { key: 'run', label: 'RUN' },
        { key: 'status', label: 'STATUS' },
        { key: 'took', label: 'TOOK' },
        { key: 'waited', label: 'QUEUED' },
      ]
    )
  )

  ctx.log('')
  ctx.log(
    gray(
      `  ${plan.matched} match(es) from ${plan.scanned} run(s) scanned` +
        (plan.truncated ? ' · stopped at the scan cap, older matches may exist' : '')
    )
  )

  if (args.flags.explain) {
    ctx.log('')
    ctx.log(bold('Plan'))
    if (plan.pushedDown.length > 0) {
      ctx.log(`  ${gray('narrowed in SQL by')} ${plan.pushedDown.map(cyan).join(gray(', '))}`)
    } else {
      // Worth saying loudly: this is the difference between an indexed lookup
      // and reading every run the workflow has ever had.
      ctx.log(
        yellow('  nothing could be narrowed in SQL — every run was read and evaluated.') +
          '\n' +
          gray('  Conjuncts under a not, an or, or a conditional are never pushed down.')
      )
    }
    ctx.log(
      `  ${gray('step rows')} ${plan.loadedSteps ? 'loaded per candidate run' : gray('not needed')}`
    )
    if (plan.evaluationErrors > 0) {
      ctx.log(`  ${yellow(`${plan.evaluationErrors} run(s) threw during evaluation`)}`)
    }
  }

  return 0
}
