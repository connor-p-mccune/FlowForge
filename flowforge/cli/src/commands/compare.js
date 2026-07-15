// flowforge compare <base-execution-id> <other-execution-id> — diff two runs
// of the same workflow node by node: status changes, per-step duration
// deltas, and whether the output differs, from
// GET /api/v1/executions/:id/compare/:otherId.

const { table, bold, gray, red, green, statusColored } = require('../format')

function ms(v) {
  if (v == null) return '—'
  if (v < 1000) return `${Math.round(v)}ms`
  if (v < 10_000) return `${(v / 1000).toFixed(1)}s`
  return `${Math.round(v / 1000)}s`
}

// A signed delta, colored by direction: slower is the bad direction.
function delta(v) {
  if (v == null) return ''
  if (v === 0) return gray('±0')
  return v > 0 ? red(`+${ms(v)}`) : green(`-${ms(-v)}`)
}

function sideStatus(side) {
  return side ? statusColored(side.status) : gray('—')
}

module.exports = async function compare(args, ctx) {
  const [baseId, otherId] = args.positionals
  if (!baseId || !otherId) {
    ctx.log('Usage: flowforge compare <base-execution-id> <other-execution-id>')
    return 1
  }
  const { base, other, nodes, summary } = await ctx.api.get(
    `/api/v1/executions/${baseId}/compare/${encodeURIComponent(otherId)}`
  )

  ctx.log(
    bold('Run comparison  ') +
      `${statusColored(base.status)} ${ms(base.durationMs)}` +
      gray('  →  ') +
      `${statusColored(other.status)} ${ms(other.durationMs)}` +
      (base.durationMs != null && other.durationMs != null
        ? `  ${delta(other.durationMs - base.durationMs)}`
        : '')
  )
  ctx.log('')

  ctx.log(
    table(
      nodes.map((n) => ({
        node: n.nodeId,
        type: gray(n.nodeType ?? ''),
        base: sideStatus(n.base),
        other: sideStatus(n.other),
        delta: delta(n.durationDeltaMs),
        output: n.base && n.other ? (n.outputChanged ? red('changed') : gray('same')) : gray('—'),
      })),
      [
        { key: 'node', label: 'Node' },
        { key: 'type', label: 'Type' },
        { key: 'base', label: 'Base' },
        { key: 'other', label: 'Other' },
        { key: 'delta', label: 'Δ time' },
        { key: 'output', label: 'Output' },
      ]
    )
  )

  ctx.log('')
  const bits = [
    `${summary.statusChanges} status change${summary.statusChanges === 1 ? '' : 's'}`,
    `${summary.outputChanges} output change${summary.outputChanges === 1 ? '' : 's'}`,
  ]
  if (summary.onlyInBase) bits.push(`${summary.onlyInBase} only in base`)
  if (summary.onlyInOther) bits.push(`${summary.onlyInOther} only in other`)
  ctx.log(gray(bits.join(' · ')))
  if (summary.slowestRegression) {
    ctx.log(`Slowest regression: ${bold(summary.slowestRegression)}`)
  }
  return 0
}
