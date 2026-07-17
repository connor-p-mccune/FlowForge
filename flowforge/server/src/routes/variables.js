// Workspace variables — named, non-secret configuration values referenced from
// node configs as {{vars.NAME}}: environment base URLs, Slack channel names,
// thresholds. The plain-config counterpart to secrets, and the difference is
// the entire point: values are readable (the list endpoint returns them, so
// the UI can show and diff them) but get none of a secret's protections — no
// encryption at rest, no redaction from run logs. Anything sensitive belongs
// in {{secrets.*}} instead. Any member may list (they configure nodes against
// these names); creating, updating, and deleting are workspace-owner-only,
// mirroring secrets — workspace-level config changes every workflow at once.

const express = require('express')
const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const auth = require('../middleware/auth')
const { validate } = require('../middleware/validate')
const activityService = require('../services/activityService')

const router = express.Router()

// Same identifier grammar as secrets, so {{vars.API_BASE_URL}} tokenizes
// cleanly with the engine's placeholder pattern ([\w-]+ segments).
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

const MAX_VARIABLES_PER_WORKSPACE = 200

function memberRole(workspaceId, userId) {
  const row = db.prepare(
    'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
  ).get(workspaceId, userId)
  return row ? row.role : null
}

function getVariable(workspaceId, name) {
  return db.prepare(
    `SELECT v.name, v.value, v.created_at, v.updated_at, u.display_name AS created_by_name
       FROM workspace_variables v
       LEFT JOIN users u ON u.id = v.created_by
      WHERE v.workspace_id = ? AND v.name = ?`
  ).get(workspaceId, name)
}

// GET /api/workspaces/:wsId/variables — names AND values. Unlike secrets,
// values round-trip: that readability is what makes a variable a variable.
router.get('/workspaces/:wsId/variables', auth, (req, res) => {
  try {
    if (!memberRole(req.params.wsId, req.user.id)) {
      return res.status(404).json({ error: 'Workspace not found' })
    }
    const variables = db.prepare(
      `SELECT v.name, v.value, v.created_at, v.updated_at, u.display_name AS created_by_name
         FROM workspace_variables v
         LEFT JOIN users u ON u.id = v.created_by
        WHERE v.workspace_id = ?
        ORDER BY v.name`
    ).all(req.params.wsId)
    res.json({ variables })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/workspaces/:wsId/variables/:name — create or update. Owner-only.
router.put(
  '/workspaces/:wsId/variables/:name',
  auth,
  validate({ value: { required: true, type: 'string', maxLength: 4096 } }),
  (req, res) => {
    try {
      const role = memberRole(req.params.wsId, req.user.id)
      if (!role) return res.status(404).json({ error: 'Workspace not found' })
      if (role !== 'owner') {
        return res.status(403).json({ error: 'Only workspace owners can manage variables' })
      }

      const name = req.params.name
      if (!NAME_PATTERN.test(name)) {
        return res.status(400).json({
          error: 'Variable name must start with a letter and use only letters, numbers, and underscores (max 64 chars)',
        })
      }

      const existing = db.prepare(
        'SELECT id FROM workspace_variables WHERE workspace_id = ? AND name = ?'
      ).get(req.params.wsId, name)

      if (!existing) {
        const { count } = db.prepare(
          'SELECT COUNT(*) AS count FROM workspace_variables WHERE workspace_id = ?'
        ).get(req.params.wsId)
        if (count >= MAX_VARIABLES_PER_WORKSPACE) {
          return res.status(400).json({
            error: `A workspace can hold at most ${MAX_VARIABLES_PER_WORKSPACE} variables`,
          })
        }
      }

      const now = new Date().toISOString()
      if (existing) {
        db.prepare(
          'UPDATE workspace_variables SET value = ?, updated_at = ? WHERE id = ?'
        ).run(req.body.value, now, existing.id)
      } else {
        db.prepare(
          `INSERT INTO workspace_variables (id, workspace_id, name, value, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(uuidv4(), req.params.wsId, name, req.body.value, req.user.id, now, now)
      }

      activityService.logEvent(req.params.wsId, req.user.id, existing ? 'variable.updated' : 'variable.created', {
        type: 'variable', id: name, name,
      })

      res.status(existing ? 200 : 201).json({ variable: getVariable(req.params.wsId, name) })
    } catch (err) {
      console.error(err)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
)

// DELETE /api/workspaces/:wsId/variables/:name — owner-only.
router.delete('/workspaces/:wsId/variables/:name', auth, (req, res) => {
  try {
    const role = memberRole(req.params.wsId, req.user.id)
    if (!role) return res.status(404).json({ error: 'Workspace not found' })
    if (role !== 'owner') {
      return res.status(403).json({ error: 'Only workspace owners can manage variables' })
    }

    const result = db.prepare(
      'DELETE FROM workspace_variables WHERE workspace_id = ? AND name = ?'
    ).run(req.params.wsId, req.params.name)
    if (result.changes === 0) return res.status(404).json({ error: 'Variable not found' })

    activityService.logEvent(req.params.wsId, req.user.id, 'variable.deleted', {
      type: 'variable', id: req.params.name, name: req.params.name,
    })
    res.status(204).end()
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
