// flowforge backfill <workflow-id> --from <iso> --to <iso> [--preview]
//                                  [--all] [--priority <lane>] [--yes]
//
// Re-runs a scheduled workflow over a window of the past. Usually the tail of a
// recovery script — "deploy the fix, then replay the window it was broken for"
// — which is why it belongs in the same automation as the deploy rather than in
// a browser tab someone has to remember.
//
// The command previews by default and refuses to submit without either --yes or
// an interactive confirmation, because this is the one CLI verb that turns a
// single line into hundreds of runs. `--preview` prints the plan and stops.

const { bold, gray, green, yellow, red } = require('../format')

// Accepts an ISO timestamp or a relative shorthand — "7d", "36h", "90m" — which
// is what a recovery script actually wants to say ("the last three days"),
// spelled without date arithmetic in bash.
const RELATIVE = /^(\d+)([mhd])$/
function parseWhen(value, { now = Date.now() } = {}) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const trimmed = value.trim()
  if (trimmed === 'now') return new Date(now).toISOString()
  const rel = RELATIVE.exec(trimmed)
  if (rel) {
    const scale = { m: 60000, h: 3600000, d: 86400000 }[rel[2]]
    return new Date(now - Number(rel[1]) * scale).toISOString()
  }
  const parsed = new Date(trimmed)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function formatUtc(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`
  )
}

// Print the plan the way someone about to create N runs needs to read it: the
// count first, the boundaries next, and only a sample of the occurrences —
// printing 800 timestamps buries the number that matters.
function printPlan(ctx, plan) {
  ctx.log(
    bold(`${plan.willRun} run${plan.willRun === 1 ? '' : 's'}`) +
      gray(` from ${plan.total} occurrence${plan.total === 1 ? '' : 's'} in the window`) +
      (plan.skipped ? yellow(`  (${plan.skipped} already ran)`) : '')
  )
  ctx.log(gray(`  schedule ${plan.cron} [${plan.timeZone}]`))
  ctx.log(gray(`  ${formatUtc(plan.from)} → ${formatUtc(plan.to)}`))

  const pending = plan.occurrences.filter((o) => !o.alreadyRan)
  const sample = pending.slice(0, 5)
  for (const o of sample) ctx.log(`  ↳ ${formatUtc(o.logicalDate)}`)
  if (pending.length > sample.length) {
    ctx.log(gray(`  … and ${pending.length - sample.length} more`))
  }
}

module.exports = async function backfill(args, ctx) {
  const workflowId = args.positionals[0]
  const from = parseWhen(args.flags.from)
  const to = parseWhen(args.flags.to ?? 'now')

  if (!workflowId || !from) {
    ctx.log(
      'Usage: flowforge backfill <workflow-id> --from <iso|7d> [--to <iso|now>]\n' +
        '                          [--preview] [--all] [--priority high|normal|low] [--yes]'
    )
    return 1
  }
  if (!to) {
    ctx.log(red('--to must be an ISO timestamp, a relative window like "6h", or "now".'))
    return 1
  }

  const body = {
    from,
    to,
    // --all re-runs occurrences that already have a run. Off by default: the
    // normal reason to backfill an overlapping range is to fill the gaps.
    skipExisting: !args.flags.all,
    ...(args.flags.priority ? { priority: String(args.flags.priority) } : {}),
  }

  const plan = await ctx.api.post(`/api/v1/workflows/${workflowId}/backfill`, {
    ...body,
    preview: true,
  })
  printPlan(ctx, plan)

  if (args.flags.preview) return 0
  if (plan.willRun === 0) {
    ctx.log(gray('Nothing to do.'))
    return 0
  }
  if (!args.flags.yes) {
    // Deliberately not an interactive prompt: this runs in CI as often as in a
    // terminal, and a command that blocks on stdin in a pipeline is worse than
    // one that tells you which flag to add.
    ctx.log('')
    ctx.log(yellow(`Refusing to create ${plan.willRun} runs without --yes.`))
    ctx.log(gray('Re-run with --yes to submit, or --preview to keep planning.'))
    return 1
  }

  const result = await ctx.api.post(`/api/v1/workflows/${workflowId}/backfill`, body)
  ctx.log('')
  ctx.log(
    green(`✓ Queued ${result.created} run${result.created === 1 ? '' : 's'}`) +
      gray(` on the ${result.priority} lane · batch ${result.backfillId}`)
  )
  ctx.log(gray(`  Watch progress: flowforge runs ${workflowId}`))
  return 0
}

// Exported for tests: the relative-window parsing is the part with edge cases.
module.exports.parseWhen = parseWhen
