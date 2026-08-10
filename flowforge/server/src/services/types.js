// A structural type lattice for the data that flows between workflow nodes.
//
// The canvas is a dataflow graph, and every node's output has a shape the
// runner guarantees. Until now nothing wrote that shape down, so a typo'd
// reference (`{{http-1.bdy}}`) or an arithmetic slip (`total * status`) only
// announced itself at 3am. This module is the vocabulary for saying what a
// value *is*; `typeInference.js` derives those facts from a graph, and
// `expression/typecheck.js` checks FXL against them.
//
// Types are plain JSON objects — inspectable, cacheable, and sendable to the
// client, exactly like the FXL AST:
//
//   { kind: 'unknown' }                          no information
//   { kind: 'any' }                              genuinely dynamic
//   { kind: 'null' | 'boolean' | 'number' | 'string' }
//   { kind: 'array',  element: T }
//   { kind: 'object', fields: { name: { type, optional } }, open }
//   { kind: 'union',  options: [T, …] }          never nested, never empty
//
// Two ideas carry the design.
//
// **`unknown` and `any` are different facts, and both silence every check.**
// `unknown` means the analysis has nothing to say (a sub-workflow's return
// value); `any` means the value is dynamic *by contract* (a parsed HTTP body).
// Neither can produce a type error — an analysis that guesses is worse than one
// that abstains — but the UI shows them differently, because "we don't know"
// and "it's whatever the API sent" are different things to a person reading a
// schema.
//
// **`unknown` is the neutral element of the join.** Merging it with a known
// type keeps the known type rather than collapsing to nothing, so one opaque
// branch doesn't erase everything the other branches proved. What it *does*
// contribute is uncertainty: joining an object against `unknown` opens the
// object, because the branch we can't see may carry fields we haven't listed.

// — constructors ————————————————————————————————————————————————————————

const UNKNOWN = Object.freeze({ kind: 'unknown' })
const ANY = Object.freeze({ kind: 'any' })
const NULL = Object.freeze({ kind: 'null' })
const BOOLEAN = Object.freeze({ kind: 'boolean' })
const NUMBER = Object.freeze({ kind: 'number' })
const STRING = Object.freeze({ kind: 'string' })

const PRIMITIVE_KINDS = new Set(['null', 'boolean', 'number', 'string'])

function arrayOf(element = UNKNOWN) {
  return { kind: 'array', element }
}

// objectOf({ status: NUMBER, note: { type: STRING, optional: true } }).
// `open` marks a shape that may carry fields beyond the ones listed — a webhook
// payload merged into a trigger's output, say — which is what stops the
// unknown-field check from firing on data we never claimed to know.
function objectOf(shape = {}, { open = false } = {}) {
  const fields = {}
  for (const [name, spec] of Object.entries(shape)) {
    if (spec && typeof spec === 'object' && 'type' in spec && !('kind' in spec)) {
      fields[name] = { type: spec.type || UNKNOWN, optional: Boolean(spec.optional) }
    } else {
      fields[name] = { type: spec || UNKNOWN, optional: false }
    }
  }
  return { kind: 'object', fields, open }
}

// A union of the given types, normalised: unions flatten, `unknown` drops out
// (it is the neutral element), `any` absorbs everything, duplicates collapse,
// and a one-option union is just that option. So `unionOf` never returns a
// union of one, and no union ever contains another.
function unionOf(types) {
  const flat = []
  const push = (t) => {
    if (!t) return
    if (t.kind === 'union') return t.options.forEach(push)
    if (t.kind === 'unknown') return
    flat.push(t)
  }
  types.forEach(push)
  if (flat.length === 0) return UNKNOWN
  if (flat.some((t) => t.kind === 'any')) return ANY
  const seen = new Map()
  for (const t of flat) {
    const key = canonical(t)
    if (!seen.has(key)) seen.set(key, t)
  }
  const options = [...seen.values()]
  return options.length === 1 ? options[0] : { kind: 'union', options }
}

// A stable string key for a type, used to deduplicate unions and compare
// shapes. Object fields are sorted so key order can never make two identical
// shapes look different.
function canonical(type) {
  const t = type || UNKNOWN
  switch (t.kind) {
    case 'array':
      return `array<${canonical(t.element)}>`
    case 'object': {
      const parts = Object.keys(t.fields)
        .sort()
        .map((k) => `${k}${t.fields[k].optional ? '?' : ''}:${canonical(t.fields[k].type)}`)
      return `object{${parts.join(',')}${t.open ? ',…' : ''}}`
    }
    case 'union':
      return `(${t.options.map(canonical).sort().join('|')})`
    default:
      return t.kind
  }
}

// — predicates ——————————————————————————————————————————————————————————

// A type the analysis must stay silent about. Every check in this codebase
// starts by asking this: no rule may report a problem it cannot prove.
function isDynamic(type) {
  const t = type || UNKNOWN
  return t.kind === 'unknown' || t.kind === 'any'
}

// The kinds a value of this type could have at runtime. Dynamic types return
// null, meaning "any kind" — callers must treat that as "can't tell".
function possibleKinds(type) {
  const t = type || UNKNOWN
  if (isDynamic(t)) return null
  if (t.kind === 'union') {
    const kinds = new Set()
    for (const opt of t.options) {
      const inner = possibleKinds(opt)
      if (inner === null) return null
      inner.forEach((k) => kinds.add(k))
    }
    return kinds
  }
  return new Set([t.kind])
}

// Could a value of this type be of `kind`? Dynamic types can be anything.
function mayBe(type, kind) {
  const kinds = possibleKinds(type)
  return kinds === null || kinds.has(kind)
}

// Is a value of this type certainly of `kind`?
function is(type, kind) {
  const kinds = possibleKinds(type)
  return kinds !== null && kinds.size === 1 && kinds.has(kind)
}

// Could this value be used where a number is wanted? FXL's arithmetic coerces
// numbers, booleans, and numeric strings and throws on everything else — so
// this is false only for types that would certainly throw.
function mayBeNumeric(type) {
  const kinds = possibleKinds(type)
  if (kinds === null) return true
  for (const k of kinds) {
    if (k === 'number' || k === 'boolean' || k === 'string') return true
  }
  return false
}

// Could this value be a container the `in` operator can search (array, string,
// or object)? `x in 5` is always false, which is never what anyone meant.
function mayBeContainer(type) {
  const kinds = possibleKinds(type)
  if (kinds === null) return true
  for (const k of kinds) {
    if (k === 'array' || k === 'string' || k === 'object') return true
  }
  return false
}

// — the join ————————————————————————————————————————————————————————————

// Least upper bound of two types: the type of a value that could have come
// from either. Used wherever control flow converges — a ternary's two arms, a
// `||` fallback, or two branches of the graph feeding one node.
function join(a, b) {
  const left = a || UNKNOWN
  const right = b || UNKNOWN
  if (left.kind === 'unknown') return right
  if (right.kind === 'unknown') return left
  if (left.kind === 'any' || right.kind === 'any') return ANY
  if (canonical(left) === canonical(right)) return left

  if (left.kind === 'array' && right.kind === 'array') {
    return arrayOf(join(left.element, right.element))
  }
  if (left.kind === 'object' && right.kind === 'object') {
    const fields = {}
    const names = new Set([...Object.keys(left.fields), ...Object.keys(right.fields)])
    for (const name of names) {
      const l = left.fields[name]
      const r = right.fields[name]
      if (l && r) {
        fields[name] = { type: join(l.type, r.type), optional: l.optional || r.optional }
      } else {
        // Present on one side only: the value may or may not carry it.
        const only = l || r
        fields[name] = { type: only.type, optional: true }
      }
    }
    return { kind: 'object', fields, open: left.open || right.open }
  }
  return unionOf([left, right])
}

function joinAll(types) {
  return types.reduce((acc, t) => join(acc, t), UNKNOWN)
}

// The engine builds a node's input with `Object.assign({}, ...upstreamOutputs)`,
// and this models exactly that — which is *not* a plain join, because assignment
// order and branch certainty both matter.
//
// Each entry is `{ type, certain }`. A **certain** contributor always runs (its
// edge leaves a non-branching source), so its fields are definitely present. An
// **uncertain** one sits behind a branch, so it may contribute nothing — its
// fields are recorded as optional and its types are folded into whatever a
// certain contributor already established, never replacing it outright.
//
// A dynamic contributor can't be enumerated, so it opens the result: fields we
// haven't listed may exist, and the unknown-field check stands down.
function mergeAssign(entries) {
  const fields = {}
  let open = false
  for (const entry of entries) {
    const type = entry?.type || UNKNOWN
    const certain = Boolean(entry?.certain)
    if (isDynamic(type)) {
      open = true
      continue
    }
    if (type.kind !== 'object') {
      // Assigning a primitive or array contributes no enumerable fields worth
      // modelling (`Object.assign({}, 5)` is `{}`), but it does mean the shape
      // is not fully under our control.
      open = true
      continue
    }
    if (type.open) open = true
    for (const [name, spec] of Object.entries(type.fields)) {
      const existing = fields[name]
      const present = certain && !spec.optional
      if (!existing) {
        fields[name] = { type: spec.type, optional: !present }
      } else {
        fields[name] = {
          type: join(existing.type, spec.type),
          // Once any contributor guarantees the field, it is guaranteed.
          optional: existing.optional && !present,
        }
      }
    }
  }
  return { kind: 'object', fields, open }
}

// — assignability ———————————————————————————————————————————————————————

// Would a value of `source` be acceptable where `target` is expected? Used for
// function arguments. Deliberately permissive: it answers "is this definitely
// wrong?" by returning false only when no runtime value could satisfy both.
function accepts(target, source) {
  const want = target || UNKNOWN
  const got = source || UNKNOWN
  if (isDynamic(want) || isDynamic(got)) return true
  if (want.kind === 'union') return want.options.some((opt) => accepts(opt, got))
  if (got.kind === 'union') return got.options.every((opt) => accepts(want, opt))
  if (want.kind !== got.kind) return false
  if (want.kind === 'array') return accepts(want.element, got.element)
  if (want.kind === 'object') {
    for (const [name, spec] of Object.entries(want.fields)) {
      if (spec.optional) continue
      const have = got.fields[name]
      if (!have) return got.open
      if (!accepts(spec.type, have.type)) return false
    }
    return true
  }
  return true
}

// — member access ———————————————————————————————————————————————————————

// Reading a field off a value has two different meanings in FlowForge, and
// conflating them would make the checker wrong in one of them:
//
//   'template'  — `{{node.a.b}}`, resolved by the engine with plain JavaScript
//                 property access. `items.length` is a number; `"abc".length`
//                 is a number.
//   'expression'— FXL `a.b`, resolved by the evaluator's `readMember`, which
//                 refuses every non-integer key on arrays and strings. There,
//                 `items.length` is `undefined` — a real and easily-missed bug
//                 that only this distinction can catch.
//
// Returns { exists: 'yes' | 'no' | 'maybe', type }. Only 'no' is reportable.
function lookup(type, key, mode = 'template') {
  const t = type || UNKNOWN
  const name = String(key)
  if (isDynamic(t)) return { exists: 'maybe', type: t.kind === 'any' ? ANY : UNKNOWN }

  if (t.kind === 'union') {
    // Present on every option → present. On none → absent. Otherwise maybe.
    const results = t.options.map((opt) => lookup(opt, name, mode))
    if (results.every((r) => r.exists === 'no')) return { exists: 'no', type: UNKNOWN }
    const found = results.filter((r) => r.exists !== 'no')
    return {
      exists: found.every((r) => r.exists === 'yes') && found.length === results.length
        ? 'yes'
        : 'maybe',
      type: joinAll(found.map((r) => r.type)),
    }
  }

  if (t.kind === 'object') {
    const field = t.fields[name]
    if (field) return { exists: field.optional ? 'maybe' : 'yes', type: field.type }
    return t.open ? { exists: 'maybe', type: UNKNOWN } : { exists: 'no', type: UNKNOWN }
  }

  if (t.kind === 'array') {
    if (isIndex(name)) return { exists: 'maybe', type: t.element }
    if (mode === 'template' && name === 'length') return { exists: 'yes', type: NUMBER }
    return { exists: 'no', type: UNKNOWN }
  }

  if (t.kind === 'string') {
    if (isIndex(name)) return { exists: 'maybe', type: STRING }
    if (mode === 'template' && name === 'length') return { exists: 'yes', type: NUMBER }
    return { exists: 'no', type: UNKNOWN }
  }

  // number / boolean / null have no readable members in either mode.
  return { exists: 'no', type: UNKNOWN }
}

function isIndex(name) {
  return /^\d+$/.test(name)
}

// Walk a dotted path, stopping at the first segment that certainly doesn't
// exist. Returns { exists, type, failedAt, container } so a caller can say
// *which* segment was wrong and what the thing it was read from looked like.
function lookupPath(type, segments, mode = 'template') {
  let current = type || UNKNOWN
  let exists = 'yes'
  for (let i = 0; i < segments.length; i++) {
    const step = lookup(current, segments[i], mode)
    if (step.exists === 'no') {
      return { exists: 'no', type: UNKNOWN, failedAt: i, container: current }
    }
    if (step.exists === 'maybe') exists = 'maybe'
    current = step.type
  }
  return { exists, type: current, failedAt: null, container: null }
}

// The field names a type offers, for "did you mean" and for the data picker.
function fieldNames(type) {
  const t = type || UNKNOWN
  if (t.kind === 'object') return Object.keys(t.fields)
  if (t.kind === 'union') {
    const names = new Set()
    for (const opt of t.options) fieldNames(opt).forEach((n) => names.add(n))
    return [...names]
  }
  return []
}

// — suggestions —————————————————————————————————————————————————————————

// Levenshtein distance, iterative with a single rolling row. Bounded by the
// caller's `max` so a long pair bails early instead of filling a matrix.
function editDistance(a, b, max = Infinity) {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost)
      if (row[j] < best) best = row[j]
    }
    if (best > max) return max + 1
    prev = row
  }
  return prev[b.length]
}

// The closest candidate to `name`, or null when nothing is close enough. A
// case-only difference always wins — it's the most common typo and the most
// confidently fixable. Otherwise the edit distance must clear two bars: a flat
// ceiling, and *strictly less than the name's own length*, so a one-letter name
// is never "helpfully" corrected into an unrelated one-letter field.
function suggest(name, candidates) {
  if (!name || !candidates || candidates.length === 0) return null
  const text = String(name)
  const lower = text.toLowerCase()
  const caseMatch = candidates.find((c) => String(c).toLowerCase() === lower)
  if (caseMatch && caseMatch !== name) return caseMatch
  const limit = Math.min(text.length <= 4 ? 1 : 2, text.length - 1)
  if (limit < 1) return null
  let best = null
  let bestDistance = limit + 1
  for (const candidate of candidates) {
    if (candidate === name) continue
    const d = editDistance(text, String(candidate), limit)
    if (d < bestDistance) {
      best = candidate
      bestDistance = d
    }
  }
  return bestDistance <= limit ? best : null
}

// — rendering ———————————————————————————————————————————————————————————

const MAX_DESCRIBED_FIELDS = 6

// A short, human-readable rendering — the string that ends up in a lint
// message and in the data picker. Deliberately compact: a lint line saying
// `{ status: number, body: any }` is read at a glance, a full JSON Schema is not.
function describe(type, depth = 0) {
  const t = type || UNKNOWN
  switch (t.kind) {
    case 'array':
      return t.element.kind === 'union'
        ? `(${describe(t.element, depth + 1)})[]`
        : `${describe(t.element, depth + 1)}[]`
    case 'object': {
      if (depth >= 2) return 'object'
      const names = Object.keys(t.fields)
      if (names.length === 0) return t.open ? 'object' : '{}'
      const shown = names.slice(0, MAX_DESCRIBED_FIELDS).map((n) => {
        const f = t.fields[n]
        return `${n}${f.optional ? '?' : ''}: ${describe(f.type, depth + 1)}`
      })
      const more = names.length > MAX_DESCRIBED_FIELDS || t.open ? ', …' : ''
      return `{ ${shown.join(', ')}${more} }`
    }
    case 'union':
      return t.options.map((o) => describe(o, depth)).join(' | ')
    default:
      return t.kind
  }
}

module.exports = {
  UNKNOWN,
  ANY,
  NULL,
  BOOLEAN,
  NUMBER,
  STRING,
  PRIMITIVE_KINDS,
  arrayOf,
  objectOf,
  unionOf,
  canonical,
  isDynamic,
  possibleKinds,
  mayBe,
  is,
  mayBeNumeric,
  mayBeContainer,
  join,
  joinAll,
  mergeAssign,
  accepts,
  lookup,
  lookupPath,
  fieldNames,
  suggest,
  editDistance,
  describe,
}
