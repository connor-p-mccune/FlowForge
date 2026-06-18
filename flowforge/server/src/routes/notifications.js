const express = require('express')
const db = require('../config/database')
const auth = require('../middleware/auth')

const router = express.Router()

// GET /api/notifications — the current user's 50 most recent, newest first,
// plus the unread count for the bell badge.
router.get('/notifications', auth, (req, res) => {
  try {
    const notifications = db.prepare(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
    ).all(req.user.id)
    const { unreadCount } = db.prepare(
      'SELECT COUNT(*) AS unreadCount FROM notifications WHERE user_id = ? AND is_read = 0'
    ).get(req.user.id)
    res.json({ notifications, unreadCount })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/notifications/read-all — mark every unread notification as read.
// Declared before the :id route so "read-all" isn't captured as an :id.
router.put('/notifications/read-all', auth, (req, res) => {
  try {
    db.prepare(
      'UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0'
    ).run(req.user.id)
    res.json({ unreadCount: 0 })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/notifications/:id/read — mark one as read. Scoped to the owner so a
// user can't touch someone else's notification (a non-owned id reads as 404).
router.put('/notifications/:id/read', auth, (req, res) => {
  try {
    const result = db.prepare(
      'UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?'
    ).run(req.params.id, req.user.id)
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Notification not found' })
    }
    const notification = db.prepare('SELECT * FROM notifications WHERE id = ?').get(req.params.id)
    res.json({ notification })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
