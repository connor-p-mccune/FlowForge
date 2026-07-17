// Full-text workflow search over SQLite FTS5. The problem it solves: "which
// workflow calls the Stripe API?" is unanswerable from a name list — the
// evidence lives inside node configs. So each workflow becomes one FTS5
// document — name, description, and node_text (every node's label, type, and
// string config values, sticky-note text included) — and the palette can
// find a workflow by what's *inside* it.
//
// The index is maintained lazily at read time, not by hooking every write
// path (create, rename, graph save, import, restore, template clone… — a
// list that only grows). workflow_search_state records the updated_at each
// document was built from; a search pass re-indexes exactly the rows in the
// searched workspaces whose updated_at moved. Writes stay oblivious to the
// index, the index can never be *silently* stale (staleness is repaired by
// the very query that would observe it), and a deleted workflow needs no
// hook either — results join back to workflows, so its document just stops
// surfacing and is swept when noticed.

const db = require('../config/database')

// How much of a node config's string values one document may hold. A
// pathological workflow (a transform embedding a novel) shouldn't bloat the
// index; matches beyond this are matches nobody scrolls to anyway.
const MAX_NODE_TEXT_CHARS = 20000

// Flatten a workflow graph into the searchable node_text: per node, its
// label, type, and every string value in its config (nested included). Keys
// are skipped — searching for "url" would match every HTTP node — but note
// text rides in like any other config string.
function nodeTextOf(graphJson) {
  let nodes = []
  try {
    nodes = JSON.parse(graphJson).nodes || []
  } catch {
    return ''
  }
  const parts = []
  const walk = (value) => {
    if (typeof value === 'string') {
      if (value.trim()) parts.push(value)
    } else if (Array.isArray(value)) {
      value.forEach(walk)
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(walk)
    }
  }
  for (const node of nodes) {
    if (node?.data?.label) parts.push(String(node.data.label))
    if (node?.type) parts.push(String(node.type))
    walk(node?.data?.config)
  }
  return parts.join(' ').slice(0, MAX_NODE_TEXT_CHARS)
}

// Bring one workspace's documents up to date: (re)index every workflow whose
// updated_at differs from what its document was built from. Bounded by the
// workspace's workflow count and usually a no-op.
function reindexWorkspace(workspaceId) {
  const stale = db.prepare(
    `SELECT w.id, w.name, w.description, w.graph_json, w.updated_at
       FROM workflows w
       LEFT JOIN workflow_search_state s ON s.workflow_id = w.id
      WHERE w.workspace_id = ?
        AND (s.workflow_id IS NULL OR s.indexed_updated_at <> w.updated_at)`
  ).all(workspaceId)
  if (stale.length === 0) return 0

  const dropDoc = db.prepare('DELETE FROM workflow_fts WHERE workflow_id = ?')
  const insertDoc = db.prepare(
    'INSERT INTO workflow_fts (workflow_id, name, description, node_text) VALUES (?, ?, ?, ?)'
  )
  const upsertState = db.prepare(
    `INSERT INTO workflow_search_state (workflow_id, indexed_updated_at) VALUES (?, ?)
     ON CONFLICT(workflow_id) DO UPDATE SET indexed_updated_at = excluded.indexed_updated_at`
  )
  const reindex = db.transaction((rows) => {
    for (const row of rows) {
      dropDoc.run(row.id)
      insertDoc.run(row.id, row.name || '', row.description || '', nodeTextOf(row.graph_json))
      upsertState.run(row.id, row.updated_at)
    }
  })
  reindex(stale)
  return stale.length
}

// Turn free text into an FTS5 MATCH expression that can't be a syntax error:
// each whitespace-separated term becomes a quoted phrase token, and the last
// becomes a prefix match ("stri"* finds stripe) so search-as-you-type works.
// Returns null for a query with no usable terms.
function toMatchExpression(query) {
  const terms = String(query || '')
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '').trim())
    .filter(Boolean)
    .slice(0, 8) // more terms than this is noise, and each costs a seek
  if (terms.length === 0) return null
  return terms.map((t, i) => (i === terms.length - 1 ? `"${t}"*` : `"${t}"`)).join(' ')
}

// Search the given workspaces. Reindexes them first (lazy maintenance), then
// ranks with bm25 weighted name > description > node_text — a workflow
// *named* "stripe sync" should beat one that merely mentions stripe in a
// node. Each hit carries which field matched best and an FTS5 snippet with
// [brackets] around the matched terms, so the palette can show *why* this
// result surfaced. Orphan documents (deleted workflows) drop out via the
// join and are swept here when noticed.
function searchWorkflows(workspaceIds, query, { limit = 20 } = {}) {
  const ids = [...new Set(workspaceIds)].filter(Boolean)
  const match = toMatchExpression(query)
  if (ids.length === 0 || !match) return []

  for (const id of ids) reindexWorkspace(id)

  const bounded = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50)
  // Over-fetch before the workspace filter: hits from foreign workspaces are
  // discarded below, and orphans get swept.
  const hits = db.prepare(
    `SELECT workflow_id,
            snippet(workflow_fts, 1, '[', ']', '…', 8) AS name_snippet,
            snippet(workflow_fts, 2, '[', ']', '…', 10) AS description_snippet,
            snippet(workflow_fts, 3, '[', ']', '…', 10) AS node_snippet,
            bm25(workflow_fts, 0, 10.0, 4.0, 1.0) AS rank
       FROM workflow_fts
      WHERE workflow_fts MATCH ?
      ORDER BY rank
      LIMIT ?`
  ).all(match, bounded * 3)

  const readWorkflow = db.prepare(
    'SELECT id, name, status, workspace_id FROM workflows WHERE id = ?'
  )
  const dropOrphan = db.prepare('DELETE FROM workflow_fts WHERE workflow_id = ?')

  const results = []
  for (const hit of hits) {
    if (results.length >= bounded) break
    const workflow = readWorkflow.get(hit.workflow_id)
    if (!workflow) {
      dropOrphan.run(hit.workflow_id)
      continue
    }
    if (!ids.includes(workflow.workspace_id)) continue
    // The field whose snippet actually contains a highlighted term tells the
    // UI why this hit surfaced; name wins ties since it's always displayed.
    const matched = hit.name_snippet.includes('[')
      ? { field: 'name', snippet: hit.name_snippet }
      : hit.description_snippet.includes('[')
        ? { field: 'description', snippet: hit.description_snippet }
        : { field: 'nodes', snippet: hit.node_snippet }
    results.push({
      workflowId: workflow.id,
      name: workflow.name,
      status: workflow.status,
      workspaceId: workflow.workspace_id,
      field: matched.field,
      snippet: matched.snippet,
    })
  }
  return results
}

module.exports = { searchWorkflows, reindexWorkspace, nodeTextOf, toMatchExpression }
