// The graph resolver sub-workflow type inference needs.
//
// `typeInference.js` is deliberately database-free — it takes a graph and gives
// back types — so the ability to look *up* another workflow arrives as a
// callback. This builds that callback, and the interesting part is which
// workflows it agrees to resolve.
//
// It mirrors the sub-workflow runner's own rule exactly: **same workspace, and
// deployed**. Anything else throws at run time, so typing a node from a target
// the runner would refuse would report a shape the run can never produce —
// which is worse than reporting nothing, because the checker would then flag
// correct references against it as errors. A target outside those rules resolves
// to null and the node types as `unknown`, while the linter reports the real
// problem (`missing-target` / `undeployed-target`) in its own words.

const db = require('../config/database')

// resolveWorkflow(workflowId) → { nodes, edges } | null, scoped to one
// workspace. Results are memoised per resolver, so a graph referenced from
// several nodes is read and parsed once per analysis.
function graphResolver(workspaceId) {
  if (!workspaceId) return null
  const cache = new Map()
  const select = db.prepare(
    "SELECT graph_json FROM workflows WHERE id = ? AND workspace_id = ? AND status = 'deployed'"
  )
  return (workflowId) => {
    if (cache.has(workflowId)) return cache.get(workflowId)
    let graph = null
    try {
      const row = select.get(workflowId, workspaceId)
      if (row) {
        const parsed = JSON.parse(row.graph_json || '{}')
        graph = {
          nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
          edges: Array.isArray(parsed.edges) ? parsed.edges : [],
        }
      }
    } catch {
      // An unreadable target is one the analysis has nothing to say about, not
      // a reason to fail the lint that asked.
      graph = null
    }
    cache.set(workflowId, graph)
    return graph
  }
}

// How many people could actually settle an approval gate in this workspace:
// `{ members, owners }`, counting only roles that may change state — a viewer
// sees the inbox and cannot decide it, so counting them would make a quorum
// look satisfiable when it is not.
//
// Lives here rather than in the linter for the same reason `graphResolver`
// does: the linter is a pure function of a graph plus facts, and this is one of
// the facts. Null when there is no workspace to count (an exported file linted
// on its own), which the linter reads as "don't guess".
function approverCounts(workspaceId) {
  if (!workspaceId) return null
  const rows = db
    .prepare("SELECT role, COUNT(*) AS n FROM workspace_members WHERE workspace_id = ? GROUP BY role")
    .all(workspaceId)
  let members = 0
  let owners = 0
  for (const row of rows) {
    if (row.role === 'viewer') continue
    members += row.n
    if (row.role === 'owner') owners += row.n
  }
  return { members, owners }
}

module.exports = { graphResolver, approverCounts }
