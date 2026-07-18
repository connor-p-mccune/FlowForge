const express = require('express')
const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const auth = require('../middleware/auth')
const { validate, EMAIL_PATTERN } = require('../middleware/validate')
const { createNotification } = require('../services/notificationService')
const activityService = require('../services/activityService')
const { forbidViewer } = require('../services/workspaceRoles')

const router = express.Router()

const nameRule = { name: { required: true, type: 'string', maxLength: 200 } }

router.get('/workspaces', auth, (req, res) => {
  try {
    const workspaces = db.prepare(`
      SELECT w.* FROM workspaces w
      JOIN workspace_members wm ON wm.workspace_id = w.id
      WHERE wm.user_id = ?
      ORDER BY w.created_at DESC
    `).all(req.user.id)
    res.json({ workspaces })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/workspaces', auth, validate(nameRule), (req, res) => {
  try {
    const { name } = req.body

    const id = uuidv4()
    const now = new Date().toISOString()

    db.prepare(
      'INSERT INTO workspaces (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, name, req.user.id, now, now)

    db.prepare(
      'INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
    ).run(id, req.user.id, 'owner', now)

    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id)
    res.status(201).json({ workspace })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/workspaces/:id', auth, (req, res) => {
  try {
    const member = db.prepare(
      'SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
    ).get(req.params.id, req.user.id)
    if (!member) return res.status(404).json({ error: 'Workspace not found' })

    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.id)
    res.json({ workspace })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/workspaces/:id', auth, validate(nameRule), (req, res) => {
  try {
    const member = db.prepare(
      'SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
    ).get(req.params.id, req.user.id)
    if (!member) return res.status(404).json({ error: 'Workspace not found' })
    if (forbidViewer(res, req.params.id, req.user.id)) return

    const { name } = req.body

    db.prepare('UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?')
      .run(name, new Date().toISOString(), req.params.id)

    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.id)
    res.json({ workspace })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/workspaces/:id/members — who is in the workspace and with what
// role. Any member (viewers included) may look: knowing who can edit is part
// of understanding what you're looking at.
router.get('/workspaces/:id/members', auth, (req, res) => {
  try {
    const requester = db.prepare(
      'SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
    ).get(req.params.id, req.user.id)
    if (!requester) return res.status(404).json({ error: 'Workspace not found' })

    const members = db.prepare(
      `SELECT m.user_id, m.role, m.joined_at, u.display_name, u.email
         FROM workspace_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = ?
        ORDER BY m.joined_at`
    ).all(req.params.id)
    res.json({
      members: members.map((m) => ({
        userId: m.user_id,
        displayName: m.display_name,
        email: m.email,
        role: m.role,
        joinedAt: m.joined_at,
      })),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/workspaces/:id/members — invite an existing user (by email) into the
// workspace and send them an in-app notification. Any current editor can
// invite (viewers can't grow the workspace). `role` picks what the invitee
// may do: 'member' (default) edits, 'viewer' observes. Ownership is never
// granted by invitation — promote via PUT .../members/:userId afterwards, so
// handing over the keys is always its own deliberate act.
router.post(
  '/workspaces/:id/members',
  auth,
  validate({
    email: {
      required: true, type: 'string', maxLength: 320,
      pattern: EMAIL_PATTERN, patternMessage: 'email is invalid',
    },
  }),
  (req, res) => {
    try {
      const inviter = db.prepare(
        'SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
      ).get(req.params.id, req.user.id)
      // Same as elsewhere: don't reveal a workspace the caller can't see.
      if (!inviter) return res.status(404).json({ error: 'Workspace not found' })
      if (forbidViewer(res, req.params.id, req.user.id)) return

      const role = req.body.role === undefined ? 'member' : req.body.role
      if (role !== 'member' && role !== 'viewer') {
        return res.status(400).json({ error: 'role must be "member" or "viewer"' })
      }

      const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.id)

      const invitee = db.prepare('SELECT * FROM users WHERE email = ?').get(req.body.email)
      if (!invitee) return res.status(404).json({ error: 'No user with that email' })

      const already = db.prepare(
        'SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
      ).get(req.params.id, invitee.id)
      if (already) return res.status(409).json({ error: 'User is already a member' })

      db.prepare(
        'INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
      ).run(req.params.id, invitee.id, role, new Date().toISOString())

      createNotification(invitee.id, {
        type: 'workspace-invite',
        title: 'Workspace Invitation',
        message: `${req.user.displayName} added you to ${workspace.name}`,
        link: '/',
      })

      activityService.logEvent(req.params.id, req.user.id, 'member.invited', {
        type: 'member', id: invitee.id, name: invitee.display_name,
        metadata: { role },
      })

      res.status(201).json({ member: { userId: invitee.id, role } })
    } catch (err) {
      console.error(err)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
)

// PUT /api/workspaces/:id/members/:userId { role } — change a member's role.
// Owner-only, with the same last-owner guard removal has: a workspace must
// always keep at least one owner, so demoting the last one is refused. This
// route is also the only way to mint a new owner — invitations top out at
// 'member' on purpose.
router.put('/workspaces/:id/members/:userId', auth, (req, res) => {
  try {
    const requester = db.prepare(
      "SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role = 'owner'"
    ).get(req.params.id, req.user.id)
    if (!requester) return res.status(403).json({ error: 'Not authorized' })

    const role = req.body?.role
    if (!['owner', 'member', 'viewer'].includes(role)) {
      return res.status(400).json({ error: 'role must be "owner", "member", or "viewer"' })
    }

    const target = db.prepare(
      `SELECT m.role, u.id AS user_id, u.display_name
         FROM workspace_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = ? AND m.user_id = ?`
    ).get(req.params.id, req.params.userId)
    if (!target) return res.status(404).json({ error: 'Member not found' })

    if (target.role === 'owner' && role !== 'owner') {
      const { owners } = db.prepare(
        "SELECT COUNT(*) AS owners FROM workspace_members WHERE workspace_id = ? AND role = 'owner'"
      ).get(req.params.id)
      if (owners <= 1) {
        return res.status(400).json({ error: 'Cannot demote the last owner' })
      }
    }

    db.prepare(
      'UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?'
    ).run(role, req.params.id, req.params.userId)

    activityService.logEvent(req.params.id, req.user.id, 'member.role_changed', {
      type: 'member', id: target.user_id, name: target.display_name,
      metadata: { from: target.role, to: role },
    })

    res.json({ member: { userId: target.user_id, role } })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/workspaces/:id/members/:userId — remove a member. Owner-only, and
// the workspace must keep at least one owner (you can't remove the last owner).
router.delete('/workspaces/:id/members/:userId', auth, (req, res) => {
  try {
    const requester = db.prepare(
      "SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role = 'owner'"
    ).get(req.params.id, req.user.id)
    if (!requester) return res.status(403).json({ error: 'Not authorized' })

    const target = db.prepare(
      `SELECT m.role, u.id AS user_id, u.display_name
         FROM workspace_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = ? AND m.user_id = ?`
    ).get(req.params.id, req.params.userId)
    if (!target) return res.status(404).json({ error: 'Member not found' })

    // Don't strand the workspace: refuse to remove its last owner.
    if (target.role === 'owner') {
      const { owners } = db.prepare(
        "SELECT COUNT(*) AS owners FROM workspace_members WHERE workspace_id = ? AND role = 'owner'"
      ).get(req.params.id)
      if (owners <= 1) {
        return res.status(400).json({ error: 'Cannot remove the last owner' })
      }
    }

    db.prepare(
      'DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
    ).run(req.params.id, req.params.userId)

    activityService.logEvent(req.params.id, req.user.id, 'member.removed', {
      type: 'member', id: target.user_id, name: target.display_name,
    })

    res.status(204).end()
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.delete('/workspaces/:id', auth, (req, res) => {
  try {
    const member = db.prepare(
      "SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role = 'owner'"
    ).get(req.params.id, req.user.id)
    if (!member) return res.status(403).json({ error: 'Not authorized' })

    db.prepare('DELETE FROM workspaces WHERE id = ?').run(req.params.id)
    res.status(204).end()
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
