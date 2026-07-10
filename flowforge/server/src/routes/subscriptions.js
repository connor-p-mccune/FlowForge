// Outbound webhook subscriptions — a workspace's external URLs that receive
// its activity events (see services/eventDispatcher.js for delivery). Reads
// are member-level; anything that changes what leaves the workspace (create,
// edit, delete, redeliver, test-ping) is owner-only, mirroring secrets. The
// signing secret is returned exactly once, at creation, and never read back.

const express = require('express')
const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const auth = require('../middleware/auth')
const { generateSigningSecret } = require('../services/webhookSignature')
const { assertAllowedUrl, assertSafeUrl, enforced } = require('../services/ssrfGuard')
const { attemptDelivery } = require('../services/eventDispatcher')
const activityService = require('../services/activityService')

const router = express.Router()

const MAX_SUBSCRIPTIONS_PER_WORKSPACE = 20
// '*', 'family.*', or 'family.action' — the shapes matchesPattern understands.
const PATTERN_SHAPE = /^(\*|[a-z]+(?:-[a-z]+)*\.(?:\*|[a-z]+(?:[._-][a-z]+)*))$/i

function memberRole(workspaceId, userId) {
  const row = db.prepare(
    'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
  ).get(workspaceId, userId)
  return row ? row.role : null
}

// Owner-only gate shared by every mutating route. Returns the role or null
// after responding.
function requireOwner(req, res) {
  const role = memberRole(req.params.wsId, req.user.id)
  if (!role) {
    res.status(404).json({ error: 'Workspace not found' })
    return null
  }
  if (role !== 'owner') {
    res.status(403).json({ error: 'Only workspace owners can manage outbound webhooks' })
    return null
  }
  return role
}

// Scheme check always; full private-range resolution only when the SSRF guard
// is enforced, mirroring what delivery-time safeFetch will do. Rejecting here
// turns a delivery that could never work into a friendly 400 at create time.
async function validateUrl(raw) {
  assertAllowedUrl(raw)
  if (enforced()) await assertSafeUrl(raw)
}

function validateEvents(events) {
  if (!Array.isArray(events) || events.length === 0 || events.length > 20) {
    return 'events must be a non-empty array of up to 20 patterns'
  }
  for (const pattern of events) {
    if (typeof pattern !== 'string' || pattern.length > 64 || !PATTERN_SHAPE.test(pattern)) {
      return `"${pattern}" is not a valid event pattern — use "*", "family.*", or "family.action"`
    }
  }
  return null
}

// Public row shape: everything except the secret.
function present(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    url: row.url,
    description: row.description,
    events: JSON.parse(row.events),
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    createdByName: row.created_by_name ?? null,
  }
}

function getSubscription(wsId, id) {
  return db.prepare(
    'SELECT * FROM event_subscriptions WHERE id = ? AND workspace_id = ?'
  ).get(id, wsId)
}

// GET /api/workspaces/:wsId/subscriptions — any member may list. Each row
// carries lightweight delivery stats so the UI can flag a failing endpoint
// without fetching every log.
router.get('/workspaces/:wsId/subscriptions', auth, (req, res) => {
  try {
    if (!memberRole(req.params.wsId, req.user.id)) {
      return res.status(404).json({ error: 'Workspace not found' })
    }
    const rows = db.prepare(
      `SELECT s.*, u.display_name AS created_by_name,
              (SELECT COUNT(*) FROM event_deliveries d
                WHERE d.subscription_id = s.id AND d.status = 'delivered') AS delivered_count,
              (SELECT COUNT(*) FROM event_deliveries d
                WHERE d.subscription_id = s.id AND d.status = 'failed') AS failed_count
         FROM event_subscriptions s
         LEFT JOIN users u ON u.id = s.created_by
        WHERE s.workspace_id = ?
        ORDER BY s.created_at DESC`
    ).all(req.params.wsId)
    res.json({
      subscriptions: rows.map((row) => ({
        ...present(row),
        deliveredCount: row.delivered_count,
        failedCount: row.failed_count,
      })),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/workspaces/:wsId/subscriptions { url, events, description? } —
// owner-only. The response is the only time the signing secret is visible.
router.post('/workspaces/:wsId/subscriptions', auth, async (req, res) => {
  try {
    if (!requireOwner(req, res)) return

    const { url, events, description } = req.body || {}
    if (typeof url !== 'string' || !url.trim()) {
      return res.status(400).json({ error: 'url is required' })
    }
    const eventsError = validateEvents(events)
    if (eventsError) return res.status(400).json({ error: eventsError })
    try {
      await validateUrl(url.trim())
    } catch (err) {
      return res.status(400).json({ error: err.message })
    }

    const { count } = db.prepare(
      'SELECT COUNT(*) AS count FROM event_subscriptions WHERE workspace_id = ?'
    ).get(req.params.wsId)
    if (count >= MAX_SUBSCRIPTIONS_PER_WORKSPACE) {
      return res.status(400).json({
        error: `A workspace can have at most ${MAX_SUBSCRIPTIONS_PER_WORKSPACE} outbound webhooks`,
      })
    }

    const id = uuidv4()
    const secret = generateSigningSecret()
    db.prepare(
      `INSERT INTO event_subscriptions (id, workspace_id, url, description, events, secret, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, req.params.wsId, url.trim(),
      typeof description === 'string' && description.trim() ? description.trim().slice(0, 200) : null,
      JSON.stringify(events), secret, req.user.id
    )

    activityService.logEvent(req.params.wsId, req.user.id, 'subscription.created', {
      type: 'subscription',
      id,
      name: url.trim(),
    })

    const row = getSubscription(req.params.wsId, id)
    res.status(201).json({ subscription: { ...present(row), secret } })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PATCH /api/workspaces/:wsId/subscriptions/:id — owner-only partial update:
// url, events, description, isActive (pause/resume without losing the secret).
router.patch('/workspaces/:wsId/subscriptions/:id', auth, async (req, res) => {
  try {
    if (!requireOwner(req, res)) return
    const existing = getSubscription(req.params.wsId, req.params.id)
    if (!existing) return res.status(404).json({ error: 'Subscription not found' })

    const { url, events, description, isActive } = req.body || {}
    const updates = {}
    if (url !== undefined) {
      if (typeof url !== 'string' || !url.trim()) {
        return res.status(400).json({ error: 'url must be a non-empty string' })
      }
      try {
        await validateUrl(url.trim())
      } catch (err) {
        return res.status(400).json({ error: err.message })
      }
      updates.url = url.trim()
    }
    if (events !== undefined) {
      const eventsError = validateEvents(events)
      if (eventsError) return res.status(400).json({ error: eventsError })
      updates.events = JSON.stringify(events)
    }
    if (description !== undefined) {
      updates.description =
        typeof description === 'string' && description.trim() ? description.trim().slice(0, 200) : null
    }
    if (isActive !== undefined) updates.is_active = isActive ? 1 : 0
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Nothing to update' })
    }

    const assignments = Object.keys(updates).map((k) => `${k} = ?`).join(', ')
    db.prepare(`UPDATE event_subscriptions SET ${assignments} WHERE id = ?`).run(
      ...Object.values(updates), existing.id
    )

    const row = getSubscription(req.params.wsId, existing.id)
    res.json({ subscription: present(row) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/workspaces/:wsId/subscriptions/:id — owner-only. Deliveries
// cascade with the row; history for a deleted endpoint has no audience.
router.delete('/workspaces/:wsId/subscriptions/:id', auth, (req, res) => {
  try {
    if (!requireOwner(req, res)) return
    const existing = getSubscription(req.params.wsId, req.params.id)
    if (!existing) return res.status(404).json({ error: 'Subscription not found' })

    db.prepare('DELETE FROM event_subscriptions WHERE id = ?').run(existing.id)
    activityService.logEvent(req.params.wsId, req.user.id, 'subscription.deleted', {
      type: 'subscription',
      id: existing.id,
      name: existing.url,
    })
    res.json({ ok: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/workspaces/:wsId/subscriptions/:id/deliveries — the recent delivery
// log, newest first. Member-level: this is the debugging surface.
router.get('/workspaces/:wsId/subscriptions/:id/deliveries', auth, (req, res) => {
  try {
    if (!memberRole(req.params.wsId, req.user.id)) {
      return res.status(404).json({ error: 'Workspace not found' })
    }
    if (!getSubscription(req.params.wsId, req.params.id)) {
      return res.status(404).json({ error: 'Subscription not found' })
    }
    const deliveries = db.prepare(
      `SELECT id, event_type, status, attempts, response_status, error,
              created_at, delivered_at, next_attempt_at
         FROM event_deliveries
        WHERE subscription_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT 50`
    ).all(req.params.id)
    res.json({ deliveries })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST .../deliveries/:deliveryId/redeliver — owner-only manual retry. One
// synchronous attempt with the same delivery id (receivers can deduplicate),
// answering with the settled row so the UI updates in place.
router.post(
  '/workspaces/:wsId/subscriptions/:id/deliveries/:deliveryId/redeliver',
  auth,
  async (req, res) => {
    try {
      if (!requireOwner(req, res)) return
      if (!getSubscription(req.params.wsId, req.params.id)) {
        return res.status(404).json({ error: 'Subscription not found' })
      }
      const delivery = db.prepare(
        'SELECT * FROM event_deliveries WHERE id = ? AND subscription_id = ?'
      ).get(req.params.deliveryId, req.params.id)
      if (!delivery) return res.status(404).json({ error: 'Delivery not found' })

      await attemptDelivery(delivery)
      const updated = db.prepare(
        `SELECT id, event_type, status, attempts, response_status, error,
                created_at, delivered_at, next_attempt_at
           FROM event_deliveries WHERE id = ?`
      ).get(delivery.id)
      res.json({ delivery: updated })
    } catch (err) {
      console.error(err)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
)

// POST /api/workspaces/:wsId/subscriptions/:id/test — owner-only. Queues a
// synthetic ping event and attempts it immediately, so a new endpoint can be
// verified without waiting for something real to happen.
router.post('/workspaces/:wsId/subscriptions/:id/test', auth, async (req, res) => {
  try {
    if (!requireOwner(req, res)) return
    const sub = getSubscription(req.params.wsId, req.params.id)
    if (!sub) return res.status(404).json({ error: 'Subscription not found' })

    const id = uuidv4()
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO event_deliveries
         (id, subscription_id, event_type, payload_json, status, attempts, next_attempt_at, created_at)
       VALUES (?, ?, 'ping', ?, 'pending', 0, ?, ?)`
    ).run(
      id, sub.id,
      JSON.stringify({ message: 'FlowForge test delivery', requestedBy: req.user.id }),
      now, now
    )
    const delivery = db.prepare('SELECT * FROM event_deliveries WHERE id = ?').get(id)
    await attemptDelivery(delivery)

    const settled = db.prepare(
      `SELECT id, event_type, status, attempts, response_status, error,
              created_at, delivered_at, next_attempt_at
         FROM event_deliveries WHERE id = ?`
    ).get(id)
    res.status(settled.status === 'delivered' ? 200 : 502).json({ delivery: settled })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
