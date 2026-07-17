// GET /api/search — full-text search over every workspace the caller belongs
// to (services/workflowSearch.js): workflow names, descriptions, and what's
// *inside* the graphs — node labels, config strings, sticky-note text. Backs
// the command palette's deep results; the public API exposes the same via
// GET /api/v1/search.

const express = require('express')
const db = require('../config/database')
const auth = require('../middleware/auth')
const { searchWorkflows } = require('../services/workflowSearch')

const router = express.Router()

router.get('/search', auth, (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    if (!q) return res.status(400).json({ error: 'q is required' })
    if (q.length > 200) return res.status(400).json({ error: 'q must be at most 200 characters' })

    const workspaceIds = db.prepare(
      'SELECT workspace_id FROM workspace_members WHERE user_id = ?'
    ).all(req.user.id).map((r) => r.workspace_id)

    const results = searchWorkflows(workspaceIds, q, { limit: req.query.limit })
    res.json({ results })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
