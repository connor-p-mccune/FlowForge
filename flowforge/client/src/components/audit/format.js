// Presentation for audit entries. Kept as pure functions in their own module,
// like the activity feed's format.js, so the phrasing is unit-testable without
// rendering anything.

// Filter chips. The values are sent straight to the API's `action` param, whose
// trailing '*' matches a family — same syntax the activity feed uses, so one
// mental model covers both surfaces.
export const ACTION_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'secret.*', label: 'Secrets' },
  { key: 'variable.*', label: 'Variables' },
  { key: 'member.*', label: 'Members' },
  { key: 'token.*', label: 'Tokens' },
  { key: 'workflow.*', label: 'Workflows' },
  { key: 'status_page.*', label: 'Status page' },
]

// One sentence per action, in the past tense and naming the target.
//
// Written out per action rather than derived from the action string, because an
// audit log is read under pressure — during an incident or a review — and
// "removed Ada from the workspace" is understood instantly where
// "member.removed / Ada" has to be decoded. The `metadata` each entry carries
// is what makes several of these specific enough to be useful (which role, which
// version, which scopes).
export function describeAuditEntry(entry) {
  const name = entry.targetName || entry.targetId || 'an item'
  const meta = entry.metadata || {}
  switch (entry.action) {
    case 'secret.created':
      return `created the secret ${name}`
    case 'secret.updated':
      return `changed the value of the secret ${name}`
    case 'secret.deleted':
      return `deleted the secret ${name}`
    case 'variable.created':
      return `created the variable ${name}`
    case 'variable.updated':
      return `changed the variable ${name}`
    case 'variable.deleted':
      return `deleted the variable ${name}`
    case 'member.invited':
      return `added ${name} to the workspace as ${meta.role || 'a member'}`
    case 'member.removed':
      return `removed ${name} from the workspace`
    case 'member.role_changed':
      return `changed ${name}’s role from ${meta.from || '?'} to ${meta.to || '?'}`
    case 'token.minted':
      return `minted the API token “${name}”${
        meta.scopes?.length ? ` (${meta.scopes.join(', ')})` : ''
      }`
    case 'token.revoked':
      return `revoked the API token “${name}”`
    case 'workflow.deployed':
      return `deployed ${name}${meta.version ? ` as version ${meta.version}` : ''}`
    case 'workflow.deleted':
      return `deleted the workflow ${name}`
    case 'workflow.imported':
      return `imported the workflow ${name}${meta.nodes ? ` (${meta.nodes} nodes)` : ''}`
    case 'workflow.version_restored':
      return `restored ${name} to version ${meta.version ?? '?'}`
    case 'workflow.paused':
      return `paused ${name}`
    case 'workflow.resumed':
      return `resumed ${name}`
    case 'status_page.enabled':
      return 'published a public status page'
    case 'status_page.rotated':
      return 'rotated the status page link, severing every shared copy'
    case 'status_page.disabled':
      return 'took the public status page down'
    default:
      // A forward-compatible fallback: a server that records a newer action
      // than this build knows about still renders something honest.
      return `${entry.action} · ${name}`
  }
}

// "2026-08-05 14:32:07 UTC" — absolute, to the second, in one fixed zone.
//
// Deliberately not "3 hours ago": every other surface in the app uses relative
// time because recency is what matters there, but an audit entry is evidence.
// It gets correlated against logs from other systems, quoted in a report, and
// read months later, and all three want an exact instant rather than a
// distance from whenever the page happened to be open.
export function formatAuditTime(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`
  )
}
