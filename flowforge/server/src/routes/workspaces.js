const express = require('express')
const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const auth = require('../middleware/auth')

const router = express.Router()

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

router.post('/workspaces', auth, (req, res) => {
  try {
    const { name } = req.body
    if (!name) return res.status(400).json({ error: 'name is required' })

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

router.put('/workspaces/:id', auth, (req, res) => {
  try {
    const member = db.prepare(
      'SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
    ).get(req.params.id, req.user.id)
    if (!member) return res.status(404).json({ error: 'Workspace not found' })

    const { name } = req.body
    if (!name) return res.status(400).json({ error: 'name is required' })

    db.prepare('UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?')
      .run(name, new Date().toISOString(), req.params.id)

    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.id)
    res.json({ workspace })
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
