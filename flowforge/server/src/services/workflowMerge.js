// Everything a three-way merge needs from the database, so that
// `graphMerge.js` can stay a pure function over three graphs.
//
// The split matters: the merge algorithm is the part with subtle semantics and
// a large test surface, and keeping it free of `db` means those tests are three
// object literals rather than a fixture. This module supplies the two things
// the algorithm cannot know on its own — which snapshot is the common ancestor,
// and whether the result is a workflow that will actually run — and is shared
// by the session route and the public API so the two cannot diverge on either.

const db = require('../config/database')
const { mergeGraphs, describeConflict } = require('./graphMerge')
const { lintGraph } = require('./workflowLinter')
const { graphResolver } = require('./graphLookup')

function parseGraph(json) {
  try {
    const parsed = JSON.parse(json)
    return {
      nodes: Array.isArray(parsed?.nodes) ? parsed.nodes : [],
      edges: Array.isArray(parsed?.edges) ? parsed.edges : [],
    }
  } catch {
    return { nodes: [], edges: [] }
  }
}

// The common ancestor both sides are measured against.
//
// Default: the workflow's **latest version snapshot**. A snapshot is taken at
// every deploy, and a deploy is where the exported document came from, so it is
// the last point the file and the live canvas provably agreed. `baseVersion`
// (a version number or a snapshot id) overrides it for a document exported from
// an older release.
//
// No snapshots at all resolves to an empty base rather than an error, and that
// is a deliberate choice rather than a fallback: an empty base reads every node
// as *added* by whichever side has it, so a merge with no ancestry can never
// conclude that something was deleted — and deletion is the only outcome that
// loses work silently.
function resolveMergeBase(workflow, baseVersion) {
  if (baseVersion != null && baseVersion !== '') {
    const row = db.prepare(
      `SELECT * FROM workflow_versions
        WHERE workflow_id = ? AND (id = ? OR version = ?)
        ORDER BY version DESC LIMIT 1`
    ).get(workflow.id, String(baseVersion), Number(baseVersion) || -1)
    if (!row) return { error: `No version "${baseVersion}" for this workflow` }
    return {
      graph: parseGraph(row.graph_json),
      describe: { versionId: row.id, version: row.version, createdAt: row.created_at },
    }
  }

  const latest = db.prepare(
    'SELECT * FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC LIMIT 1'
  ).get(workflow.id)
  if (!latest) {
    return {
      graph: { nodes: [], edges: [] },
      describe: {
        versionId: null,
        version: null,
        note: 'no version snapshots — merged against an empty base',
      },
    }
  }
  return {
    graph: parseGraph(latest.graph_json),
    describe: { versionId: latest.id, version: latest.version, createdAt: latest.created_at },
  }
}

// Lint the *merged* graph, with the workspace's real context.
//
// Deliberately the result, not the inputs: a merge of two individually valid
// graphs can produce one that will not run — a reference to a node the other
// side deleted is the obvious case — and after applying it is the worst possible
// time to find that out.
function lintMerged(workflow, graph) {
  const names = (table) =>
    new Set(
      db.prepare(`SELECT name FROM ${table} WHERE workspace_id = ?`)
        .all(workflow.workspace_id)
        .map((r) => r.name)
    )
  const issues = lintGraph(graph, {
    secretNames: names('workspace_secrets'),
    variableNames: names('workspace_variables'),
    resolveWorkflow: graphResolver(workflow.workspace_id),
    rollbackPolicy: workflow.rollback_policy,
  })
  return {
    errors: issues.filter((i) => i.severity === 'error').length,
    warnings: issues.filter((i) => i.severity === 'warning').length,
    issues,
  }
}

// Merge a document into a workflow's live graph and describe the outcome.
// Returns `{ error }` for a caller mistake, otherwise the wire body plus the
// merged graph (null when anything conflicted, so a caller cannot apply one
// by accident).
function mergeDocument(workflow, graphData, { strategy = 'manual', baseVersion } = {}) {
  if (!graphData || !Array.isArray(graphData.nodes) || !Array.isArray(graphData.edges)) {
    return { error: 'graph_data must include nodes and edges arrays' }
  }
  if (!['manual', 'ours', 'theirs'].includes(strategy)) {
    return { error: 'strategy must be "manual", "ours", or "theirs"' }
  }

  const base = resolveMergeBase(workflow, baseVersion)
  if (base.error) return { error: base.error }

  const ours = parseGraph(workflow.graph_json)
  const theirs = { nodes: graphData.nodes, edges: graphData.edges }
  const result = mergeGraphs(base.graph, ours, theirs, { strategy })

  return {
    graph: result.graph,
    body: {
      workflowId: workflow.id,
      base: base.describe,
      clean: result.clean,
      applied: false,
      conflicts: result.conflicts.map((c) => ({ ...c, description: describeConflict(c) })),
      droppedEdges: result.droppedEdges,
      summary: result.summary,
      lint: result.graph ? lintMerged(workflow, result.graph) : null,
    },
  }
}

// Write a merged graph as the workflow's live definition.
//
// Updates the canvas, not the deployment: a merged definition becomes the live
// graph exactly as an edit would, and going live stays a deliberate deploy —
// which also means a risky merge can be rolled out behind a canary.
function applyMerge(workflow, graph) {
  db.prepare('UPDATE workflows SET graph_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(graph), new Date().toISOString(), workflow.id)
}

module.exports = { mergeDocument, applyMerge, resolveMergeBase, parseGraph }
