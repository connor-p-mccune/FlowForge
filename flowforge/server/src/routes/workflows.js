const express = require('express')
const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const auth = require('../middleware/auth')
const { validate } = require('../middleware/validate')

const router = express.Router()

// Parse a stored graph_json into a normalized { nodes, edges } object with both
// guaranteed to be arrays, tolerating a corrupt/empty column.
function parseGraphData(graphJson) {
  try {
    const parsed = JSON.parse(graphJson)
    return {
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      edges: Array.isArray(parsed.edges) ? parsed.edges : [],
    }
  } catch {
    return { nodes: [], edges: [] }
  }
}

const workflowRule = {
  name: { required: true, type: 'string', maxLength: 200 },
  description: { type: 'string', maxLength: 2000 },
}
const graphRule = {
  nodes: { required: true, type: 'array', maxItems: 2000 },
  edges: { required: true, type: 'array', maxItems: 5000 },
}

// Import accepts the parsed contents of an exported file. graph_data is validated
// as an object here; its nodes/edges arrays are checked in the handler (the
// validate helper doesn't recurse into nested shapes).
const importRule = {
  name: { required: true, type: 'string', maxLength: 200 },
  graph_data: { required: true, type: 'object' },
}

// Reject an imported graph whose serialized form exceeds this. The global 2mb
// body cap (index.js) is the outer backstop; this keeps a single imported graph
// to a sane size regardless of the rest of the payload.
const MAX_IMPORT_GRAPH_BYTES = 500 * 1024 // 500KB

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

router.post('/workspaces/:wsId/workflows', auth, validate(workflowRule), (req, res) => {
  try {
    if (!isMember(req.params.wsId, req.user.id)) {
      return res.status(404).json({ error: 'Workspace not found' })
    }
    const { name, description } = req.body

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

// POST /api/workspaces/:wsId/workflows/import — create a new draft workflow from
// the parsed contents of an exported file ({ name, graph_data }). graph_data must
// be an object holding nodes[] and edges[]; the serialized graph is size-capped.
// (The /import segment keeps this distinct from POST /workspaces/:wsId/workflows.)
router.post('/workspaces/:wsId/workflows/import', auth, validate(importRule), (req, res) => {
  try {
    if (!isMember(req.params.wsId, req.user.id)) {
      return res.status(404).json({ error: 'Workspace not found' })
    }
    const { name, graph_data } = req.body
    if (!Array.isArray(graph_data.nodes) || !Array.isArray(graph_data.edges)) {
      return res.status(400).json({ error: 'graph_data must include nodes and edges arrays' })
    }

    // Persist only the { nodes, edges } the canvas understands, dropping any other
    // top-level keys so an import can't smuggle in extra data, then size-check it.
    const graphJson = JSON.stringify({ nodes: graph_data.nodes, edges: graph_data.edges })
    if (Buffer.byteLength(graphJson, 'utf8') > MAX_IMPORT_GRAPH_BYTES) {
      return res.status(413).json({ error: 'Workflow graph is too large (max 500KB)' })
    }

    const id = uuidv4()
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO workflows (id, workspace_id, name, description, graph_json, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)"
    ).run(id, req.params.wsId, name, null, graphJson, req.user.id, now, now)

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

// GET /api/workflows/:id/export — return the workflow in a portable, self-
// contained shape (no internal ids/ownership) that POST .../import can recreate.
// Not a file download: the client turns this JSON into a Blob and saves it.
router.get('/workflows/:id/export', auth, (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }
    res.json({
      exportVersion: '1.0',
      name: workflow.name,
      description: workflow.description,
      graph_data: parseGraphData(workflow.graph_json),
      exportedAt: new Date().toISOString(),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/workflows/:id', auth, validate(workflowRule), (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }
    const { name, description } = req.body

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

router.put('/workflows/:id/graph', auth, validate(graphRule), (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }
    const { nodes, edges } = req.body

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
