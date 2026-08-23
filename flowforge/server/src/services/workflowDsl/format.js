// Rendering a workflow document as `.flow` text.
//
// The emit order is not a style choice. Nodes are sorted by id, edges by
// (source, target, handle), config keys alphabetically — **exactly the rules
// `artifactSigning.js` canonicalises with**. Two consequences follow, and they
// are the reason the format is worth having:
//
//   * Re-formatting a workflow can never break its signature, because the
//     signature is over the same normal form. A reviewer can reformat a file
//     they were sent and the verification still passes.
//   * Two people who export the same workflow get byte-identical text, whatever
//     order their canvases happened to store things in — so `git diff` shows
//     what changed and nothing else.
//
// `exportedAt` is deliberately not rendered. It is the field that makes a diff
// of an unchanged workflow non-empty, which is the one thing a review artefact
// must never do.
//
// The formatter **refuses rather than lies**. An id or a type containing
// whitespace or a colon cannot be written in this grammar, so rather than emit
// something that would not parse back, it throws. A formatter that silently
// produced un-round-trippable output would be worse than no formatter, because
// the damage would be discovered at import time in another environment.

const { DslError } = require('./parse')

const INDENT = '  '

// Ids and types appear bare in the grammar, so they cannot contain whitespace,
// a colon (which separates them), or an `@` (which starts a position).
const BARE = /^[^\s:@]+$/

function requireBare(value, what) {
  const text = String(value ?? '')
  if (!BARE.test(text)) {
    throw new DslError(
      `Cannot write ${what} "${text}" as .flow — it contains whitespace, a colon or an @`
    )
  }
  return text
}

// A JSON value, indented so a multi-line object aligns under its key rather
// than escaping back to column zero.
function renderValue(value, indent) {
  const json = JSON.stringify(value ?? null, null, 2)
  if (!json.includes('\n')) return json
  return json.split('\n').map((line, i) => (i === 0 ? line : indent + line)).join('\n')
}

const sortedKeys = (object) => Object.keys(object || {}).sort()

// Everything on a node other than `label` and `config` — a colour, a collapsed
// flag, whatever a future canvas keeps. Emitted with a `data.` prefix so a
// round trip cannot confuse it with a config key.
function extraDataKeys(node) {
  return sortedKeys(node?.data).filter((key) => key !== 'label' && key !== 'config')
}

function formatNode(node) {
  const id = requireBare(node?.id, 'node id')
  const type = requireBare(node?.type, 'node type')
  const x = Number(node?.position?.x) || 0
  const y = Number(node?.position?.y) || 0
  const lines = [`node ${id}: ${type} @ ${x},${y}`]

  // The label first: it is what a reader is looking for, and putting it under
  // three alphabetically-earlier config keys would bury it.
  if (node?.data?.label !== undefined) {
    lines.push(`${INDENT}label: ${renderValue(node.data.label, INDENT)}`)
  }
  for (const key of extraDataKeys(node)) {
    lines.push(`${INDENT}data.${requireBare(key, 'data key')}: ${renderValue(node.data[key], INDENT)}`)
  }
  for (const key of sortedKeys(node?.data?.config)) {
    lines.push(`${INDENT}${requireBare(key, 'config key')}: ${renderValue(node.data.config[key], INDENT)}`)
  }
  return lines.join('\n')
}

function formatEdge(edge) {
  const source = requireBare(edge?.source, 'edge source')
  const target = requireBare(edge?.target, 'edge target')
  const handle = edge?.sourceHandle
  if (handle == null || handle === '') return `${source} -> ${target}`
  return `${source} -${requireBare(handle, 'edge handle')}-> ${target}`
}

function formatGuarantee(guarantee) {
  const kind = requireBare(guarantee?.kind, 'guarantee kind')
  const node = requireBare(guarantee?.node, 'guarantee node')
  const other = requireBare(guarantee?.other, 'guarantee node')
  const lines = [`guarantee ${kind} ${node} ${other}`]
  if (guarantee?.note != null && guarantee.note !== '') {
    lines.push(`${INDENT}note: ${renderValue(guarantee.note, INDENT)}`)
  }
  return lines.join('\n')
}

// Accepts an export document (`{ name, description, graph_data, guarantees }`)
// or the same shape with `graph` instead — the two names the rest of the
// codebase already uses interchangeably.
function formatWorkflow(document = {}) {
  const graph = document.graph_data || document.graph || { nodes: [], edges: [] }
  const nodes = (Array.isArray(graph.nodes) ? [...graph.nodes] : []).sort((a, b) =>
    String(a?.id) < String(b?.id) ? -1 : String(a?.id) > String(b?.id) ? 1 : 0
  )
  const edges = (Array.isArray(graph.edges) ? [...graph.edges] : []).sort((a, b) => {
    const ka = `${a?.source} ${a?.target} ${a?.sourceHandle ?? ''}`
    const kb = `${b?.source} ${b?.target} ${b?.sourceHandle ?? ''}`
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
  const guarantees = (Array.isArray(document.guarantees) ? [...document.guarantees] : []).sort(
    (a, b) => {
      const ka = `${a?.kind} ${a?.node} ${a?.other}`
      const kb = `${b?.kind} ${b?.node} ${b?.other}`
      return ka < kb ? -1 : ka > kb ? 1 : 0
    }
  )

  const blocks = []
  const header = [`workflow ${JSON.stringify(document.name ?? '')}`]
  if (document.description != null && document.description !== '') {
    header.push(`${INDENT}description: ${renderValue(document.description, INDENT)}`)
  }
  blocks.push(header.join('\n'))

  for (const guarantee of guarantees) blocks.push(formatGuarantee(guarantee))
  for (const node of nodes) blocks.push(formatNode(node))
  // Connections last and together: they are the shape of the workflow, and a
  // reviewer reading a rewire wants them in one place rather than scattered
  // among the nodes they happen to leave.
  if (edges.length > 0) blocks.push(edges.map(formatEdge).join('\n'))

  return `${blocks.join('\n\n')}\n`
}

module.exports = { formatWorkflow }
