// Workspace policy management.
//
// Reads and writes are **owner-only**, matching secrets, status pages, and the
// audit log — a control any member could switch off is not a control, and the
// list of things an organisation refuses to allow is itself sensitive. Every
// mutation lands in the tamper-evident audit log, including deletion, because a
// policy quietly removed the day before a bad deploy is exactly what an incident
// review needs to find.
//
// The interesting endpoint is the last one: `POST …/policies/evaluate` runs an
// unsaved rule against a real workflow's document. Authoring a policy blind and
// discovering at the next deploy that it blocks everything is the failure this
// prevents — the same argument behind the expression playground and the lint
// route accepting a live graph.

const express = require('express')
const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const auth = require('../middleware/auth')
const { recordAudit } = require('../services/auditLog')
const { memberRole } = require('../services/workspaceRoles')
const {
  buildDocument,
  evaluatePolicies,
  validateRule,
  BUILTIN_POLICIES,
  SEVERITIES,
} = require('../services/policyEngine')
const { listPolicies, contextFor, checkWorkflow } = require('../services/policyGate')

const router = express.Router()

const MAX_NAME = 120
const MAX_MESSAGE = 500

// Owner-only, with the same disclosure contract the rest of the app uses: a
// non-member gets the 404 a missing workspace would give (its existence is not
// disclosed), while a member who simply lacks the role gets a 403.
function requireOwner(req, res) {
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.wsId)
  const role = workspace ? memberRole(workspace.id, req.user.id) : null
  if (!workspace || !role) {
    res.status(404).json({ error: 'Workspace not found' })
    return null
  }
  if (role !== 'owner') {
    res.status(403).json({ error: 'Only workspace owners can manage policies' })
    return null
  }
  return workspace
}

const present = (policy) => ({
  id: policy.id,
  name: policy.name,
  description: policy.description,
  rule: policy.rule,
  message: policy.message,
  evidence: policy.evidence,
  severity: policy.severity,
  enabled: policy.enabled === 1,
  createdAt: policy.created_at,
  updatedAt: policy.updated_at,
})

// Validate the writable fields of a create/update body against the stored row
// (absent on create). Returns an error string or null.
function validateBody(body, existing) {
  const name = 'name' in body ? body.name : existing?.name
  if (typeof name !== 'string' || name.trim() === '') return 'name is required'
  if (name.length > MAX_NAME) return `name is too long (max ${MAX_NAME} characters)`

  const severity = 'severity' in body ? body.severity : existing?.severity ?? 'deny'
  if (!SEVERITIES.includes(severity)) return `severity must be one of ${SEVERITIES.join(', ')}`

  const message = 'message' in body ? body.message : existing?.message
  if (message != null && String(message).length > MAX_MESSAGE) {
    return `message is too long (max ${MAX_MESSAGE} characters)`
  }

  const rule = 'rule' in body ? body.rule : existing?.rule
  const ruleError = validateRule(rule, 'rule')
  if (ruleError) return ruleError

  // Evidence is optional; a blank one clears it.
  const evidence = 'evidence' in body ? body.evidence : existing?.evidence
  if (evidence != null && String(evidence).trim() !== '') {
    const evidenceError = validateRule(evidence, 'evidence')
    if (evidenceError) return evidenceError
  }
  return null
}

// GET /api/workspaces/:wsId/policies — the workspace's rules.
router.get('/workspaces/:wsId/policies', auth, (req, res) => {
  try {
    if (!requireOwner(req, res)) return
    res.json({ policies: listPolicies(req.params.wsId).map(present) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/policy-templates — the starter library, for one-click adds. Not
// workspace-scoped and not sensitive: it is a catalogue of suggestions.
router.get('/policy-templates', auth, (req, res) => {
  res.json({ templates: BUILTIN_POLICIES })
})

// POST /api/workspaces/:wsId/policies
router.post('/workspaces/:wsId/policies', auth, (req, res) => {
  try {
    const workspace = requireOwner(req, res)
    if (!workspace) return

    const body = req.body || {}
    const invalid = validateBody(body, null)
    if (invalid) return res.status(400).json({ error: invalid })

    const evidence =
      body.evidence != null && String(body.evidence).trim() !== '' ? String(body.evidence) : null
    const now = new Date().toISOString()
    const id = uuidv4()
    try {
      db.prepare(
        `INSERT INTO workspace_policies
           (id, workspace_id, name, description, rule, message, evidence, severity, enabled, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        workspace.id,
        String(body.name).trim(),
        body.description ? String(body.description) : null,
        String(body.rule),
        body.message ? String(body.message) : null,
        evidence,
        body.severity || 'deny',
        body.enabled === false ? 0 : 1,
        req.user.id,
        now,
        now
      )
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        return res.status(409).json({ error: 'A policy with that name already exists' })
      }
      throw err
    }

    const policy = db.prepare('SELECT * FROM workspace_policies WHERE id = ?').get(id)
    recordAudit(workspace.id, req.user.id, 'policy.created', {
      type: 'policy',
      id,
      name: policy.name,
      metadata: { severity: policy.severity, rule: policy.rule },
    })
    res.status(201).json({ policy: present(policy) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/workspaces/:wsId/policies/:id — partial update.
router.put('/workspaces/:wsId/policies/:id', auth, (req, res) => {
  try {
    const workspace = requireOwner(req, res)
    if (!workspace) return

    const existing = db.prepare(
      'SELECT * FROM workspace_policies WHERE id = ? AND workspace_id = ?'
    ).get(req.params.id, workspace.id)
    if (!existing) return res.status(404).json({ error: 'Policy not found' })

    const body = req.body || {}
    const invalid = validateBody(body, existing)
    if (invalid) return res.status(400).json({ error: invalid })

    const next = {
      name: 'name' in body ? String(body.name).trim() : existing.name,
      description: 'description' in body
        ? (body.description ? String(body.description) : null)
        : existing.description,
      rule: 'rule' in body ? String(body.rule) : existing.rule,
      message: 'message' in body ? (body.message ? String(body.message) : null) : existing.message,
      evidence: 'evidence' in body
        ? (body.evidence && String(body.evidence).trim() !== '' ? String(body.evidence) : null)
        : existing.evidence,
      severity: 'severity' in body ? body.severity : existing.severity,
      enabled: 'enabled' in body ? (body.enabled ? 1 : 0) : existing.enabled,
    }

    try {
      db.prepare(
        `UPDATE workspace_policies
            SET name = ?, description = ?, rule = ?, message = ?, evidence = ?,
                severity = ?, enabled = ?, updated_at = ?
          WHERE id = ?`
      ).run(
        next.name, next.description, next.rule, next.message, next.evidence,
        next.severity, next.enabled, new Date().toISOString(), existing.id
      )
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        return res.status(409).json({ error: 'A policy with that name already exists' })
      }
      throw err
    }

    const policy = db.prepare('SELECT * FROM workspace_policies WHERE id = ?').get(existing.id)
    // Disabling is the change worth being able to find later, so it is called
    // out in the audit metadata rather than buried in a field diff.
    recordAudit(workspace.id, req.user.id, 'policy.updated', {
      type: 'policy',
      id: policy.id,
      name: policy.name,
      metadata: {
        severity: policy.severity,
        enabled: policy.enabled === 1,
        disabled: existing.enabled === 1 && policy.enabled === 0,
        rule: policy.rule,
      },
    })
    res.json({ policy: present(policy) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/workspaces/:wsId/policies/:id
router.delete('/workspaces/:wsId/policies/:id', auth, (req, res) => {
  try {
    const workspace = requireOwner(req, res)
    if (!workspace) return
    const existing = db.prepare(
      'SELECT * FROM workspace_policies WHERE id = ? AND workspace_id = ?'
    ).get(req.params.id, workspace.id)
    if (!existing) return res.status(404).json({ error: 'Policy not found' })

    db.prepare('DELETE FROM workspace_policies WHERE id = ?').run(existing.id)
    recordAudit(workspace.id, req.user.id, 'policy.deleted', {
      type: 'policy',
      id: existing.id,
      name: existing.name,
      metadata: { severity: existing.severity, rule: existing.rule },
    })
    res.json({ deleted: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/workspaces/:wsId/policies/evaluate — dry-run.
//
// With `{ rule, evidence?, workflowId }` it evaluates an *unsaved* rule against
// that workflow's real document, so a policy can be written and checked before
// anyone's deploy depends on it. With only `workflowId` it reports how the
// workspace's stored policies judge that workflow — the "what would this block
// today?" question an owner asks before turning a rule on.
//
// `document` comes back either way, because a rule is much easier to write when
// you can see the fields it may read.
router.post('/workspaces/:wsId/policies/evaluate', auth, (req, res) => {
  try {
    const workspace = requireOwner(req, res)
    if (!workspace) return

    const { rule, evidence, workflowId } = req.body || {}
    const workflow = workflowId
      ? db.prepare('SELECT * FROM workflows WHERE id = ? AND workspace_id = ?')
          .get(workflowId, workspace.id)
      : null
    if (workflowId && !workflow) return res.status(404).json({ error: 'Workflow not found' })
    if (!workflow) return res.status(400).json({ error: 'workflowId is required' })

    const document = buildDocument(workflow, contextFor(workflow))

    if (rule !== undefined) {
      const invalid = validateRule(rule, 'rule')
      if (invalid) return res.json({ ok: false, error: invalid, document })
      if (evidence != null && String(evidence).trim() !== '') {
        const evidenceError = validateRule(evidence, 'evidence')
        if (evidenceError) return res.json({ ok: false, error: evidenceError, document })
      }
      // A single ad-hoc policy, evaluated exactly as a stored one would be.
      const [violation] = evaluatePolicies(
        [{ id: 'preview', name: 'Preview', rule, evidence, severity: 'deny', enabled: 1 }],
        document
      )
      return res.json({
        ok: true,
        holds: !violation,
        evidence: violation?.evidence ?? null,
        errored: Boolean(violation?.errored),
        document,
      })
    }

    const { violations, evaluated } = checkWorkflow(workflow)
    res.json({ ok: true, violations, evaluated, document })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
