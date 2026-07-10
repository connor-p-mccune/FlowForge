// Activity-feed formatting helpers. formatEvent maps an event to a human-readable
// action phrase (the actor name is rendered separately); entityHref maps it to the
// in-app link for its subject; initials/actorColor render a stable actor avatar.

// Cursor palette mirrored from the server (socket/index.js) so an actor's avatar
// color is stable across sessions without needing the live socket color.
const AVATAR_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#06b6d4', '#6366f1', '#a855f7', '#ec4899',
]

// Filter tabs. `prefix` matches the server's event_type families (and the API's
// ?category= filter); `all` shows everything.
export const CATEGORIES = [
  { key: 'all', label: 'All', prefix: null },
  { key: 'executions', label: 'Executions', prefix: 'execution.' },
  { key: 'workflows', label: 'Workflows', prefix: 'workflow.' },
  { key: 'members', label: 'Members', prefix: 'member.' },
  { key: 'comments', label: 'Comments', prefix: 'comment.' },
]

export function initials(name) {
  if (!name) return '?'
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

// Deterministic avatar color from a stable key (actor id, falling back to the
// display label) so the same actor always gets the same color — even when offline.
export function actorColor(key) {
  const s = key || 'system'
  let hash = 0
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

// Display name for the actor. System/webhook/schedule runs have no actor — fall
// back to a label derived from the run's trigger type.
export function actorLabel(event) {
  if (event.actor_display_name) return event.actor_display_name
  const t = event.metadata && event.metadata.triggerType
  if (t === 'webhook') return 'A webhook'
  if (t === 'schedule') return 'A schedule'
  return 'Someone'
}

// The entity name as it should read in the description, with a sensible fallback.
function entityName(event) {
  return event.entity_name || 'a workflow'
}

// Map an event to its human-readable action phrase (without the actor — the row
// renders the actor name separately). Every spec'd event type is handled; unknown
// types degrade gracefully.
export function formatEvent(event) {
  const name = entityName(event)
  const meta = event.metadata || {}
  switch (event.event_type) {
    case 'workflow.created': return `created workflow ${name}`
    case 'workflow.updated': return `edited workflow ${name}`
    case 'workflow.deployed':
      return meta.version ? `deployed ${name} (v${meta.version})` : `deployed ${name}`
    case 'workflow.deleted': return `deleted workflow ${name}`
    case 'workflow.restored':
      return meta.version ? `restored ${name} to v${meta.version}` : `restored ${name}`
    case 'execution.completed': return `ran ${name}`
    case 'execution.failed': return `ran ${name} — failed`
    case 'execution.cancelled': return `stopped a run of ${name}`
    case 'member.invited': return `added ${name} to the workspace`
    case 'member.removed': return `removed ${name} from the workspace`
    case 'comment.added': return `commented on ${name}`
    case 'comment.resolved': return `resolved a comment on ${name}`
    case 'approval.approved': return `approved a run of ${name}`
    case 'approval.rejected': return `rejected a run of ${name}`
    case 'secret.created': return `added secret ${name}`
    case 'secret.updated': return `rotated secret ${name}`
    case 'secret.deleted': return `deleted secret ${name}`
    default: {
      const verb = String(event.event_type || '').replace(/\./g, ' ')
      return event.entity_name ? `${verb} ${name}` : verb
    }
  }
}

// The in-app route the event links to, or null when there's nothing to open.
// Workflow/execution/comment events open the relevant workflow's canvas; member
// events have no canvas to open.
export function entityHref(event) {
  const type = event.entity_type
  if (type === 'workflow') return event.entity_id ? `/workflow/${event.entity_id}` : null
  if (type === 'execution' || type === 'comment') {
    const wfId = event.metadata && event.metadata.workflowId
    return wfId ? `/workflow/${wfId}` : null
  }
  return null
}
