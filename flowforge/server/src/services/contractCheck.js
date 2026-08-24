// The contract check against a real workspace: whose workflows does this
// change break?
//
// `contracts.js` is the analysis and takes graphs. This is the part that knows
// where the graphs live — which workflows call this one, what they reference,
// and what the workflow promised before the edit.
//
// The comparison is against the **saved** graph, not against a declared
// interface. Nobody writes down a workflow's return shape; they build a graph
// and the shape falls out of it. So the contract is whatever the deployed
// version returns today, and the question is whether the candidate still
// honours it. That makes this a check on a *diff* rather than on a document,
// which is also why the finding can name the exact reference that stops
// resolving instead of a schema mismatch nobody can locate.

const db = require('../config/database')
const { contractOf, compareContracts, breaksIn } = require('./contracts')

// A workflow's graph, or null. Shared by the caller lookup and by the type
// inference's own sub-workflow resolution, so a callee that itself calls
// another workflow is typed the same way everywhere.
function graphOf(row) {
  try {
    const parsed = JSON.parse(row.graph_json)
    return {
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      edges: Array.isArray(parsed.edges) ? parsed.edges : [],
    }
  } catch {
    return null
  }
}

function resolverFor(workspaceId) {
  const stmt = db.prepare('SELECT graph_json FROM workflows WHERE id = ? AND workspace_id = ?')
  return (id) => {
    const row = stmt.get(id, workspaceId)
    return row ? graphOf(row) : null
  }
}

// Every workflow in the workspace that calls this one, by sub-workflow or
// for-each node. The error-handler edge is deliberately not here: an error
// handler receives the *failure*, not the failed workflow's return value, so
// nothing about its shape is a promise to that caller.
function callersOf(workflowId, workspaceId) {
  const rows = db
    .prepare('SELECT id, name, status, graph_json FROM workflows WHERE workspace_id = ? AND id != ?')
    .all(workspaceId, workflowId)

  const callers = []
  for (const row of rows) {
    const graph = graphOf(row)
    if (!graph) continue
    const calls = graph.nodes.some(
      (n) =>
        (n.type === 'sub-workflow' || n.type === 'for-each') &&
        n.data?.config?.workflowId === workflowId
    )
    if (calls) callers.push({ ...row, graph })
  }
  return callers
}

// The whole report for one workflow and one candidate graph.
//
// `candidate` null means "judge what is saved", which is the CI shape: a
// pipeline asking whether the deployed version currently honours its contract
// gets `compatible` and no callers broken, because it is being compared with
// itself. The interesting call passes the graph somebody is about to save.
function analyzeContract(workflowId, candidate = null) {
  const workflow = db
    .prepare('SELECT id, name, workspace_id, graph_json FROM workflows WHERE id = ?')
    .get(workflowId)
  if (!workflow) return { available: false, reason: 'not-found' }

  const saved = graphOf(workflow)
  if (!saved) return { available: false, reason: 'unreadable', workflowId, name: workflow.name }

  const resolveWorkflow = resolverFor(workflow.workspace_id)
  const before = contractOf(saved, { resolveWorkflow })
  const after = contractOf(candidate || saved, { resolveWorkflow })
  const change = compareContracts(before, after)

  const callers = []
  for (const caller of callersOf(workflowId, workflow.workspace_id)) {
    const { affected, breaks } = breaksIn(caller.graph, workflowId, after)
    if (!affected) continue
    callers.push({
      workflowId: caller.id,
      name: caller.name,
      status: caller.status,
      breaks,
    })
  }
  callers.sort((a, b) => b.breaks.length - a.breaks.length || a.name.localeCompare(b.name))

  const broken = callers.filter((c) => c.breaks.length > 0)
  return {
    available: true,
    workflowId,
    name: workflow.name,
    before: { describe: before.describe, fields: [...before.fields.keys()].sort() },
    after: { describe: after.describe, fields: [...after.fields.keys()].sort() },
    change,
    callers,
    summary: {
      verdict: change.verdict,
      callers: callers.length,
      // The number to gate on. A contract that narrowed with nobody currently
      // relying on the part that went is a change to be aware of, not a
      // deployment to stop.
      broken: broken.length,
      references: broken.reduce((n, c) => n + c.breaks.length, 0),
    },
  }
}

module.exports = { analyzeContract, callersOf, graphOf, resolverFor }
