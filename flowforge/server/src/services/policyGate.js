// The admission gate for workspace policies: everything that needs a database.
//
// `policyEngine.js` is deliberately pure — it takes a workflow row and a
// context object and returns violations — so it can be reasoned about and
// tested without one. This is the thin layer that reads the rest: the
// workspace's policies, its webhooks, its test scenarios, its budget.
//
// Called from three places, and the *set* is the design:
//
//   * **Deploy** is the enforcement point. A `deny` violation refuses the
//     deploy, because deploy is the moment a workflow becomes something the
//     organisation runs.
//   * **Import** is the same moment arriving through a different door — a
//     definition promoted from another environment gets the same check.
//   * **Lint** is where an author *sees* it, while editing, so the deploy
//     button is never the first news of a policy problem.
//
// Runs are deliberately not gated. A policy governs what may be *published*,
// and blocking an already-deployed workflow's runs would turn a governance edit
// into an outage — the pause switch and the budget exist for stopping traffic.

const db = require('../config/database')
const { buildDocument, evaluatePolicies, isBlocking } = require('./policyEngine')

// A workspace's policies, newest rules last so the order a reader sees is the
// order they were written in.
function listPolicies(workspaceId) {
  return db.prepare(
    'SELECT * FROM workspace_policies WHERE workspace_id = ? ORDER BY created_at, rowid'
  ).all(workspaceId)
}

function enabledPolicies(workspaceId) {
  return db.prepare(
    'SELECT * FROM workspace_policies WHERE workspace_id = ? AND enabled = 1 ORDER BY created_at, rowid'
  ).all(workspaceId)
}

// Everything the document needs that doesn't live on the workflow row.
function contextFor(workflow) {
  return {
    webhooks: db.prepare(
      'SELECT signing_secret, filter_expression FROM webhooks WHERE workflow_id = ?'
    ).all(workflow.id),
    testCount: db.prepare(
      'SELECT COUNT(*) AS n FROM workflow_tests WHERE workflow_id = ?'
    ).get(workflow.id).n,
    workspace: db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workflow.workspace_id) || {},
    secretNames: db.prepare('SELECT name FROM workspace_secrets WHERE workspace_id = ?')
      .all(workflow.workspace_id)
      .map((r) => r.name),
    variableNames: db.prepare('SELECT name FROM workspace_variables WHERE workspace_id = ?')
      .all(workflow.workspace_id)
      .map((r) => r.name),
  }
}

// Evaluate a workflow against its workspace's enabled policies.
//
//   graphJson  analyse this graph instead of the stored one — what the lint
//              route passes so the canvas is judged as it is on screen.
//
// Returns { violations, blocked, evaluated }. `evaluated` is the policy count,
// so a caller can distinguish "nothing to check" from "everything passed"
// without a second query.
function checkWorkflow(workflow, { graphJson } = {}) {
  const policies = enabledPolicies(workflow.workspace_id)
  if (policies.length === 0) return { violations: [], blocked: false, evaluated: 0 }
  const subject = graphJson === undefined ? workflow : { ...workflow, graph_json: graphJson }
  const document = buildDocument(subject, contextFor(workflow))
  const violations = evaluatePolicies(policies, document)
  return { violations, blocked: isBlocking(violations), evaluated: policies.length }
}

// The policy document a workspace's rules would see for this workflow —
// exposed so the authoring UI can show what a rule can actually read, and so
// `POST …/policies/evaluate` can dry-run a rule before it is stored.
function documentFor(workflow, { graphJson } = {}) {
  const subject = graphJson === undefined ? workflow : { ...workflow, graph_json: graphJson }
  return buildDocument(subject, contextFor(workflow))
}

// Policy violations rendered as linter issues, so they arrive in the canvas's
// Issues panel through the surface authors already read. A `deny` is an error
// (the deploy will be refused, which is exactly the linter's "this will not
// work" contract); a `warn` is a warning. There is no nodeId — a policy governs
// the workflow, not a node — and the evidence rides in the message, because
// "blocked: evil.example.com" is what makes the finding actionable.
function policyIssues(workflow, { graphJson } = {}) {
  const { violations } = checkWorkflow(workflow, { graphJson })
  return violations.map((v) => ({
    severity: v.severity === 'warn' ? 'warning' : 'error',
    code: 'policy-violation',
    message: `${v.name}: ${v.message}${formatEvidence(v.evidence)}`,
    nodeId: null,
  }))
}

function formatEvidence(evidence) {
  if (evidence == null) return ''
  const text = Array.isArray(evidence)
    ? evidence.slice(0, 5).map(String).join(', ') + (evidence.length > 5 ? ', …' : '')
    : typeof evidence === 'object'
      ? JSON.stringify(evidence)
      : String(evidence)
  return text === '' ? '' : ` (${text})`
}

module.exports = {
  listPolicies,
  enabledPolicies,
  contextFor,
  checkWorkflow,
  documentFor,
  policyIssues,
}
