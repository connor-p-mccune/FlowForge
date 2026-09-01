// Where `reach.js` gets the graphs it walks.
//
// Kept out of the analysis so that stays pure — a graph in, a report out — and
// kept out of both routes so there is one place that decides what "a workflow
// this call can reach" means.
//
// It means: in the same workspace. That is not a policy choice made here, it is
// the boundary the sub-workflow runner already enforces, so a call across
// workspaces is not a call this should follow because it is not a call the
// engine would make.

const db = require('../config/database')

function subWorkflowGraphs(workspaceId) {
  const stmt = db.prepare(
    'SELECT id, name, graph_json FROM workflows WHERE id = ? AND workspace_id = ?'
  )
  return (id) => {
    const row = stmt.get(id, workspaceId)
    if (!row) return null
    try {
      const parsed = JSON.parse(row.graph_json)
      return {
        id: row.id,
        name: row.name,
        graph: {
          nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
          edges: Array.isArray(parsed.edges) ? parsed.edges : [],
        },
      }
    } catch {
      // An unreadable graph is indistinguishable from a missing one as far as
      // the walk is concerned: either way the call cannot be expanded, and the
      // report keeps the unexpanded effect and says why.
      return null
    }
  }
}

module.exports = { subWorkflowGraphs }
