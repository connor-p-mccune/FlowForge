// Workspace secrets — named credentials referenced from node configs as
// {{secrets.NAME}}. Values are AES-256-GCM encrypted before insert (see
// services/secretVault.js) and are write-only through this API: the list
// endpoint returns names + metadata, never a value, so a secret can be rotated
// but not read back out. Any member may list names (they need to know what
// {{secrets.*}} references are available); creating, rotating, and deleting are
// workspace-owner-only.

const express = require('express')
const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const auth = require('../middleware/auth')
const { validate } = require('../middleware/validate')
const { encryptSecret } = require('../services/secretVault')
const activityService = require('../services/activityService')

const router = express.Router()

// UPPER_SNAKE-style identifiers keep templates unambiguous: {{secrets.API_KEY}}
// tokenizes cleanly with the engine's placeholder grammar ([\w-]+ segments).
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

const MAX_SECRETS_PER_WORKSPACE = 100

function memberRole(workspaceId, userId) {
  const row = db.prepare(
    'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
  ).get(workspaceId, userId)
  return row ? row.role : null
}

// GET /api/workspaces/:wsId/secrets — names + metadata only, values never leave
// the server. Any workspace member may list.
router.get('/workspaces/:wsId/secrets', auth, (req, res) => {
  try {
    if (!memberRole(req.params.wsId, req.user.id)) {
      return res.status(404).json({ error: 'Workspace not found' })
    }
    const secrets = db.prepare(
      `SELECT s.name, s.created_at, s.updated_at, u.display_name AS created_by_name
         FROM workspace_secrets s
         LEFT JOIN users u ON u.id = s.created_by
        WHERE s.workspace_id = ?
        ORDER BY s.name`
    ).all(req.params.wsId)
    res.json({ secrets })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/workspaces/:wsId/secrets/:name — create or rotate a secret.
// Owner-only. Responds with metadata only; the value is accepted, encrypted,
// and never echoed back.
router.put(
  '/workspaces/:wsId/secrets/:name',
  auth,
  validate({ value: { required: true, type: 'string', maxLength: 4096 } }),
  (req, res) => {
    try {
      const role = memberRole(req.params.wsId, req.user.id)
      if (!role) return res.status(404).json({ error: 'Workspace not found' })
      if (role !== 'owner') {
        return res.status(403).json({ error: 'Only workspace owners can manage secrets' })
      }

      const name = req.params.name
      if (!NAME_PATTERN.test(name)) {
        return res.status(400).json({
          error: 'Secret name must start with a letter and use only letters, numbers, and underscores (max 64 chars)',
        })
      }

      const existing = db.prepare(
        'SELECT id FROM workspace_secrets WHERE workspace_id = ? AND name = ?'
      ).get(req.params.wsId, name)

      if (!existing) {
        const { count } = db.prepare(
          'SELECT COUNT(*) AS count FROM workspace_secrets WHERE workspace_id = ?'
        ).get(req.params.wsId)
        if (count >= MAX_SECRETS_PER_WORKSPACE) {
          return res.status(400).json({
            error: `A workspace can hold at most ${MAX_SECRETS_PER_WORKSPACE} secrets`,
          })
        }
      }

      const encrypted = encryptSecret(req.body.value)
      const now = new Date().toISOString()
      if (existing) {
        db.prepare(
          'UPDATE workspace_secrets SET value_encrypted = ?, updated_at = ? WHERE id = ?'
        ).run(encrypted, now, existing.id)
      } else {
        db.prepare(
          `INSERT INTO workspace_secrets (id, workspace_id, name, value_encrypted, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(uuidv4(), req.params.wsId, name, encrypted, req.user.id, now, now)
      }

      // The feed records that a secret changed — never what it holds.
      activityService.logEvent(req.params.wsId, req.user.id, existing ? 'secret.updated' : 'secret.created', {
        type: 'secret', id: name, name,
      })

      const secret = db.prepare(
        `SELECT s.name, s.created_at, s.updated_at, u.display_name AS created_by_name
           FROM workspace_secrets s
           LEFT JOIN users u ON u.id = s.created_by
          WHERE s.workspace_id = ? AND s.name = ?`
      ).get(req.params.wsId, name)
      res.status(existing ? 200 : 201).json({ secret })
    } catch (err) {
      console.error(err)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
)

// DELETE /api/workspaces/:wsId/secrets/:name — owner-only.
router.delete('/workspaces/:wsId/secrets/:name', auth, (req, res) => {
  try {
    const role = memberRole(req.params.wsId, req.user.id)
    if (!role) return res.status(404).json({ error: 'Workspace not found' })
    if (role !== 'owner') {
      return res.status(403).json({ error: 'Only workspace owners can manage secrets' })
    }

    const result = db.prepare(
      'DELETE FROM workspace_secrets WHERE workspace_id = ? AND name = ?'
    ).run(req.params.wsId, req.params.name)
    if (result.changes === 0) return res.status(404).json({ error: 'Secret not found' })

    activityService.logEvent(req.params.wsId, req.user.id, 'secret.deleted', {
      type: 'secret', id: req.params.name, name: req.params.name,
    })
    res.status(204).end()
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
