// The convergence engine behind real-time collaboration.
//
// Collaboration used to be last-write-wins on a wall clock: each client stamped
// `Date.now()` on every change and dropped anything older than its own last
// edit. That converges when it converges, and the three ways it doesn't are all
// ordinary:
//
//   * **Clocks.** Two browsers disagree by seconds. Whose laptop is fast is not
//     a defensible tiebreak for whose edit survives.
//   * **Granularity.** The comparison was per *element*, so one person changing
//     an HTTP node's URL while another changed its retry count meant one of them
//     silently lost everything they typed — the exact case
//     [MERGE.md](../../docs/MERGE.md) argues is the common one and merges
//     cleanly per field.
//   * **Repair.** A dropped connection produced permanent divergence. Rejoining
//     resubscribed to *new* changes and never reconciled the ones missed, so two
//     canvases stayed different until somebody reloaded.
//
// This module replaces the tiebreak and the granularity; collabSession.js adds
// the repair.
//
// ## The data type
//
// A graph is modelled as two maps of elements, each element being:
//
//   * an **existence register** — an LWW register over `present | absent`, and
//   * a **field map** — an LWW register per field (`position`, `data.label`,
//     `config.url`, …).
//
// Every register is ordered by `(lamport, site)`: a Lamport clock, so causality
// rather than wall time decides, with the site id breaking the ties Lamport
// clocks leave — together a *total* order over concurrent writes, which is what
// makes the merge deterministic rather than merely usually-right.
//
// Two properties follow, and they are the whole point:
//
//   **Commutative.** `max` over a total order does not care what order it sees
//   its arguments in, so applying the same set of operations in any permutation
//   yields the same document. No causal delivery, no buffering, no vector
//   clocks: an operation that arrives before the one it logically follows still
//   lands correctly, because it loses or wins on its timestamp either way.
//
//   **Idempotent.** Re-applying an operation changes nothing — a strict `>`
//   comparison, never `>=` — so an at-least-once transport needs no dedupe.
//
// ## What this is, precisely
//
// An **LWW-Element-Set** over existence plus an **LWW-Map** over fields. It is
// deliberately *not* an OR-Set, and the difference is visible to users: a
// concurrent edit does not resurrect a node somebody deleted. That is a choice,
// not an oversight. On a canvas, a node reappearing with half its config merged
// from an edit made against the version that was deleted is worse than a lost
// edit — and undo exists, while "why is this node back" does not have an
// answer anybody can act on.

// Lamport timestamps are compared as a pair. The site id is the tiebreak, so
// two genuinely concurrent writes still have exactly one winner and every
// replica picks the same one.
function newer(a, b) {
  if (!b) return true
  if (a.l !== b.l) return a.l > b.l
  return a.s > b.s
}

function createDoc() {
  return { nodes: new Map(), edges: new Map(), lamport: 0 }
}

function record() {
  return { exists: null, fields: new Map() }
}

// Keys that are not data. A field register is written back onto a plain object
// by `nodeFromRecord`, so a path ending in one of these would reach the
// prototype rather than a property — which is a graph edit turning into
// prototype pollution. Refused when an operation is validated *and* skipped
// when a record is materialised, because the two have different provenance: a
// document seeded from a persisted graph never passed through the validator.
const UNSAFE_KEY = new Set(['__proto__', 'constructor', 'prototype'])

// Flatten a React Flow node into the field paths the registers are keyed on.
// `config.*` is expanded one level so two people editing different config
// fields of the same node both keep their edit — the granularity the old
// per-element comparison could not express.
function nodeFields(node) {
  const fields = {}
  if (node.type !== undefined) fields.type = node.type
  if (node.position !== undefined) fields.position = node.position
  for (const [key, value] of Object.entries(node.data || {})) {
    if (UNSAFE_KEY.has(key)) continue
    if (key === 'config') {
      for (const [ck, cv] of Object.entries(value || {})) {
        if (!UNSAFE_KEY.has(ck)) fields[`config.${ck}`] = cv
      }
    } else {
      fields[`data.${key}`] = value
    }
  }
  return fields
}

// Rebuild a node from its field registers. Absent fields simply do not appear,
// which is what makes a partial update (one config key) a legal operation
// rather than a destructive one.
function nodeFromRecord(id, rec) {
  const node = { id, position: { x: 0, y: 0 }, data: {} }
  let config = null
  for (const [path, reg] of rec.fields) {
    if (path === 'type') node.type = reg.value
    else if (path === 'position') node.position = reg.value
    else if (path.startsWith('config.')) {
      const key = path.slice(7)
      config = config || {}
      if (!UNSAFE_KEY.has(key)) config[key] = reg.value
    } else if (path.startsWith('data.')) {
      const key = path.slice(5)
      if (!UNSAFE_KEY.has(key)) node.data[key] = reg.value
    }
  }
  if (config) node.data.config = config
  return node
}

// An element is present when its existence register says so. A record that only
// ever received field writes — a `set` that overtook the `add` it belongs to —
// has no existence register yet and is correctly absent until one arrives.
const present = (rec) => Boolean(rec?.exists?.value)

// Apply one operation. Returns what changed, so the caller can broadcast the
// resulting element rather than the operation: every replica then converges on
// a value the merge produced instead of re-deriving it, and a client whose own
// operation *lost* learns the winning value in the same message shape.
//
//   { t: 'node.add',    id, l, s, node }        existence := present, all fields
//   { t: 'node.remove', id, l, s }              existence := absent
//   { t: 'node.set',    id, l, s, path, value } one field
//   { t: 'edge.add',    id, l, s, edge }
//   { t: 'edge.remove', id, l, s }
function applyOp(doc, op) {
  if (!op || typeof op !== 'object') return { changed: false }
  const { t, id, l, s } = op
  if (typeof id !== 'string' || !id || !Number.isFinite(l) || typeof s !== 'string') {
    return { changed: false }
  }
  // The receive half of the Lamport rule. Keeping the document's clock ahead of
  // everything it has seen is what lets the server hand a rejoining client a
  // timestamp its next edit can beat.
  if (l > doc.lamport) doc.lamport = l

  const kind = t.startsWith('node.') ? 'node' : 'edge'
  const map = kind === 'node' ? doc.nodes : doc.edges
  let rec = map.get(id)
  if (!rec) {
    rec = record()
    map.set(id, rec)
  }

  const stamp = { l, s }
  let changed = false

  const setField = (path, value) => {
    const current = rec.fields.get(path)
    if (!newer(stamp, current)) return
    rec.fields.set(path, { value, l, s })
    changed = true
  }

  if (t === 'node.add' || t === 'edge.add') {
    if (newer(stamp, rec.exists)) {
      // A re-add after a delete is legitimate (undo does exactly this), so
      // existence is a register rather than a one-way tombstone.
      rec.exists = { value: true, l, s }
      changed = true
    }
    const fields = kind === 'node' ? nodeFields(op.node || {}) : { edge: op.edge || {} }
    for (const [path, value] of Object.entries(fields)) setField(path, value)
  } else if (t === 'node.remove' || t === 'edge.remove') {
    if (newer(stamp, rec.exists)) {
      rec.exists = { value: false, l, s }
      changed = true
    }
  } else if (t === 'node.set') {
    setField(String(op.path), op.value)
  } else if (t === 'edge.set') {
    setField('edge', op.value)
  } else {
    return { changed: false }
  }

  return { changed, kind, id, element: present(rec) ? materializeOne(kind, id, rec) : null }
}

function materializeOne(kind, id, rec) {
  return kind === 'node' ? nodeFromRecord(id, rec) : { ...(rec.fields.get('edge')?.value || {}), id }
}

// The document as a React Flow graph.
//
// **Sorted by id**, and that is load-bearing rather than tidiness. Map iteration
// follows insertion order, which follows the order operations *arrived* — so
// two replicas holding provably identical documents would serialise them into
// different arrays. The set would converge and the artefact would not, which
// matters because this output is what gets persisted to `graph_json` and then
// compared by drift detection and the three-way merge. Sorting makes the stored
// graph a pure function of the operation set, so "the file differs" can only
// ever mean the graphs differ.
//
// Edges whose endpoints are absent are dropped rather than stored dangling: an
// edge outlives the node it connects only in the window between two operations,
// and persisting the dangling form would hand the linter a finding about a
// state no user is in.
function materialize(doc) {
  const nodes = []
  for (const [id, rec] of doc.nodes) {
    if (present(rec)) nodes.push(nodeFromRecord(id, rec))
  }
  nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const live = new Set(nodes.map((n) => n.id))
  const edges = []
  for (const [id, rec] of doc.edges) {
    if (!present(rec)) continue
    const edge = { ...(rec.fields.get('edge')?.value || {}), id }
    if (live.has(edge.source) && live.has(edge.target)) edges.push(edge)
  }
  edges.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { nodes, edges }
}

// Seed a document from a persisted graph. Everything lands at `(0, '')` — the
// bottom of the total order — so any real edit from any site supersedes the
// baseline without a special case.
function docFromGraph({ nodes = [], edges = [] } = {}) {
  const doc = createDoc()
  for (const node of nodes) {
    if (!node?.id) continue
    applyOp(doc, { t: 'node.add', id: node.id, l: 0, s: '', node })
  }
  for (const edge of edges) {
    if (!edge?.id) continue
    applyOp(doc, { t: 'edge.add', id: edge.id, l: 0, s: '', edge })
  }
  return doc
}

// Whether an operation is well-formed enough to apply. Called at the socket
// boundary: an operation arriving from a browser is untrusted input, and one
// with a hostile `path` would otherwise write a field nobody can see.
const SAFE_PATH = /^(type|position|data\.[\w-]{1,64}|config\.[\w-]{1,64})$/

function isValidOp(op) {
  if (!op || typeof op !== 'object') return false
  if (typeof op.id !== 'string' || op.id.length === 0 || op.id.length > 128) return false
  if (!Number.isInteger(op.l) || op.l < 0) return false
  if (typeof op.s !== 'string' || op.s.length === 0 || op.s.length > 64) return false
  switch (op.t) {
    case 'node.add':
      return Boolean(op.node) && typeof op.node === 'object'
    case 'edge.add':
      return Boolean(op.edge) && typeof op.edge === 'object'
    case 'node.remove':
    case 'edge.remove':
      return true
    case 'node.set':
      // Prototype pollution has an obvious shape here — a `path` of
      // `data.__proto__` reaching an object write in `nodeFromRecord`. The
      // shape allowlist is not sufficient on its own, because `__proto__` is a
      // perfectly ordinary-looking word-character key: the reserved names have
      // to be named.
      if (typeof op.path !== 'string' || !SAFE_PATH.test(op.path)) return false
      return !UNSAFE_KEY.has(op.path.split('.')[1])
    default:
      return false
  }
}

module.exports = {
  createDoc,
  applyOp,
  materialize,
  materializeOne,
  docFromGraph,
  isValidOp,
  newer,
  nodeFields,
}
