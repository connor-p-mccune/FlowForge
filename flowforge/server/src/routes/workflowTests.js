// Workflow test scenarios: CRUD for a workflow's regression tests and endpoints
// to run them. A scenario is a named trigger payload plus FXL assertions over
// the resulting run's output (see services/workflowTester.js). Managing
// scenarios is session-authenticated and workspace-scoped; running the suite is
// also exposed on the public API (routes/publicApi.js) as a CI gate.

const express = require('express')
const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const auth = require('../middleware/auth')
const { check } = require('../services/expression')
const { runScenario, runSuite } = require('../services/workflowTester')
const { analyzePaths } = require('../services/pathConstraints')
const { forbidViewer } = require('../services/workspaceRoles')

const router = express.Router()

// A workflow the requesting user may see, or null. Membership is checked through
// the workflow's workspace; a non-member gets the same null a missing id does.
function getVisibleWorkflow(workflowId, userId) {
  const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId)
  if (!workflow) return null
  const member = db.prepare(
    'SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
  ).get(workflow.workspace_id, userId)
  return member ? workflow : null
}

// Present a stored scenario row in the API's camelCase shape, parsing its JSON
// columns. A malformed column (shouldn't happen — writes validate) degrades to
// an empty default rather than throwing.
function presentScenario(row) {
  let input = {}
  let assertions = []
  try {
    input = row.trigger_data ? JSON.parse(row.trigger_data) : {}
  } catch { /* keep {} */ }
  try {
    assertions = JSON.parse(row.assertions)
  } catch { /* keep [] */ }
  return {
    id: row.id,
    workflowId: row.workflow_id,
    name: row.name,
    input,
    assertions,
    generatedFor: row.generated_for || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// Validate a create/update body → { name, triggerData, assertions } or an
// { error } string. Assertions are FXL-parse-checked here so a broken expression
// is a 400 at authoring time, not a surprise mid-run — the same static check the
// linter applies to node expressions.
function validateBody(body) {
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name) return { error: 'A scenario name is required' }
  if (name.length > 200) return { error: 'Scenario name is too long (max 200 chars)' }

  const input = body?.input
  if (input != null && (typeof input !== 'object' || Array.isArray(input))) {
    return { error: 'input must be a JSON object' }
  }

  const rawAssertions = body?.assertions
  if (!Array.isArray(rawAssertions) || rawAssertions.length === 0) {
    return { error: 'At least one assertion is required' }
  }
  if (rawAssertions.length > 50) {
    return { error: 'A scenario may have at most 50 assertions' }
  }
  const assertions = []
  for (const a of rawAssertions) {
    const expression = typeof a?.expression === 'string' ? a.expression.trim() : ''
    if (!expression) return { error: 'Every assertion needs an expression' }
    const parsed = check(expression)
    if (!parsed.ok) return { error: `Assertion "${expression}" is not valid FXL: ${parsed.error}` }
    const description = typeof a?.description === 'string' ? a.description.trim() : null
    assertions.push(description ? { expression, description } : { expression })
  }

  return {
    name,
    triggerData: input && Object.keys(input).length ? JSON.stringify(input) : null,
    assertions: JSON.stringify(assertions),
  }
}

// GET /api/workflows/:id/tests — list a workflow's scenarios.
router.get('/workflows/:id/tests', auth, (req, res) => {
  try {
    const workflow = getVisibleWorkflow(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    const rows = db.prepare(
      'SELECT * FROM workflow_tests WHERE workflow_id = ? ORDER BY created_at, rowid'
    ).all(workflow.id)
    res.json({ tests: rows.map(presentScenario) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/workflows/:id/tests — create a scenario.
router.post('/workflows/:id/tests', auth, (req, res) => {
  try {
    const workflow = getVisibleWorkflow(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return
    const parsed = validateBody(req.body)
    if (parsed.error) return res.status(400).json({ error: parsed.error })

    const id = uuidv4()
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO workflow_tests (id, workflow_id, name, trigger_data, assertions, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, workflow.id, parsed.name, parsed.triggerData, parsed.assertions, req.user.id, now, now)
    const row = db.prepare('SELECT * FROM workflow_tests WHERE id = ?').get(id)
    res.status(201).json({ test: presentScenario(row) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/workflows/:id/tests/:testId — replace a scenario's fields.
router.put('/workflows/:id/tests/:testId', auth, (req, res) => {
  try {
    const workflow = getVisibleWorkflow(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return
    const existing = db.prepare(
      'SELECT * FROM workflow_tests WHERE id = ? AND workflow_id = ?'
    ).get(req.params.testId, workflow.id)
    if (!existing) return res.status(404).json({ error: 'Scenario not found' })

    const parsed = validateBody(req.body)
    if (parsed.error) return res.status(400).json({ error: parsed.error })

    db.prepare(
      'UPDATE workflow_tests SET name = ?, trigger_data = ?, assertions = ?, updated_at = ? WHERE id = ?'
    ).run(parsed.name, parsed.triggerData, parsed.assertions, new Date().toISOString(), existing.id)
    const row = db.prepare('SELECT * FROM workflow_tests WHERE id = ?').get(existing.id)
    res.json({ test: presentScenario(row) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/workflows/:id/tests/:testId — remove a scenario.
router.delete('/workflows/:id/tests/:testId', auth, (req, res) => {
  try {
    const workflow = getVisibleWorkflow(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return
    const result = db.prepare(
      'DELETE FROM workflow_tests WHERE id = ? AND workflow_id = ?'
    ).run(req.params.testId, workflow.id)
    if (result.changes === 0) return res.status(404).json({ error: 'Scenario not found' })
    res.status(204).end()
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/workflows/:id/tests/:testId/run — run one scenario.
router.post('/workflows/:id/tests/:testId/run', auth, async (req, res) => {
  try {
    const workflow = getVisibleWorkflow(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return
    const scenario = db.prepare(
      'SELECT * FROM workflow_tests WHERE id = ? AND workflow_id = ?'
    ).get(req.params.testId, workflow.id)
    if (!scenario) return res.status(404).json({ error: 'Scenario not found' })

    const result = await runScenario(workflow, { ...scenario, triggered_by: req.user.id })
    res.json({ result })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/workflows/:id/tests/generate — write a scenario for every branch a
// trigger payload can drive (services/pathConstraints.js).
//
// The premise is that nobody writes the boring tests. A workflow's branches are
// enumerable and the payload that takes each one is computable, so leaving that
// to a person means the suite covers whatever somebody thought of on the day —
// which is never the case that breaks.
//
// Three decisions keep the button safe to press:
//
//   * **It is idempotent.** A generated scenario records the branch it covers
//     (`generated_for`), so a second run updates the payload and assertion
//     rather than doubling the suite. Regeneration after a graph edit is
//     therefore the normal way to use it, not a cleanup job.
//   * **It never touches a hand-written scenario**, which has no
//     `generated_for` at all. A person's test is theirs.
//   * **It reports what it could not cover, and why** — an approval's rejected
//     side, a branch that depends on an API response — instead of quietly
//     producing a suite with holes in it. That list is the honest part: the
//     coverage number means nothing without it.
router.post('/workflows/:id/tests/generate', auth, (req, res) => {
  try {
    const workflow = getVisibleWorkflow(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return

    // Same body contract as lint/types/paths: the canvas asks about the graph
    // on screen, so a branch added a minute ago is covered without a save.
    let graph
    if (req.body && Array.isArray(req.body.nodes) && Array.isArray(req.body.edges)) {
      graph = { nodes: req.body.nodes, edges: req.body.edges }
    } else {
      try {
        const parsed = JSON.parse(workflow.graph_json)
        graph = { nodes: parsed.nodes || [], edges: parsed.edges || [] }
      } catch {
        graph = { nodes: [], edges: [] }
      }
    }

    const report = analyzePaths(graph)
    if (!report.analysed) {
      return res.status(400).json({
        error:
          report.reason === 'cycle'
            ? 'The graph contains a cycle, so no execution exists to generate tests from'
            : 'The graph has no nodes to generate tests from',
      })
    }

    const existing = db.prepare(
      'SELECT * FROM workflow_tests WHERE workflow_id = ? AND generated_for IS NOT NULL'
    ).all(workflow.id)
    const byBranch = new Map(existing.map((row) => [row.generated_for, row]))

    const insert = db.prepare(
      `INSERT INTO workflow_tests
         (id, workflow_id, name, trigger_data, assertions, generated_for, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const update = db.prepare(
      `UPDATE workflow_tests
          SET name = ?, trigger_data = ?, assertions = ?, updated_at = ?
        WHERE id = ?`
    )

    const now = new Date().toISOString()
    const created = []
    const updated = []
    const write = db.transaction(() => {
      for (const scenario of report.scenarios) {
        const branch = `${scenario.covers.nodeId}:${scenario.covers.outcome}`
        const triggerData = Object.keys(scenario.triggerData).length
          ? JSON.stringify(scenario.triggerData)
          : null
        const assertions = JSON.stringify(scenario.assertions)
        const row = byBranch.get(branch)
        if (row) {
          update.run(scenario.name, triggerData, assertions, now, row.id)
          updated.push(row.id)
        } else {
          const id = uuidv4()
          insert.run(id, workflow.id, scenario.name, triggerData, assertions, branch, req.user.id, now, now)
          created.push(id)
        }
      }
    })
    write()

    const rows = db.prepare(
      'SELECT * FROM workflow_tests WHERE workflow_id = ? ORDER BY created_at, rowid'
    ).all(workflow.id)

    res.json({
      created: created.length,
      updated: updated.length,
      // The branches a payload cannot drive, each with the reason. A caller
      // that only reads `created` is looking at half the answer.
      uncovered: report.branches
        .filter((b) => b.wired > 0 && !b.generatable)
        .map((b) => ({
          nodeId: b.nodeId,
          label: b.label,
          outcome: b.outcome,
          status: b.status,
          reason: b.blockers[0] || 'no input reaches this branch',
        })),
      coverage: report.coverage,
      tests: rows.map(presentScenario),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/workflows/:id/tests/run — run the whole suite.
router.post('/workflows/:id/tests/run', auth, async (req, res) => {
  try {
    const workflow = getVisibleWorkflow(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return
    const summary = await runSuite(workflow, { triggeredBy: req.user.id })
    res.json(summary)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
module.exports.getVisibleWorkflow = getVisibleWorkflow
