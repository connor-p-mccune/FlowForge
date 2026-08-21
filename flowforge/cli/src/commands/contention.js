// flowforge contention <execution-id> [--max <ratio>] — where a finished run's
// time went: work, or waiting for an execution slot.
//
// The critical path already names the chain of steps that set a run's duration.
// It cannot explain a node that was ready at 1.2s and started at 4.0s, because
// the answer is not in the graph — the node was waiting for capacity, and
// whoever was holding it is frequently on an unrelated branch. This reads
// GET /api/v1/executions/:id/schedule, which measures that from the recorded
// timestamps.
//
// --max turns it into a CI gate: exit non-zero when the run took more than
// `ratio` times what it could have at unlimited capacity. A pipeline that
// asserts a duration cannot tell "the work got slower" from "the box was busy";
// this can.

const { bold, gray, red, yellow, green, table } = require('../format')

function ms(v) {
  if (v == null) return '—'
  if (v < 1000) return `${Math.round(v)}ms`
  if (v < 10_000) return `${(v / 1000).toFixed(1)}s`
  return `${Math.round(v / 1000)}s`
}

module.exports = async function contention(args, ctx) {
  const executionId = args.positionals[0]
  if (!executionId) {
    ctx.log('Usage: flowforge contention <execution-id> [--max <ratio>]')
    return 1
  }
  const data = await ctx.api.get(`/api/v1/executions/${executionId}/schedule`)
  if (!data.available) {
    ctx.log('No schedule analysis: the run recorded no steps.')
    return 0
  }

  const { observed, idealMakespanMs, cap, atCap } = data
  const ratio = idealMakespanMs > 0 ? observed.makespanMs / idealMakespanMs : null
  const queuedShare = observed.makespanMs > 0 ? observed.queuedMs / observed.makespanMs : 0

  ctx.log(bold('Where the time went') + gray(`  (${cap} slots)`))
  ctx.log(`  Wall time       ${ms(observed.makespanMs)}`)
  ctx.log(`  Work            ${ms(observed.workMs)} ${gray('across all slots')}`)
  const queueLine = `${ms(observed.queuedMs)}${queuedShare > 0 ? ` ${gray(`(${Math.round(queuedShare * 100)}% of wall time)`)}` : ''}`
  ctx.log(`  Queued          ${observed.queuedMs > 0 ? yellow(queueLine) : green(queueLine)}`)
  if (observed.utilisation != null) {
    ctx.log(`  Utilisation     ${Math.round(observed.utilisation * 100)}%`)
  }
  if (ratio != null) {
    const text = `${ms(idealMakespanMs)}  ${gray(`— this run was ${ratio.toFixed(2)}× that`)}`
    ctx.log(`  Floor           ${text}`)
  }

  // Every node that waited on capacity rather than on data, worst first. This
  // is the actionable list: each row is a delay the graph does not explain.
  const waits = Object.entries(data.perNode || {})
    .filter(([, n]) => n.queuedMs > 0 && n.cause?.kind === 'slot')
    .sort((a, b) => b[1].queuedMs - a[1].queuedMs)
  if (waits.length) {
    ctx.log('')
    ctx.log(bold('Waited for a slot'))
    ctx.log(
      table(
        waits.map(([nodeId, n]) => ({
          node: nodeId,
          waited: ms(n.queuedMs),
          behind: gray(n.cause.nodeId),
          ran: ms(n.durationMs),
        })),
        [
          { key: 'node', label: 'NODE' },
          { key: 'waited', label: 'WAITED' },
          { key: 'behind', label: 'BEHIND' },
          { key: 'ran', label: 'RAN FOR' },
        ]
      )
    )
  }

  if (atCap && atCap.length > 1) {
    ctx.log('')
    ctx.log(bold('At other caps'))
    ctx.log(
      table(
        atCap.map((p) => ({
          cap: p.cap === cap ? bold(String(p.cap)) : String(p.cap),
          makespan: ms(p.makespanMs),
        })),
        [
          { key: 'cap', label: 'SLOTS' },
          { key: 'makespan', label: 'WOULD TAKE' },
        ]
      )
    )
  }

  const max = args.flags.max == null ? null : Number(args.flags.max)
  if (max != null && Number.isFinite(max) && ratio != null && ratio > max) {
    ctx.log('')
    ctx.log(red(`Contention ${ratio.toFixed(2)}× exceeds the ${max}× budget.`))
    return 1
  }
  return 0
}
