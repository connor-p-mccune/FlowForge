const express = require('express')
const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const auth = require('../middleware/auth')
const { validate, EMAIL_PATTERN } = require('../middleware/validate')
const { createNotification } = require('../services/notificationService')

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

// POST /api/workspaces/:id/members — invite an existing user (by email) into the
// workspace and send them an in-app notification. Any current member can invite.
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

      const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.id)

      const invitee = db.prepare('SELECT * FROM users WHERE email = ?').get(req.body.email)
      if (!invitee) return res.status(404).json({ error: 'No user with that email' })

      const already = db.prepare(
        'SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
      ).get(req.params.id, invitee.id)
      if (already) return res.status(409).json({ error: 'User is already a member' })

      db.prepare(
        'INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
      ).run(req.params.id, invitee.id, 'member', new Date().toISOString())

      createNotification(invitee.id, {
        type: 'workspace-invite',
        title: 'Workspace Invitation',
        message: `${req.user.displayName} added you to ${workspace.name}`,
        link: '/',
      })

      res.status(201).json({ member: { userId: invitee.id, role: 'member' } })
    } catch (err) {
      console.error(err)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
)

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
