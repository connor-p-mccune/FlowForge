// flowforge schedule <workflow-id> [--count N] — the workflow's upcoming
// scheduled runs, from GET /api/v1/workflows/:id/schedule. Answers "when does
// this fire next?" from a terminal or a CI box, without reimplementing cron.
//
// flowforge schedule --workspace [ws-id] [--capacity N] — the other question
// about the same subject: what a week of *all* these schedules does to the
// machine they share. Every timing view in this CLI is about one workflow; the
// load is not, and it is not random either, because cron is written by people
// and people write round numbers.

const { bold, gray, yellow, green, red, cyan, table } = require('../format')

// An ISO-8601 UTC instant → "Wed 2026-01-14 09:00 UTC". Fixed to UTC so the
// output matches the server's cron contract regardless of the box's timezone.
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
function formatUtc(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${DAYS[d.getUTCDay()]} ${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  )
}

// "in 4h 12m" / "in 3d" — a compact relative time to the next fire, so the
// cadence is legible at a glance.
function relative(iso) {
  const diff = new Date(iso).getTime() - Date.now()
  if (!Number.isFinite(diff) || diff < 0) return ''
  const mins = Math.round(diff / 60000)
  if (mins < 60) return `in ${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `in ${hours}h ${mins % 60}m`
  return `in ${Math.round(hours / 24)}d`
}

const duration = (ms) => (ms < 60000 ? `${Math.round(ms / 1000)}s` : `${(ms / 60000).toFixed(1)}m`)

// A workspace to report on. With one, the argument is noise; with several,
// guessing would be worse than asking. Same rule `exposure` uses.
async function resolveWorkspace(ctx, given) {
  if (typeof given === 'string' && given.length > 0) return given
  const { workspaces } = await ctx.api.get('/api/v1/workspaces')
  if (!workspaces || workspaces.length === 0) return null
  if (workspaces.length === 1) return workspaces[0].id
  ctx.log('This token can see several workspaces. Pick one:')
  for (const w of workspaces) ctx.log(`  ${gray(w.id)}  ${w.name}`)
  return null
}

async function workspaceSchedule(args, ctx) {
  const workspaceId = await resolveWorkspace(ctx, args.flags.workspace)
  if (!workspaceId) return 1

  const query = []
  if (args.flags.days != null) query.push(`days=${encodeURIComponent(args.flags.days)}`)
  if (args.flags.capacity != null) query.push(`capacity=${encodeURIComponent(args.flags.capacity)}`)
  const suffix = query.length ? `?${query.join('&')}` : ''

  const report = await ctx.api.get(`/api/v1/workspaces/${workspaceId}/schedule${suffix}`)

  if (!report.available) {
    // Two different sentences. "Nothing is scheduled" is a fact about the
    // workspace; "nothing has run" is a fact about this report's inputs, and
    // telling somebody to go and write a cron would be the wrong instruction.
    if (report.reason === 'nothing-measured') {
      ctx.log(
        yellow(`${report.unmeasured.length} scheduled workflow(s) have never run.`) +
          gray('\n  Without a measured duration there is no occupancy to overlap.')
      )
      return 0
    }
    ctx.log(gray('No workflow in this workspace has a schedule trigger.'))
    return 0
  }

  const { peak, summary, clock, suggestion } = report
  ctx.log(
    bold('Scheduled load') +
      gray(`  ${summary.scheduled} workflow(s) · ${summary.occurrences} runs over ${report.horizonDays} days`)
  )
  ctx.log('')

  const over = summary.overCapacity === true
  const headline = `At most ${peak.concurrent} run${peak.concurrent === 1 ? '' : 's'} at once, ${
    peak.at ? formatUtc(peak.at) : 'at an unknown time'
  }`
  ctx.log(over ? red(headline) : bold(headline))
  if (summary.capacity != null) {
    ctx.log(
      gray(`  Against a capacity of ${summary.capacity}: `) +
        (over ? red('over') : green('within budget'))
    )
  }

  if (peak.workflows.length > 0) {
    ctx.log(
      table(
        peak.workflows.map((w) => ({
          name: w.name,
          cron: gray(w.cron),
          zone: w.timeZone ? gray(w.timeZone) : gray('UTC'),
          holds: duration(w.durationMs),
        })),
        [
          { key: 'name', label: 'WORKFLOW' },
          { key: 'cron', label: 'CRON' },
          { key: 'zone', label: 'ZONE' },
          { key: 'holds', label: 'HOLDS A SLOT' },
        ]
      )
    )
  }

  // The finding rather than a curiosity: a peak that is an accident of everyone
  // independently picking midnight has a cheap fix, and one whose load is
  // genuinely that high does not.
  if (clock.onTheHour > 0) {
    ctx.log('')
    ctx.log(
      gray(
        `  ${Math.round(clock.share * 100)}% of scheduled runs start on the hour` +
          (clock.atMidnight > 0 ? `, ${clock.atMidnight} of them at midnight` : '') +
          '.'
      )
    )
  }

  if (suggestion) {
    ctx.log(
      `  ${cyan(`Moving ${suggestion.name} ${suggestion.minutes} minutes later`)} would drop the ` +
        `peak from ${suggestion.peakBefore} to ${suggestion.peakAfter}.`
    )
  }

  // Stated rather than implied: with any workflow excluded the peak is a floor.
  if (summary.lowerBound) {
    ctx.log(
      yellow(
        `\n  ${summary.unmeasured} scheduled workflow(s) have never run, so this peak is a floor:`
      ) + gray(`\n  ${report.unmeasured.map((u) => u.name).join(', ')}`)
    )
  }

  return over ? 1 : 0
}

async function workflowSchedule(args, ctx) {
  const workflowId = args.positionals[0]
  if (!workflowId) {
    ctx.log(
      'Usage: flowforge schedule <workflow-id> [--count N]\n' +
        '       flowforge schedule --workspace [ws-id] [--days N] [--capacity N]'
    )
    return 1
  }
  const count = args.flags.count ? `?count=${encodeURIComponent(args.flags.count)}` : ''
  const data = await ctx.api.get(`/api/v1/workflows/${workflowId}/schedule${count}`)

  if (!data.scheduled) {
    ctx.log(gray('This workflow has no schedule trigger.'))
    return 0
  }

  const state = data.active ? green('active') : yellow('inactive (not deployed)')
  const zone = data.timeZone && data.timeZone !== 'UTC' ? gray(`  [${data.timeZone}]`) : ''
  ctx.log(bold('Schedule') + gray(`  ${data.cron}`) + zone + `  ${state}`)

  if (!data.reachable || !data.nextRuns?.length) {
    ctx.log(yellow('  This schedule never fires — check the expression (e.g. Feb 30).'))
    return 0
  }

  // A zoned schedule prints the local wall clock first (what the author wrote)
  // with the UTC instant beside it (what actually happens), because reading
  // only one of the two is how DST bugs get missed.
  const rows = data.nextRunsLocal || data.nextRuns.map((utc) => ({ utc }))
  rows.forEach((run, i) => {
    const rel = i === 0 ? gray(`  ${relative(run.utc)}`) : ''
    const line = run.local
      ? `${run.local} ${run.offset}${gray(`  · ${formatUtc(run.utc)}`)}`
      : formatUtc(run.utc)
    ctx.log(`  ${line}${rel}`)
  })

  // Call out a daylight-saving change inside the previewed window: the local
  // hour holding while the UTC instant moves is correct, and unexplained it
  // looks like the schedule slipped.
  const offsets = new Set(rows.map((r) => r.offset).filter(Boolean))
  if (offsets.size > 1) {
    ctx.log(gray('  A daylight-saving change falls in this window — local time holds, UTC shifts.'))
  }
  return 0
}

module.exports = async function schedule(args, ctx) {
  // One command, two questions about the same subject: when does *this* fire,
  // and what do *all of them together* do to the machine.
  return args.flags.workspace ? workspaceSchedule(args, ctx) : workflowSchedule(args, ctx)
}
