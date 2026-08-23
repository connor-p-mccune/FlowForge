// A text format for a workflow, and the parser for it.
//
// The GitOps loop is `export → git → review → CI → import`. Drift detection
// tells you git and production diverged, the three-way merge reconciles them,
// and an Ed25519 signature proves the graph that arrived is the graph that was
// approved. Every one of those is built around a document a human is supposed
// to **review** — and that document is a JSON blob.
//
// Which means: renaming one node is a diff nobody reads. The connections are a
// flat array of `{id, source, target, sourceHandle}` objects at the bottom of
// the file, hundreds of lines from the nodes they connect, so rewiring a branch
// is four changed lines in a place that gives no clue what they mean. Adding a
// node reindents nothing and reorders everything, because the array order is
// whatever the canvas happened to produce. And every export carries a fresh
// `exportedAt`, so **`git diff` on an unchanged workflow is never empty** — the
// one thing a review artefact must never do.
//
// So: a line-oriented text format, `.flow`.
//
//     workflow "Order pipeline"
//       description: "Handles incoming orders"
//
//     guarantee requires charge approve
//       note: "PCI review, 2026-01"
//
//     node approve: approval @ 240,160
//       label: "Approve refund"
//       quorum: 2
//
//     node charge: action-http @ 480,160
//       label: "Charge card"
//       url: "https://api.acme.com/v1/charges/{{hook.orderId}}"
//       headers: {"Content-Type": "application/json"}
//
//     approve -true-> charge
//
// Three decisions, and each is the reason a format like this usually fails.
//
// **It is line-oriented because diffs are.** Unlike FXL next door — a real
// lexer feeding a Pratt parser over a token stream — this is parsed a line at a
// time. That is not a shortcut; it is the requirement. A format whose grammar
// spans lines produces diffs whose hunks span lines, and the entire point of
// the exercise is that changing one thing changes one line.
//
// **Values are JSON.** No bare strings, no custom escaping. A workflow's config
// contains `{{templates}}`, quotes, newlines, JSON Schemas and regexes;
// inventing a second escaping scheme for those is exactly how a format starts
// losing data, and it always loses it on the day somebody pastes something
// unusual. `"POST"` rather than `POST` is a small ugliness that buys total
// fidelity.
//
// **The emit order is the signature's canonical order.** `format.js` sorts
// nodes by id, edges by (source, target, handle), and config keys
// alphabetically — the same rules `artifactSigning.js` canonicalises with. So
// re-formatting a file can never break its signature, and two people who
// exported the same workflow get byte-identical text.
//
// The parser is deliberately **syntactic only**. An edge naming a node that
// does not exist parses fine and is reported by the linter, which already says
// so with the node named — a text format that grew its own second opinion about
// what a valid graph is would be a second thing to keep in agreement with the
// engine.

class DslError extends Error {
  constructor(message, { line, column = 1, source } = {}) {
    super(message)
    this.name = 'DslError'
    this.line = line
    this.column = column
    // The offending line with a caret under the column, so a CI log shows the
    // mistake rather than describing it.
    this.frame = source == null ? null : `${source}\n${' '.repeat(Math.max(0, column - 1))}^`
  }
}

const GUARANTEE_KINDS = ['requires', 'ensures', 'exclusive']

// `a -> b` and `a -true-> b`. The handle excludes `>` and whitespace, so the
// plain arrow can never be read as an empty handle.
const EDGE = /^(?<from>\S+)\s+-(?:(?<handle>[^\s>]+)-)?>\s+(?<to>\S+)\s*$/

// A JSON value may span lines when it opens a brace or a bracket. Scan for the
// balance point, honouring strings and escapes — counting braces without them
// would end a value early on `{"pattern": "}"}`, which is a real config.
function jsonEnds(text) {
  let depth = 0
  let inString = false
  let escaped = false
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') depth--
  }
  return !inString && depth <= 0
}

// Everything after the first colon on a property line, gathering continuation
// lines for a multi-line JSON value. Returns { value, nextIndex }.
function readValue(lines, index, rawValue, colonColumn) {
  let text = rawValue
  let cursor = index
  const opensBlock = /^[[{]/.test(text.trim())
  if (opensBlock) {
    while (!jsonEnds(text) && cursor + 1 < lines.length) {
      cursor += 1
      text += `\n${lines[cursor]}`
    }
  }
  try {
    return { value: JSON.parse(text.trim()), nextIndex: cursor }
  } catch {
    throw new DslError(
      `Value must be JSON — strings need quotes ("POST", not POST)`,
      { line: index + 1, column: colonColumn + 2, source: lines[index] }
    )
  }
}

// Split `key: value` at the first colon. Returns null when the line has none.
function splitProperty(line) {
  const colon = line.indexOf(':')
  if (colon === -1) return null
  return { key: line.slice(0, colon).trim(), rest: line.slice(colon + 1), colon }
}

function parseWorkflow(text) {
  if (typeof text !== 'string') throw new DslError('Expected a string of .flow source', { line: 1 })
  const lines = text.split(/\r?\n/)

  const document = { name: null, description: null, guarantees: [], graph_data: { nodes: [], edges: [] } }
  const byId = new Map()
  let block = null // { kind: 'workflow' | 'guarantee' | 'node', target }

  const fail = (message, index, column = 1) =>
    new DslError(message, { line: index + 1, column, source: lines[index] })

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.replace(/\s+$/, '')
    if (line.trim() === '' || line.trim().startsWith('#')) continue

    const indented = /^\s/.test(line)

    // ---- a property of the block above -------------------------------------
    if (indented) {
      if (!block) throw fail('Indented property with nothing above it to belong to', i)
      const split = splitProperty(line)
      if (!split) throw fail('A property must be `key: <json value>`', i)
      if (!split.key) throw fail('A property needs a name before the colon', i)
      const { value, nextIndex } = readValue(lines, i, split.rest, split.colon)
      i = nextIndex
      applyProperty(block, split.key, value, () => fail(`Unknown property "${split.key}"`, i))
      continue
    }

    block = null

    // ---- workflow -----------------------------------------------------------
    if (line.startsWith('workflow ')) {
      if (document.name !== null) throw fail('A file declares one workflow', i)
      let name
      try {
        name = JSON.parse(line.slice('workflow '.length).trim())
      } catch {
        throw fail('The workflow name must be a quoted string', i, 10)
      }
      if (typeof name !== 'string') throw fail('The workflow name must be a quoted string', i, 10)
      document.name = name
      block = { kind: 'workflow', target: document }
      continue
    }

    // ---- guarantee ----------------------------------------------------------
    if (line.startsWith('guarantee ')) {
      const parts = line.slice('guarantee '.length).trim().split(/\s+/)
      if (parts.length !== 3) {
        throw fail('A guarantee is `guarantee <kind> <node> <other>`', i)
      }
      const [kind, node, other] = parts
      if (!GUARANTEE_KINDS.includes(kind)) {
        throw fail(`Unknown guarantee kind "${kind}" — expected ${GUARANTEE_KINDS.join(', ')}`, i, 11)
      }
      const guarantee = { kind, node, other }
      document.guarantees.push(guarantee)
      block = { kind: 'guarantee', target: guarantee }
      continue
    }

    // ---- node ---------------------------------------------------------------
    if (line.startsWith('node ')) {
      const body = line.slice('node '.length)
      const colon = body.indexOf(':')
      if (colon === -1) throw fail('A node is `node <id>: <type>`', i)
      const id = body.slice(0, colon).trim()
      if (!id) throw fail('A node needs an id', i, 6)
      if (byId.has(id)) throw fail(`Duplicate node id "${id}"`, i, 6)

      let typePart = body.slice(colon + 1).trim()
      let position = { x: 0, y: 0 }
      const at = typePart.indexOf('@')
      if (at !== -1) {
        const coords = typePart.slice(at + 1).trim()
        const match = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(coords)
        if (!match) throw fail('A position is `@ x,y`', i, line.indexOf('@') + 1)
        position = { x: Number(match[1]), y: Number(match[2]) }
        typePart = typePart.slice(0, at).trim()
      }
      if (!typePart) throw fail('A node needs a type after the colon', i, colon + 7)

      const node = { id, type: typePart, position, data: { label: id, config: {} } }
      byId.set(id, node)
      document.graph_data.nodes.push(node)
      block = { kind: 'node', target: node }
      continue
    }

    // ---- edge ---------------------------------------------------------------
    const edge = EDGE.exec(line.trim())
    if (edge) {
      const { from, to, handle } = edge.groups
      document.graph_data.edges.push({
        id: handle ? `${from}-${to}-${handle}` : `${from}-${to}`,
        source: from,
        target: to,
        sourceHandle: handle ?? null,
      })
      continue
    }

    throw fail('Expected `workflow`, `guarantee`, `node`, a connection (`a -> b`), or a comment', i)
  }

  return document
}

// Where a property lands, which is the one piece of structure the format sugars.
//
//   label:      → data.label, because every node has one and `data.label` on
//                 every block would be noise
//   data.<k>:   → data[k], the escape hatch for anything else the canvas keeps
//   everything else → data.config[k], because that is what a node's properties
//                 overwhelmingly are
//
// The sugar is one-way-safe: `format.js` emits `data.` only for keys that need
// it, so a round trip cannot turn a config key into a data key or the reverse.
function applyProperty(block, key, value, unknown) {
  if (block.kind === 'workflow') {
    if (key !== 'description') throw unknown()
    block.target.description = value
    return
  }
  if (block.kind === 'guarantee') {
    if (key !== 'note') throw unknown()
    block.target.note = value
    return
  }
  if (key === 'label') {
    block.target.data.label = value
    return
  }
  if (key.startsWith('data.')) {
    block.target.data[key.slice('data.'.length)] = value
    return
  }
  block.target.data.config[key] = value
}

module.exports = { parseWorkflow, DslError, GUARANTEE_KINDS }
