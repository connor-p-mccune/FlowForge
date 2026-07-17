// Public status pages. Management is workspace-scoped and session-authed
// (mint/rotate/disable are owner-only — publishing run health is a workspace
// decision, not any member's); the page itself is served by token alone, so
// a shared link works for people without accounts. Unknown and disabled
// tokens both read as 404 — the endpoint never confirms what exists.

const express = require('express')
const db = require('../config/database')
const auth = require('../middleware/auth')
const { webhookLimiter } = require('../middleware/rateLimit')
const { mintToken, buildStatusPage } = require('../services/statusPage')

const router = express.Router()

function memberRole(workspaceId, userId) {
  return db.prepare(
    'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
  ).get(workspaceId, userId)?.role
}

// GET /api/workspaces/:id/status-page — the current sharing state. Any
// member may look; only owners may change it.
router.get('/workspaces/:id/status-page', auth, (req, res) => {
  try {
    const role = memberRole(req.params.id, req.user.id)
    if (!role) return res.status(404).json({ error: 'Workspace not found' })
    const workspace = db.prepare('SELECT status_page_token FROM workspaces WHERE id = ?')
      .get(req.params.id)
    res.json({ token: workspace?.status_page_token ?? null })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/workspaces/:id/status-page — mint (or rotate) the token.
// Rotation severs every previously shared link, which is the point.
router.post('/workspaces/:id/status-page', auth, (req, res) => {
  try {
    const role = memberRole(req.params.id, req.user.id)
    if (!role) return res.status(404).json({ error: 'Workspace not found' })
    if (role !== 'owner') {
      return res.status(403).json({ error: 'Only a workspace owner can manage the status page' })
    }
    const token = mintToken()
    db.prepare('UPDATE workspaces SET status_page_token = ?, updated_at = ? WHERE id = ?')
      .run(token, new Date().toISOString(), req.params.id)
    res.status(201).json({ token })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/workspaces/:id/status-page — take the page down entirely.
router.delete('/workspaces/:id/status-page', auth, (req, res) => {
  try {
    const role = memberRole(req.params.id, req.user.id)
    if (!role) return res.status(404).json({ error: 'Workspace not found' })
    if (role !== 'owner') {
      return res.status(403).json({ error: 'Only a workspace owner can manage the status page' })
    }
    db.prepare('UPDATE workspaces SET status_page_token = NULL, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), req.params.id)
    res.status(204).end()
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/status/:token — the public payload. No auth: the token is the
// whole credential. Rate-limited like the other public surfaces.
router.get('/status/:token', webhookLimiter, (req, res) => {
  try {
    const token = req.params.token
    if (typeof token !== 'string' || token.length < 16 || token.length > 128) {
      return res.status(404).json({ error: 'Not found' })
    }
    const workspace = db.prepare('SELECT * FROM workspaces WHERE status_page_token = ?').get(token)
    if (!workspace) return res.status(404).json({ error: 'Not found' })
    res.json(buildStatusPage(workspace))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
