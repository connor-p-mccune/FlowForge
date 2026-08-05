// Audit log routes: read the trail, verify the chain, export it for an auditor.
//
// **Owner-only, all three.** The audit log records who touched credentials and
// membership, which makes it a map of the workspace's security posture — and
// "who has been granted access recently" is exactly what an attacker who
// already has a member's session would like to read. Reading it is therefore
// scoped to the same role that can change the things it records, which is the
// rule secrets and status-page tokens already follow.
//
// Non-members get 404 (a workspace's existence is never disclosed); a member
// whose role is insufficient gets 403 — they can see the workspace, the
// operation is what's refused. Same two-layer contract as workspaceRoles.js.

const express = require('express')
const db = require('../config/database')
const auth = require('../middleware/auth')
const { memberRole } = require('../services/workspaceRoles')
const { verifyChain, listAudit } = require('../services/auditLog')

const router = express.Router()

// Resolve the caller's standing in the workspace into a response, or null when
// they may proceed. Returns true when a response has already been sent.
function denyUnlessOwner(req, res, workspaceId) {
  const role = memberRole(workspaceId, req.user.id)
  if (role === null) {
    res.status(404).json({ error: 'Workspace not found' })
    return true
  }
  if (role !== 'owner') {
    res.status(403).json({ error: 'Only workspace owners can read the audit log' })
    return true
  }
  return false
}

function safeParse(json) {
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

// Shape one row for the wire. The chain fields (seq, prev_hash, hash) ride
// along deliberately: a client that wants to re-verify independently should be
// able to, and an exported page that omitted them would be unverifiable.
function present(row) {
  return {
    id: row.id,
    seq: row.seq,
    action: row.action,
    actorId: row.actor_id,
    actor: row.actor_label,
    targetType: row.target_type,
    targetId: row.target_id,
    targetName: row.target_name,
    metadata: row.metadata ? safeParse(row.metadata) : null,
    createdAt: row.created_at,
    prevHash: row.prev_hash,
    hash: row.hash,
  }
}

// GET /api/workspaces/:id/audit?limit=&before=<seq>&action=secret.*
// Newest-first page. `before` is the seq of the oldest row already held —
// keyset pagination on seq rather than a timestamp, because seq is a strict
// total order within a workspace and timestamps can tie.
router.get('/workspaces/:id/audit', auth, (req, res) => {
  try {
    if (denyUnlessOwner(req, res, req.params.id)) return
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 200))
    // Fetch one extra to know whether another page exists, without a COUNT.
    const rows = listAudit(req.params.id, {
      limit: limit + 1,
      before: req.query.before,
      action: req.query.action,
    })
    const hasMore = rows.length > limit
    res.json({ entries: rows.slice(0, limit).map(present), hasMore })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/workspaces/:id/audit/verify — recompute the whole chain and report
// the first divergence, if any. Cheap enough to run on demand (one indexed
// scan plus a SHA-256 per entry), which is why there is no cached "last
// verified" state to go stale: the answer is always computed fresh.
router.get('/workspaces/:id/audit/verify', auth, (req, res) => {
  try {
    if (denyUnlessOwner(req, res, req.params.id)) return
    const result = verifyChain(req.params.id)
    // A broken chain is a successful *verification* — the endpoint did its job
    // and found the answer — so it is a 200 with ok:false, not an error status.
    // Returning 5xx here would make a monitoring probe read tampering as an
    // outage, which is the wrong alert entirely.
    res.json({ ...result, verifiedAt: new Date().toISOString() })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// CSV escaping: quote every field and double any embedded quote. Uniform
// quoting rather than conditional, because an audit export is read by
// spreadsheets and parsers of wildly varying quality and the safest CSV is the
// most boring one.
function csvCell(value) {
  if (value === null || value === undefined) return '""'
  return `"${String(value).replace(/"/g, '""')}"`
}

const EXPORT_COLUMNS = [
  'seq', 'created_at', 'action', 'actor', 'actor_id',
  'target_type', 'target_id', 'target_name', 'metadata', 'prev_hash', 'hash',
]

// GET /api/workspaces/:id/audit/export?format=json|csv
//
// The whole trail in one response, for the compliance questionnaire that asks
// for it. Two properties matter: the export carries the **hash chain fields**,
// so a recipient can re-verify offline without trusting this server; and it
// carries the **verification verdict** computed at export time, so a
// mid-export tamper is visible in the artefact itself rather than only in a
// separate call someone might forget to make.
router.get('/workspaces/:id/audit/export', auth, (req, res) => {
  try {
    if (denyUnlessOwner(req, res, req.params.id)) return
    const rows = db
      .prepare('SELECT * FROM audit_log WHERE workspace_id = ? ORDER BY seq ASC')
      .all(req.params.id)
    const verification = verifyChain(req.params.id)
    const stamp = new Date().toISOString().slice(0, 10)

    if (req.query.format === 'csv') {
      const lines = [EXPORT_COLUMNS.join(',')]
      for (const row of rows) {
        lines.push([
          row.seq, row.created_at, row.action, row.actor_label, row.actor_id,
          row.target_type, row.target_id, row.target_name, row.metadata,
          row.prev_hash, row.hash,
        ].map(csvCell).join(','))
      }
      res.set('Content-Type', 'text/csv; charset=utf-8')
      res.set('Content-Disposition', `attachment; filename="audit-${stamp}.csv"`)
      return res.send(lines.join('\n') + '\n')
    }

    res.set('Content-Disposition', `attachment; filename="audit-${stamp}.json"`)
    res.json({
      workspaceId: req.params.id,
      exportedAt: new Date().toISOString(),
      verification,
      entries: rows.map(present),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
