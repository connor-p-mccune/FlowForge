// flowforge schedule <workflow-id> [--count N] — the workflow's upcoming
// scheduled runs, from GET /api/v1/workflows/:id/schedule. Answers "when does
// this fire next?" from a terminal or a CI box, without reimplementing cron.

const { bold, gray, yellow, green } = require('../format')

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

module.exports = async function schedule(args, ctx) {
  const workflowId = args.positionals[0]
  if (!workflowId) {
    ctx.log('Usage: flowforge schedule <workflow-id> [--count N]')
    return 1
  }
  const count = args.flags.count ? `?count=${encodeURIComponent(args.flags.count)}` : ''
  const data = await ctx.api.get(`/api/v1/workflows/${workflowId}/schedule${count}`)

  if (!data.scheduled) {
    ctx.log(gray('This workflow has no schedule trigger.'))
    return 0
  }

  const state = data.active ? green('active') : yellow('inactive (not deployed)')
  ctx.log(bold('Schedule') + gray(`  ${data.cron}`) + `  ${state}`)

  if (!data.reachable || !data.nextRuns?.length) {
    ctx.log(yellow('  This schedule never fires — check the expression (e.g. Feb 30).'))
    return 0
  }

  data.nextRuns.forEach((iso, i) => {
    const rel = i === 0 ? gray(`  ${relative(iso)}`) : ''
    ctx.log(`  ${formatUtc(iso)}${rel}`)
  })
  return 0
}
