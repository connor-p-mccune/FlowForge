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
const {
  encryptSecret,
  rewrapSecret,
  keyIdOf,
  describeKeyring,
} = require('../services/secretVault')
const activityService = require('../services/activityService')
const { recordAudit } = require('../services/auditLog')

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
      // …and the audit chain records it a second time, on purpose. The feed is
      // for people watching a workspace; this is the copy an auditor reads,
      // and it can be proven un-edited.
      recordAudit(req.params.wsId, req.user.id, existing ? 'secret.updated' : 'secret.created', {
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

// GET /api/workspaces/:wsId/secrets/keys — which encryption key each secret is
// under, and which one is active (services/secretVault.js).
//
// Owner-only, and it reveals nothing sensitive: a key *id* is a label, read off
// the stored row without any key material at all. What it answers is the
// question a rotation actually turns on — "is anything still on the old key?" —
// which is otherwise a manual read of a base64 column.
router.get('/workspaces/:wsId/secrets/keys', auth, (req, res) => {
  try {
    const role = memberRole(req.params.wsId, req.user.id)
    if (!role) return res.status(404).json({ error: 'Workspace not found' })
    if (role !== 'owner') {
      return res.status(403).json({ error: 'Only workspace owners can manage secrets' })
    }
    const ring = describeKeyring()
    const secrets = db
      .prepare('SELECT name, value_encrypted FROM workspace_secrets WHERE workspace_id = ? ORDER BY name')
      .all(req.params.wsId)
      .map((row) => ({
        name: row.name,
        keyId: keyIdOf(row.value_encrypted),
        stale: keyIdOf(row.value_encrypted) !== ring.activeKeyId,
      }))
    res.json({ ...ring, secrets, stale: secrets.filter((s) => s.stale).length })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/workspaces/:wsId/secrets/rotate — re-encrypt every secret in this
// workspace under the ring's active key.
//
// This is the operation the envelope format exists to make possible. A secret's
// value stays encrypted under its own data key throughout; only that 32-byte
// data key is unwrapped and re-wrapped, so the rotation never holds a
// credential in memory and a bug in it cannot log one. (A row still in the
// pre-envelope `v1` format is the exception — it has no data key to re-wrap, so
// it is decrypted and re-encrypted once, which is the cost of the format that
// came before.)
//
// Owner-only, idempotent, and transactional per workspace: a partial rotation
// is perfectly safe to read (the ring holds both keys) but a torn one would
// make the report lie about what moved.
router.post('/workspaces/:wsId/secrets/rotate', auth, (req, res) => {
  try {
    const role = memberRole(req.params.wsId, req.user.id)
    if (!role) return res.status(404).json({ error: 'Workspace not found' })
    if (role !== 'owner') {
      return res.status(403).json({ error: 'Only workspace owners can manage secrets' })
    }

    const rows = db
      .prepare('SELECT id, name, value_encrypted FROM workspace_secrets WHERE workspace_id = ?')
      .all(req.params.wsId)

    const rotated = []
    const failed = []
    const now = new Date().toISOString()
    // Re-encrypt outside the transaction, write inside it: a key that has been
    // retired too early throws, and it should be reported per secret rather
    // than aborting a rotation that could still move the rest.
    const updates = []
    for (const row of rows) {
      try {
        const next = rewrapSecret(row.value_encrypted)
        if (next) {
          updates.push([next, row.id])
          rotated.push(row.name)
        }
      } catch (err) {
        failed.push({ name: row.name, error: err.message })
      }
    }
    if (updates.length > 0) {
      const update = db.prepare('UPDATE workspace_secrets SET value_encrypted = ? WHERE id = ?')
      db.transaction(() => {
        for (const args of updates) update.run(...args)
      })()
    }

    // `updated_at` is deliberately not touched: re-wrapping does not change the
    // secret, and moving the timestamp would make the UI claim somebody
    // rotated the credential when nobody did.
    if (rotated.length > 0) {
      activityService.logEvent(req.params.wsId, req.user.id, 'secret.rekeyed', {
        type: 'workspace', id: req.params.wsId,
        metadata: { count: rotated.length, keyId: describeKeyring().activeKeyId },
      })
      // Re-keying is a governed action even though no value changed: an auditor
      // asking "when did we last rotate the encryption key, and who did it?"
      // needs an answer that cannot have been edited.
      recordAudit(req.params.wsId, req.user.id, 'secret.rekeyed', {
        type: 'workspace', id: req.params.wsId,
        metadata: { count: rotated.length, keyId: describeKeyring().activeKeyId, at: now },
      })
    }

    res.json({
      activeKeyId: describeKeyring().activeKeyId,
      rotated: rotated.length,
      unchanged: rows.length - rotated.length - failed.length,
      names: rotated,
      failed,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

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
    recordAudit(req.params.wsId, req.user.id, 'secret.deleted', {
      type: 'secret', id: req.params.name, name: req.params.name,
    })
    res.status(204).end()
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
