// What does this workflow promise the workflows that call it, and does this
// change keep the promise?
//
// FlowForge type-checks a graph against itself, and it types a **caller**
// against its callee: `typeInference.subWorkflowType` walks into the target
// workflow and returns what it actually returns, so `{{sub.orderId}}` in the
// caller is checked against the callee's real shape. That is the right
// direction for one half of the problem and the wrong direction for the other.
//
// The half nobody covers is the one that hurts. The author who **breaks** the
// contract is not the author who finds out. Rename a field inside a
// sub-workflow's return node and:
//
//   * the callee still lints — nothing about its own graph is wrong;
//   * every existing caller keeps referencing the old name, which now resolves
//     to nothing;
//   * the callee's author sees no error, because the broken reference is in
//     somebody else's workflow, possibly one they cannot see;
//   * and the caller's author finds out at run time, when a field arrives
//     `undefined` and an HTTP body goes out with a hole in it.
//
// The dependency graph does not catch it either. `workflowDependencies` asks
// whether the *reference to the workflow* still resolves — whether the target
// still exists. It does. What changed is the shape of what it returns, and a
// reference check cannot see a shape.
//
// ---
//
// **The rule is variance, and the standard one.** A workflow's return type is a
// promise to its callers, and a change keeps the promise when the new type is
// **substitutable** for the old one — every value the callee can now return is
// one the caller was already prepared to handle. That is `T_after <: T_before`:
// covariance of return types, which `types.js` already has the subtyping test
// for (`T.accepts(want, got)` asks whether `got <: want`).
//
//     safe      adding a field; optional → required; **narrowing** a type
//     breaking  removing a field; required → optional; **widening** a type
//
// Both halves of that are the opposite of the intuition people carry over from
// function *arguments*, and for the same reason: a return value is something
// the caller **consumes** rather than supplies, so the permissive direction
// flips. Narrowing `"ok" | "failed"` to `"ok"` leaves a caller's `else` branch
// dead and nothing broken. Widening `number` to `number | string` hands a
// caller doing arithmetic a string. Likewise a required field going optional
// means a caller that read it unconditionally may now get nothing, while an
// optional one becoming required can only ever give it more.
//
// Which makes this semantic versioning for workflows: `additive` is a minor
// change, `breaking` is a major one, and `compatible` is a patch.
//
// **Two levels of finding, and the distinction matters.** A shape change with a
// caller currently referencing the removed field is a *break*: somebody's
// workflow stops working the moment this is saved, and the report names the
// workflow, the node, and the reference. A shape change nobody references yet
// is *incompatible but harmless* — the contract narrowed, no current victim.
// Reporting those identically would either cry wolf or bury the real one.

const T = require('./types')
const { inferGraphTypes, returnTypeOf } = require('./typeInference')

// A `{{path}}` inside a config string. Same shape the type checker uses; kept
// local so this file does not depend on the checker's internals.
const PLACEHOLDER = /\{\{\s*([\w-]+(?:\.[\w-]+)*)\s*\}\}/g

// The node types that call another workflow, and how the callee's return type
// reaches the caller's references.
//
//   sub-workflow  the node's output *is* the callee's return type, so
//                 `{{sub.orderId}}` resolves straight against it.
//   for-each      the node's output wraps it: `{ count, succeeded, results: [T] }`.
//                 A template path cannot index an array, so a for-each caller has
//                 no resolvable reference into the contract — it is affected
//                 structurally and no specific break can be named. Saying so is
//                 better than inventing one.
const DIRECT = 'sub-workflow'
const WRAPPED = 'for-each'

const labelOf = (node) => node?.data?.label || node?.id || ''

// Flatten an object type into every leaf path it offers, with the type at each
// path. Unlike the picker's `fieldSummary` this goes all the way down, because
// a caller can reference `{{sub.customer.address.city}}` and a contract that
// stopped looking at depth 2 would call that change compatible.
//
// Depth-capped anyway: a self-referential shape would otherwise walk forever,
// and nothing this deep is a contract anybody is reasoning about.
const MAX_DEPTH = 8
function flatten(type, prefix = '', depth = 0, out = new Map()) {
  const t = type || T.UNKNOWN
  if (t.kind !== 'object' || depth >= MAX_DEPTH) return out
  for (const [name, spec] of Object.entries(t.fields)) {
    const path = prefix ? `${prefix}.${name}` : name
    out.set(path, { type: spec.type, optional: Boolean(spec.optional) })
    flatten(spec.type, path, depth + 1, out)
  }
  return out
}

// What a graph promises: its return type, and the paths that type offers.
function contractOf(graph, { resolveWorkflow = null } = {}) {
  const inferred = inferGraphTypes(graph, { resolveWorkflow })
  const nodeById = Object.fromEntries((graph?.nodes || []).map((n) => [n.id, n]))
  const type = returnTypeOf(inferred, nodeById)
  return {
    type,
    describe: T.describe(type),
    // An open shape promises nothing beyond the fields it names, which is why a
    // *removal* from one is still a removal but an absence is never a break.
    open: type?.kind === 'object' ? Boolean(type.open) : true,
    fields: flatten(type),
  }
}

// How the promise changed.
function compareContracts(before, after) {
  const removed = []
  const widened = []
  const weakened = []
  const added = []

  for (const [path, spec] of before.fields) {
    const now = after.fields.get(path)
    if (!now) {
      removed.push({ path, was: T.describe(spec.type) })
      continue
    }
    // `accepts(want, got)` asks whether `got` is substitutable for `want`. Here
    // that is "is every value the callee can now return one the caller was
    // already prepared for?" — so a false means the type grew past what callers
    // were written against.
    if (!T.accepts(spec.type, now.type)) {
      widened.push({ path, was: T.describe(spec.type), now: T.describe(now.type) })
    }
    if (!spec.optional && now.optional) weakened.push({ path })
  }

  for (const path of after.fields.keys()) {
    if (!before.fields.has(path)) added.push({ path, now: T.describe(after.fields.get(path).type) })
  }

  const breaks = removed.length + widened.length + weakened.length
  return {
    removed,
    widened,
    weakened,
    added,
    // Semantic versioning, in the only vocabulary that means anything to
    // somebody about to press save.
    verdict: breaks > 0 ? 'breaking' : added.length > 0 ? 'additive' : 'compatible',
  }
}

// Every `{{<nodeId>.<path>}}` a caller's config makes, grouped by the node it
// reads from. The caller's own reachability is irrelevant here: a reference in
// a node that never runs still stops resolving, and the linter's job is to
// report it either way.
function referencesByNode(graph) {
  const byNode = new Map()
  const walk = (value) => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(PLACEHOLDER)) {
        const [head, ...rest] = match[1].split('.')
        if (rest.length === 0) continue
        if (!byNode.has(head)) byNode.set(head, new Set())
        byNode.get(head).add(rest.join('.'))
      }
    } else if (Array.isArray(value)) {
      value.forEach(walk)
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(walk)
    }
  }
  for (const node of graph?.nodes || []) walk(node.data?.config || {})
  return byNode
}

// Which of one caller's references into `calleeId` stop working under the new
// contract.
//
// Errs toward saying less, like every analysis here. A reference the type
// system cannot resolve *either way* — into an open shape, through an unknown —
// is not reported, because a break claimed and not real sends somebody to fix a
// workflow that was fine.
function breaksIn(callerGraph, calleeId, after) {
  const references = referencesByNode(callerGraph)
  const breaks = []
  let affected = false

  for (const node of callerGraph?.nodes || []) {
    const target = node.data?.config?.workflowId
    if (target !== calleeId) continue
    if (node.type === WRAPPED) {
      // Structurally affected; no resolvable reference to name.
      affected = true
      continue
    }
    if (node.type !== DIRECT) continue
    affected = true

    for (const path of references.get(node.id) || []) {
      const resolved = T.lookupPath(after.type, path.split('.'), 'template')
      if (resolved.exists === 'no') {
        const segments = path.split('.')
        const missing = segments[resolved.failedAt]
        const hint = T.suggest(missing, T.fieldNames(resolved.container))
        breaks.push({
          nodeId: node.id,
          label: labelOf(node),
          reference: `${node.id}.${path}`,
          path,
          missing,
          reason: 'removed',
          suggestion: hint || null,
        })
      }
    }
  }

  return { affected, breaks }
}

module.exports = {
  contractOf,
  compareContracts,
  referencesByNode,
  breaksIn,
  flatten,
  DIRECT,
  WRAPPED,
}
