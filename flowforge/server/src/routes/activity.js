const express = require('express')
const db = require('../config/database')
const auth = require('../middleware/auth')

const router = express.Router()

// Workspace-scoped, like analytics: non-members get a 404 (don't reveal the
// workspace exists).
function isMember(workspaceId, userId) {
  return db.prepare(
    'SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
  ).get(workspaceId, userId)
}

// `limit` query param → an integer in [1, 100], defaulting to 50.
function parseLimit(value) {
  const n = parseInt(value, 10)
  if (!Number.isFinite(n) || n <= 0) return 50
  return Math.min(n, 100)
}

// Optional category filter → an event_type LIKE prefix. Whitelisted so the
// user-supplied value never reaches the query string (no injection surface).
const CATEGORY_PREFIX = {
  workflows: 'workflow.%',
  executions: 'execution.%',
  members: 'member.%',
  comments: 'comment.%',
}

function safeParse(json) {
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

// GET /api/workspaces/:id/activity?limit=50&before=<iso>&category=<...>
// Newest-first page of a workspace's activity, with the actor's display name
// joined in. `before` is the created_at of the last row you already have (keyset
// pagination); `category` filters to one event family.
router.get('/workspaces/:id/activity', auth, (req, res) => {
  try {
    if (!isMember(req.params.id, req.user.id)) {
      return res.status(404).json({ error: 'Workspace not found' })
    }

    const limit = parseLimit(req.query.limit)
    const conditions = ['a.workspace_id = ?']
    const params = [req.params.id]

    if (req.query.before) {
      conditions.push('a.created_at < ?')
      params.push(String(req.query.before))
    }
    const prefix = CATEGORY_PREFIX[req.query.category]
    if (prefix) {
      conditions.push('a.event_type LIKE ?')
      params.push(prefix)
    }

    // Fetch one extra row to know whether another page exists, without a COUNT.
    const rows = db.prepare(`
      SELECT a.id, a.workspace_id, a.actor_id, a.event_type, a.entity_type,
             a.entity_id, a.entity_name, a.metadata, a.created_at,
             u.display_name AS actor_display_name
      FROM activity_events a
      LEFT JOIN users u ON u.id = a.actor_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ?
    `).all(...params, limit + 1)

    const hasMore = rows.length > limit
    const activity = rows.slice(0, limit).map((r) => ({
      ...r,
      metadata: r.metadata ? safeParse(r.metadata) : null,
    }))

    res.json({ activity, hasMore })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
