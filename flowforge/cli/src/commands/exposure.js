// flowforge exposure [workspace-id] [--unchecked] [--top N] — where a review
// should start.
//
// Every other analysis command here takes a workflow id, which quietly assumes
// the hardest part is already done. Nobody has one workflow. This is the only
// command that answers *"which of these forty should I open"*, and it answers
// it with a quantity rather than an opinion: what a run can do to the outside
// world, multiplied by how often it runs.
//
// The figure is an interval — a floor of effects nothing gates and a ceiling of
// all of them — because nothing here evaluates a gate, and a single number
// would have to guess. The list is ordered by the ceiling, because the point of
// the report is to find workflows nobody has checked and an untested gate is
// not evidence.
//
// `--unchecked` is the CI shape, and unlike `effects --ungated` it is not
// ambiguous: a workflow reaching a payments API on every run may well be
// deliberate, but a workflow with consequence and *no scenarios, guarantees,
// assertions or drift monitoring at all* is not a design decision anybody
// defends out loud.

const { bold, gray, green, red, yellow, cyan, table } = require('../format')

// One outward action a day is a different order of thing from a thousand, and
// the column has to stay narrow enough to scan. Whole numbers above ten,
// one decimal below, because 0.1/day and 0.9/day are meaningfully different and
// 431 vs 431.4 is not.
const rate = (n) => (n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10))

// The interval, collapsed when its ends agree — "4" says more than "4 – 4".
function span(exposure) {
  const { floor, ceiling } = exposure
  if (ceiling === 0) return gray('0')
  if (floor === ceiling) return red(rate(ceiling))
  return `${gray(rate(floor))}${gray(' – ')}${yellow(rate(ceiling))}`
}

// What the workflow reaches, in the shape a reviewer scans for: how much, and
// how much of it is somewhere they would not have looked.
function reaches(row) {
  if (row.effects.total === 0) return gray('nothing outside')
  const parts = [`${row.effects.total} effect${row.effects.total === 1 ? '' : 's'}`]
  if (row.effects.inherited > 0) parts.push(yellow(`${row.effects.inherited} off-canvas`))
  return parts.join(gray(' · '))
}

// The checks, counted and never summed. `nothing` is the finding.
function checkedBy(row) {
  const a = row.assurance
  if (!a.checked) return red('nothing')
  const parts = []
  if (a.scenarios) parts.push(`${a.scenarios} scenario${a.scenarios === 1 ? '' : 's'}`)
  if (a.guarantees) parts.push(`${a.guarantees} guarantee${a.guarantees === 1 ? '' : 's'}`)
  if (a.assertions) parts.push(`${a.assertions} assertion${a.assertions === 1 ? '' : 's'}`)
  if (a.drift) parts.push('drift')
  return green(parts.join(', '))
}

// A workspace to report on. With one, the argument is noise; with several,
// guessing would be worse than asking.
async function resolveWorkspace(ctx, given) {
  if (given) return given
  const { workspaces } = await ctx.api.get('/api/v1/workspaces')
  if (!workspaces || workspaces.length === 0) return null
  if (workspaces.length === 1) return workspaces[0].id
  ctx.log('This token can see several workspaces. Pick one:')
  for (const w of workspaces) ctx.log(`  ${gray(w.id)}  ${w.name}`)
  return null
}

module.exports = async function exposure(args, ctx) {
  const workspaceId = await resolveWorkspace(ctx, args.positionals[0])
  if (!workspaceId) return 1

  const days = parseInt(args.flags.days, 10)
  const query = Number.isFinite(days) ? `?days=${days}` : ''
  const report = await ctx.api.get(`/api/v1/workspaces/${workspaceId}/exposure${query}`)

  const { summary } = report
  if (summary.workflows === 0) {
    ctx.log(
      summary.unreadable > 0
        ? yellow(`No workflow in this workspace could be read (${summary.unreadable} unreadable).`)
        : 'No workflows in this workspace.'
    )
    return 0
  }

  const top = parseInt(args.flags.top, 10)
  const shown = Number.isFinite(top) && top > 0 ? report.workflows.slice(0, top) : report.workflows

  ctx.log(bold(`Where a review should start`))
  ctx.log(gray(`Outward actions per day over the last ${report.windowDays} days\n`))
  ctx.log(
    table(
      shown.map((row) => ({
        exposure: span(row.exposure),
        // A called-only workflow scores zero because its consequence was
        // charged to its callers. Saying so is the difference between "safe"
        // and "counted elsewhere".
        workflow: row.attributed
          ? `${row.name} ${gray(`(via ${row.calledBy.join(', ')})`)}`
          : row.name,
        runs: row.runs.direct === 0 ? gray('—') : rate(row.runs.perDay),
        reaches: reaches(row),
        checked: checkedBy(row),
      })),
      [
        { key: 'exposure', label: 'PER DAY' },
        { key: 'workflow', label: 'WORKFLOW' },
        { key: 'runs', label: 'RUNS/DAY' },
        { key: 'reaches', label: 'REACHES' },
        { key: 'checked', label: 'CHECKED BY' },
      ]
    )
  )
  if (shown.length < report.workflows.length) {
    ctx.log(gray(`  … and ${report.workflows.length - shown.length} more`))
  }

  ctx.log('')
  ctx.log(
    gray(
      `  ${rate(summary.outwardPerDay.ceiling)} outward actions a day at most, ` +
        `${rate(summary.outwardPerDay.floor)} of them guaranteed · ` +
        `${rate(summary.runsPerDay)} runs a day`
    )
  )
  if (summary.offCanvas > 0) {
    ctx.log(
      gray(
        `  ${summary.offCanvas} of those effects happen inside a workflow somebody called — ` +
          'no single canvas shows them.'
      )
    )
  }
  if (summary.unreadable > 0) {
    ctx.log(yellow(`  ${summary.unreadable} workflow(s) have a graph this could not read.`))
  }

  if (summary.unchecked === 0) {
    ctx.log(green('\n  Every workflow that does anything has something checking it.'))
    return 0
  }

  // The line worth repeating: not how many workflows are unchecked, but how
  // much of what the workspace does sits on them.
  ctx.log('')
  ctx.log(
    bold(
      `${Math.round(summary.uncheckedShare * 100)}% of what this workspace does to the ` +
        `outside world sits on ${summary.unchecked} workflow(s) nothing is checking:`
    )
  )
  for (const id of report.queue.slice(0, 10)) {
    const row = report.workflows.find((r) => r.workflowId === id)
    ctx.log(`  ${cyan(row.name)} ${gray(`— ${rate(row.exposure.ceiling)}/day · ${row.workflowId}`)}`)
  }
  if (report.queue.length > 10) ctx.log(gray(`  … and ${report.queue.length - 10} more`))

  return args.flags.unchecked ? 1 : 0
}
