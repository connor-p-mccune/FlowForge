// Workspace roles — the single answer to "what may this user do here?".
//
// Three roles, strictly ordered: **owner** manages the workspace itself
// (members, secrets, variables, subscriptions, status pages, deletion),
// **member** builds and runs workflows, **viewer** observes. A viewer sees
// everything a member sees — workflows, run history, insights, live
// execution streams — and can comment (observing and discussing is the
// point of the role), but every state-changing operation is refused: no
// graph edits, no runs, no deploys, no webhook changes, no approvals.
//
// Enforcement is two-layered on purpose: non-members still get 404 (a
// workspace's existence is not disclosed), while a member whose role is
// insufficient gets 403 — they can see the resource, the *operation* is
// what's forbidden. Routes call canEdit() after their existing visibility
// check, so the 404 contract is untouched.
//
// Legacy rows predate the viewer role and hold 'owner' or 'member'; any
// unknown stored role is treated as 'member' — a corrupt row must not
// silently grant ownership or silently revoke write access.

const db = require('../config/database')

const ROLES = ['owner', 'member', 'viewer']

function memberRole(workspaceId, userId) {
  if (!workspaceId || !userId) return null
  const row = db.prepare(
    'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
  ).get(workspaceId, userId)
  if (!row) return null
  return ROLES.includes(row.role) ? row.role : 'member'
}

// May the user change state in this workspace? (Any role but viewer.)
function canEdit(workspaceId, userId) {
  const role = memberRole(workspaceId, userId)
  return role !== null && role !== 'viewer'
}

// The standard refusal for a viewer hitting a mutating route. Returns true
// when the response has been sent (caller should return immediately).
function forbidViewer(res, workspaceId, userId) {
  if (canEdit(workspaceId, userId)) return false
  res.status(403).json({ error: 'Viewers have read-only access' })
  return true
}

module.exports = { ROLES, memberRole, canEdit, forbidViewer }
