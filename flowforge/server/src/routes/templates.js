const express = require('express')
const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const auth = require('../middleware/auth')
const { validate } = require('../middleware/validate')

const router = express.Router()

// Mirrors workflows.js: every workspace-scoped action is gated on membership.
function isMember(workspaceId, userId) {
  return db.prepare(
    'SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
  ).get(workspaceId, userId)
}

// GET /api/templates — public. Returns the built-in templates grouped by
// category, with graph_data parsed into a { nodes, edges } object so the gallery
// can render previews without re-parsing.
router.get('/templates', (req, res) => {
  try {
    const rows = db.prepare(
      'SELECT id, name, description, category, graph_data FROM templates ORDER BY category, name'
    ).all()

    const grouped = {}
    for (const row of rows) {
      let graph
      try {
        graph = JSON.parse(row.graph_data)
      } catch {
        graph = { nodes: [], edges: [] }
      }
      if (!grouped[row.category]) grouped[row.category] = []
      grouped[row.category].push({
        id: row.id,
        name: row.name,
        description: row.description,
        category: row.category,
        graph,
      })
    }

    res.json({ templates: grouped })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const fromTemplateRule = {
  templateId: { required: true, type: 'string', maxLength: 200 },
  name: { required: true, type: 'string', maxLength: 200 },
}

// POST /api/workspaces/:wsId/workflows/from-template — protected. Clones a
// template's graph into a brand-new workflow in the workspace and returns it.
// (Path sits under the workflows namespace but lives here to keep template
// concerns together; the extra /from-template segment avoids any route clash
// with POST /workspaces/:wsId/workflows in routes/workflows.js.)
router.post(
  '/workspaces/:wsId/workflows/from-template',
  auth,
  validate(fromTemplateRule),
  (req, res) => {
    try {
      if (!isMember(req.params.wsId, req.user.id)) {
        return res.status(404).json({ error: 'Workspace not found' })
      }
      const { templateId, name } = req.body

      const template = db.prepare('SELECT * FROM templates WHERE id = ?').get(templateId)
      if (!template) return res.status(404).json({ error: 'Template not found' })

      // Normalise to the same { nodes, edges } shape workflows.graph_json stores,
      // so the cloned workflow opens and runs exactly like a hand-built one.
      let parsed
      try {
        parsed = JSON.parse(template.graph_data)
      } catch {
        parsed = {}
      }
      const graphJson = JSON.stringify({
        nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
        edges: Array.isArray(parsed.edges) ? parsed.edges : [],
      })

      const id = uuidv4()
      const now = new Date().toISOString()
      db.prepare(
        'INSERT INTO workflows (id, workspace_id, name, description, graph_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(id, req.params.wsId, name, template.description || null, graphJson, req.user.id, now, now)

      const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id)
      res.status(201).json({ workflow })
    } catch (err) {
      console.error(err)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
)

module.exports = router
