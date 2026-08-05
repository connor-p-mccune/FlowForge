// flowforge audit <workspace-id> [--limit N] [--action secret.*] [--verify]
//
// Reads the workspace's tamper-evident audit log, and — with --verify — holds
// it to account.
//
// The exit code is the point of the --verify form. An integrity check nobody
// runs is not a control, so this is built to be a cron line: it exits 1 on a
// broken chain, which is all a scheduler needs to page someone. Everything else
// about the command is a convenience; that is the feature.

const { table, bold, gray, green, red, yellow } = require('../format')

// One sentence per action, mirroring the web UI's phrasing so the two surfaces
// describe the same event the same way — an operator reading a CI log and an
// owner reading the page should not have to translate between them.
function describe(entry) {
  const name = entry.targetName || entry.targetId || 'an item'
  const meta = entry.metadata || {}
  switch (entry.action) {
    case 'secret.created': return `created secret ${name}`
    case 'secret.updated': return `changed secret ${name}`
    case 'secret.deleted': return `deleted secret ${name}`
    case 'variable.created': return `created variable ${name}`
    case 'variable.updated': return `changed variable ${name}`
    case 'variable.deleted': return `deleted variable ${name}`
    case 'member.invited': return `added ${name} as ${meta.role || 'a member'}`
    case 'member.removed': return `removed ${name}`
    case 'member.role_changed': return `${name}: ${meta.from || '?'} → ${meta.to || '?'}`
    case 'token.minted': return `minted token "${name}"`
    case 'token.revoked': return `revoked token "${name}"`
    case 'workflow.deployed': return `deployed ${name}${meta.version ? ` v${meta.version}` : ''}`
    case 'workflow.deleted': return `deleted workflow ${name}`
    case 'workflow.imported': return `imported workflow ${name}`
    case 'workflow.version_restored': return `restored ${name} to v${meta.version ?? '?'}`
    case 'workflow.paused': return `paused ${name}`
    case 'workflow.resumed': return `resumed ${name}`
    case 'status_page.enabled': return 'published a status page'
    case 'status_page.rotated': return 'rotated the status page link'
    case 'status_page.disabled': return 'took the status page down'
    default: return `${entry.action} · ${name}`
  }
}

// "2026-08-05 14:32 UTC" — absolute, like the web UI, because an audit line is
// correlated against other systems' logs rather than skimmed for recency.
function formatUtc(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  )
}

module.exports = async function audit(args, ctx) {
  const workspaceId = args.positionals[0]
  if (!workspaceId) {
    ctx.log('Usage: flowforge audit <workspace-id> [--limit N] [--action <filter>] [--verify]')
    return 1
  }

  const verification = await ctx.api.get(`/api/v1/workspaces/${workspaceId}/audit/verify`)

  if (verification.ok) {
    ctx.log(
      green('✓ Chain verified') +
        gray(` — ${verification.entries} ${verification.entries === 1 ? 'entry' : 'entries'}, unbroken`)
    )
    // The head is what an operator would record externally to detect a
    // wholesale rewrite, so print it rather than making them call the API again.
    if (verification.head) ctx.log(gray(`  head ${verification.head}`))
  } else {
    ctx.log(red('✗ Chain verification FAILED'))
    ctx.log(
      yellow(
        `  Entry #${verification.brokenAt?.seq} — ${verification.brokenAt?.detail} ` +
          `(${verification.brokenAt?.reason})`
      )
    )
    ctx.log(yellow('  This log was modified outside the application. Investigate database access.'))
  }

  // --verify is the monitoring form: verdict only, and an exit code to act on.
  if (args.flags.verify) return verification.ok ? 0 : 1

  const params = new URLSearchParams()
  if (args.flags.limit) params.set('limit', String(args.flags.limit))
  if (args.flags.action) params.set('action', String(args.flags.action))
  const query = params.toString() ? `?${params.toString()}` : ''
  const { entries } = await ctx.api.get(`/api/v1/workspaces/${workspaceId}/audit${query}`)

  ctx.log('')
  if (!entries || entries.length === 0) {
    ctx.log(gray('No audit entries yet.'))
    return verification.ok ? 0 : 1
  }

  ctx.log(bold('Audit log') + gray(' (newest first)'))
  ctx.log(
    table(
      entries.map((e) => ({
        seq: gray(`#${e.seq}`),
        when: formatUtc(e.createdAt),
        who: e.actor || 'unknown',
        what: describe(e),
      })),
      [
        { key: 'seq', label: '#' },
        { key: 'when', label: 'WHEN' },
        { key: 'who', label: 'WHO' },
        { key: 'what', label: 'WHAT' },
      ]
    )
  )

  // Even in listing mode a broken chain fails the command: a caller who piped
  // this into a report should not get a clean exit over a compromised log.
  return verification.ok ? 0 : 1
}
