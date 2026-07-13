// Schedule preview: given a workflow's schedule trigger (or an arbitrary cron
// expression), report the next several times it will fire. The scheduler uses
// node-cron to *run* schedules; this route uses services/cronExpression.js to
// tell a user *when* — so the canvas can show "next runs: Mon 09:00, Tue 09:00…"
// under a schedule node, and a CLI/dashboard can preview a workflow's cadence.
//
// Read-only and side-effect-free: it computes fire times, it never enqueues a
// run. Times are UTC ISO-8601, matching the cron engine's contract.

const express = require('express')
const db = require('../config/database')
const auth = require('../middleware/auth')
const { nextRuns, isValid } = require('../services/cronExpression')

const router = express.Router()

// Default and maximum number of upcoming fire times a preview returns. Small on
// purpose — a preview is a glance at the cadence, not a full calendar.
const DEFAULT_COUNT = 5
const MAX_COUNT = 25

function parseCount(value) {
  const n = parseInt(value, 10)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_COUNT
  return Math.min(n, MAX_COUNT)
}

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

// The cron expression from a workflow's first schedule trigger, or null when the
// workflow has no schedule trigger (a manual/webhook-only workflow).
function scheduleExpressionOf(workflow) {
  let graph
  try {
    graph = JSON.parse(workflow.graph_json)
  } catch {
    return null
  }
  const node = (graph.nodes || []).find((n) => n.type === 'trigger-schedule')
  const cron = node?.data?.config?.cron
  return typeof cron === 'string' && cron.trim() !== '' ? cron.trim() : null
}

// Build the preview payload for one expression, or an { error } shape the caller
// turns into a 400. Kept separate so both endpoints share the exact wording.
function previewFor(expression, count) {
  if (!isValid(expression)) {
    return { error: `"${expression}" is not a valid cron expression` }
  }
  const runs = nextRuns(expression, count).map((d) => d.toISOString())
  return {
    cron: expression,
    // A schedule that parses but never fires (an impossible calendar date, e.g.
    // Feb 30) yields no runs — surfaced honestly rather than as an error.
    reachable: runs.length > 0,
    nextRuns: runs,
  }
}

// POST /api/schedule/preview { cron, count? } — preview an arbitrary expression.
// This is what the schedule node's config panel calls as the user types, so a
// cadence is visible before the workflow is ever deployed. Auth'd (it's an
// authoring aid) but touches no workflow, so any logged-in user may call it.
router.post('/schedule/preview', auth, (req, res) => {
  try {
    const expression = typeof req.body?.cron === 'string' ? req.body.cron.trim() : ''
    if (!expression) return res.status(400).json({ error: 'A cron expression is required' })
    const result = previewFor(expression, parseCount(req.body?.count))
    if (result.error) return res.status(400).json({ error: result.error })
    res.json(result)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/workflows/:id/schedule?count=N — the upcoming fire times of a
// workflow's own schedule trigger. 200 with scheduled:false when the workflow
// has no schedule trigger, so the caller can distinguish "not scheduled" from a
// missing/forbidden workflow (both 404).
router.get('/workflows/:id/schedule', auth, (req, res) => {
  try {
    const workflow = getVisibleWorkflow(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })

    const expression = scheduleExpressionOf(workflow)
    if (!expression) {
      return res.json({ workflowId: workflow.id, scheduled: false, nextRuns: [] })
    }
    const result = previewFor(expression, parseCount(req.query.count))
    // A deployed schedule fires; an undeployed one is previewed but inactive, so
    // the client can label it "will run when deployed".
    res.json({
      workflowId: workflow.id,
      scheduled: true,
      active: workflow.status === 'deployed',
      ...result,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
// Shared with the public API so /api/v1 can expose the same schedule preview.
module.exports.scheduleExpressionOf = scheduleExpressionOf
module.exports.previewFor = previewFor
module.exports.parseCount = parseCount
