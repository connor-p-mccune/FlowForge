const express = require('express')
const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const auth = require('../middleware/auth')

const router = express.Router()

function isMember(workspaceId, userId) {
  return db.prepare(
    'SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
  ).get(workspaceId, userId)
}

router.get('/workspaces/:wsId/workflows', auth, (req, res) => {
  try {
    if (!isMember(req.params.wsId, req.user.id)) {
      return res.status(404).json({ error: 'Workspace not found' })
    }
    const workflows = db.prepare(
      'SELECT * FROM workflows WHERE workspace_id = ? ORDER BY created_at DESC'
    ).all(req.params.wsId)
    res.json({ workflows })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/workspaces/:wsId/workflows', auth, (req, res) => {
  try {
    if (!isMember(req.params.wsId, req.user.id)) {
      return res.status(404).json({ error: 'Workspace not found' })
    }
    const { name, description } = req.body
    if (!name) return res.status(400).json({ error: 'name is required' })

    const id = uuidv4()
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO workflows (id, workspace_id, name, description, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, req.params.wsId, name, description || null, req.user.id, now, now)

    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id)
    res.status(201).json({ workflow })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/workflows/:id', auth, (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    if (!isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }
    res.json({ workflow })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/workflows/:id', auth, (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }
    const { name, description } = req.body
    if (!name) return res.status(400).json({ error: 'name is required' })

    const now = new Date().toISOString()
    db.prepare(
      'UPDATE workflows SET name = ?, description = ?, updated_at = ? WHERE id = ?'
    ).run(name, description ?? workflow.description, now, req.params.id)

    const updated = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    res.json({ workflow: updated })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/workflows/:id/graph', auth, (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }
    const { nodes, edges } = req.body
    if (!Array.isArray(nodes) || !Array.isArray(edges)) {
      return res.status(400).json({ error: 'nodes and edges must be arrays' })
    }

    const graphJson = JSON.stringify({ nodes, edges })
    const now = new Date().toISOString()
    db.prepare(
      'UPDATE workflows SET graph_json = ?, updated_at = ? WHERE id = ?'
    ).run(graphJson, now, req.params.id)

    res.json({ ok: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.delete('/workflows/:id', auth, (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }
    db.prepare('DELETE FROM workflows WHERE id = ?').run(req.params.id)
    res.status(204).end()
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
