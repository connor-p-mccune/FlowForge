// Cross-workflow dependency / impact analysis.
//
// Workflows reference each other three ways, all resolved within a single
// workspace (the sub-workflow runner and the error-handler settings both
// enforce that boundary):
//
//   - a **sub-workflow** node calls another workflow as a step
//     (node.data.config.workflowId)
//   - a **for-each** node fans another workflow out over a list
//     (node.data.config.workflowId)
//   - an **error-handler** designation escalates to another workflow on
//     failure (workflows.error_workflow_id)
//
// Together these form a directed graph over a workspace's workflows. This
// service answers the operational question the graph exists to answer —
// "what breaks if I change, undeploy, or delete this?" — with the two
// directions of edge (what a workflow calls, and what calls it) and a
// static cross-workflow cycle check. Sub-workflow cycles are blocked at run
// time, but a *stale* configuration can still describe one (A calls B, B
// calls A); surfacing it before the run fails is the point.

const db = require('../config/database')

// The distinct workflow ids a single workflow references, grouped by *how*.
// Returns Map(targetId -> Set(via)); self-references are dropped (a workflow
// depending on itself is a config error the linter/runtime already owns, and
// it's noise in an impact list). `via` values: 'sub-workflow', 'for-each',
// 'error-handler'.
function referencesOf(workflow) {
  const refs = new Map()
  const add = (targetId, via) => {
    if (!targetId || targetId === workflow.id) return
    if (!refs.has(targetId)) refs.set(targetId, new Set())
    refs.get(targetId).add(via)
  }

  try {
    const { nodes } = JSON.parse(workflow.graph_json)
    for (const node of nodes || []) {
      if (node.type === 'sub-workflow') add(node.data?.config?.workflowId, 'sub-workflow')
      else if (node.type === 'for-each') add(node.data?.config?.workflowId, 'for-each')
    }
  } catch {
    /* unparseable graph contributes no graph edges */
  }
  if (workflow.error_workflow_id) add(workflow.error_workflow_id, 'error-handler')

  return refs
}

// Build the workspace's reference graph once: the workflow rows, an id lookup,
// and Map(sourceId -> Map(targetId -> Set(via))) keeping only edges whose
// target still exists in the workspace (a dangling reference isn't a
// dependency — it's a lint error, reported elsewhere).
function buildWorkspaceGraph(workspaceId) {
  const workflows = db
    .prepare(
      'SELECT id, name, status, graph_json, error_workflow_id FROM workflows WHERE workspace_id = ?'
    )
    .all(workspaceId)
  const byId = new Map(workflows.map((w) => [w.id, w]))
  const edges = new Map()
  for (const wf of workflows) {
    const kept = new Map()
    for (const [targetId, via] of referencesOf(wf)) {
      if (byId.has(targetId)) kept.set(targetId, via)
    }
    edges.set(wf.id, kept)
  }
  return { byId, edges }
}

// Find one directed cycle that `start` participates in, or null. DFS from
// start's successors; the first edge that leads back to start closes a loop,
// and the accumulated path (start → … → start) is the cycle. `visited` bounds
// the search to each node once, so it terminates on any graph.
function findCycleThrough(start, edges) {
  const visited = new Set()
  function dfs(id, path) {
    for (const target of (edges.get(id) || new Map()).keys()) {
      if (target === start) return [...path, id, start]
      if (!visited.has(target)) {
        visited.add(target)
        const found = dfs(target, [...path, id])
        if (found) return found
      }
    }
    return null
  }
  return dfs(start, [])
}

// Shape one edge endpoint for the API: the referenced/referencing workflow's
// identity plus the sorted list of relationship kinds.
function present(byId, id, viaSet) {
  const wf = byId.get(id)
  return { id, name: wf.name, status: wf.status, via: [...viaSet].sort() }
}

const byName = (a, b) => a.name.localeCompare(b.name)

// The full dependency picture for one workflow: what it calls (dependsOn),
// what calls it (dependedOnBy), and one cross-workflow cycle it's part of
// (cycle: [id, …, id] or null). All within its workspace.
function computeDependencies(workflow) {
  const { byId, edges } = buildWorkspaceGraph(workflow.workspace_id)

  const dependsOn = [...(edges.get(workflow.id) || new Map())]
    .map(([id, via]) => present(byId, id, via))
    .sort(byName)

  const dependedOnBy = []
  for (const [sourceId, targets] of edges) {
    if (targets.has(workflow.id)) dependedOnBy.push(present(byId, sourceId, targets.get(workflow.id)))
  }
  dependedOnBy.sort(byName)

  const cycle = findCycleThrough(workflow.id, edges)

  return { dependsOn, dependedOnBy, cycle }
}

module.exports = { computeDependencies, referencesOf, buildWorkspaceGraph, findCycleThrough }
