// What a run can *ultimately* do — across the sub-workflow boundary.
//
// [The effect report](./effects.js) answers "what can this workflow do to the
// outside world, and what has to be true first?" over one graph. It is the
// question a security review opens with, and over one graph it is answered
// completely.
//
// A sub-workflow node breaks that. On the canvas it is one box. At run time it
// is an entire other workflow, with its own HTTP calls, its own emails, its own
// gates — and the per-graph report describes it honestly and uselessly:
//
//     workflow  Fulfil order   → 4f2a…       always
//
// *"Calls workflow 4f2a"* is true and tells a reviewer nothing. The workflow
// they are reviewing can charge a card; it just does it three boxes and one
// call away, and nobody reading the canvas would know.
//
// So the sub-workflow effect is **expanded** into what the callee actually
// does, and the same for its callees, to a bounded depth.
//
// ---
//
// ## Composing the preconditions
//
// This is the part that has to be right, and it is a conjunction.
//
// An effect inside the callee is gated by the callee's own decisions. The call
// *itself* is gated by the caller's. So the honest precondition for "this run
// can charge a card" is **both**:
//
//     Approve = true          ← in the caller, gating the sub-workflow call
//     Risk check = low        ← in the callee, gating the charge
//
// Dropping either half would be a different kind of wrong. Keeping only the
// callee's conditions claims the charge happens whenever the callee decides it
// should, ignoring that the caller may never invoke it. Keeping only the
// caller's claims it happens on every call. The report carries both, in call
// order, with the workflow each came from — so a reviewer reads a chain rather
// than a set of unattributed clauses.
//
// ## What stops the walk
//
//   * **A cycle.** A workflow already on the call stack is not expanded again;
//     the engine refuses one at run time and expanding it here would not
//     terminate. The chain is reported as recursive rather than dropped.
//   * **Depth.** Bounded, and a chain that hits the bound says so instead of
//     silently reporting a prefix as though it were the whole answer.
//   * **A target that cannot be read** — deleted, undeployed, in another
//     workspace. The unexpanded effect stays in the report exactly as the
//     per-graph analysis produced it, because "calls something I cannot see" is
//     a more useful thing to tell a reviewer than nothing.

const { analyzeEffects } = require('./effects')

// Deep enough for any call chain anybody has drawn on purpose, shallow enough
// that a mistake cannot make this walk a workspace.
const MAX_DEPTH = 4

const SUB_WORKFLOW_TYPES = new Set(['sub-workflow', 'for-each'])

// Expand one workflow's effects, following every sub-workflow call.
//
// `resolve(id)` returns `{ id, name, graph }` or null. Kept as a parameter
// rather than a database query so the analysis stays pure and the caller
// decides what "visible" means — which is also what keeps the workspace
// boundary in one place.
function expand(workflow, resolve, { depth, stack, chain }) {
  const report = analyzeEffects(workflow.graph)
  if (!report.available) {
    return {
      effects: [],
      // A cyclic or empty callee is not an effect; saying which is what lets
      // the caller distinguish "reaches nothing" from "could not be read".
      unresolved: [{ workflowId: workflow.id, name: workflow.name, reason: report.reason, chain }],
    }
  }

  const effects = []
  const unresolved = []

  for (const effect of report.effects) {
    // Every effect inherits the conditions of the calls that led here, ahead of
    // its own — the order a reviewer reads them in.
    const conditions = [
      ...chain.conditions,
      ...effect.conditions.map((c) => ({ ...c, workflowId: workflow.id, workflowName: workflow.name })),
    ]
    const via = chain.via

    const node = workflow.graph.nodes.find((n) => n.id === effect.nodeId)
    const target = SUB_WORKFLOW_TYPES.has(node?.type) ? node?.data?.config?.workflowId : null

    if (!target) {
      effects.push({ ...effect, conditions, via, workflowId: workflow.id, workflowName: workflow.name })
      continue
    }

    // A call. Three reasons not to follow it, and each keeps the unexpanded
    // effect rather than dropping it — "calls something I cannot see" is more
    // useful than silence.
    if (stack.includes(target)) {
      effects.push({ ...effect, conditions, via, workflowId: workflow.id, workflowName: workflow.name, recursive: true })
      unresolved.push({ workflowId: target, reason: 'cycle', chain: via })
      continue
    }
    if (depth >= MAX_DEPTH) {
      effects.push({ ...effect, conditions, via, workflowId: workflow.id, workflowName: workflow.name, truncated: true })
      unresolved.push({ workflowId: target, reason: 'depth', chain: via })
      continue
    }
    const callee = resolve(target)
    if (!callee) {
      effects.push({ ...effect, conditions, via, workflowId: workflow.id, workflowName: workflow.name })
      unresolved.push({ workflowId: target, reason: 'not-visible', chain: via })
      continue
    }

    const inner = expand(callee, resolve, {
      depth: depth + 1,
      stack: [...stack, workflow.id],
      chain: {
        conditions,
        via: [...via, { workflowId: callee.id, name: callee.name, nodeId: effect.nodeId, label: effect.label }],
      },
    })
    effects.push(...inner.effects)
    unresolved.push(...inner.unresolved)
  }

  return { effects, unresolved }
}

// The transitive effect report for one workflow.
//
// Shaped like the per-graph one so a surface can render either, with two
// additions per effect: `via`, the call chain that reaches it, and conditions
// that name which workflow each came from.
function reachableEffects(root, resolve) {
  if (!root?.graph) return { available: false, reason: 'empty' }

  const { effects, unresolved } = expand(root, resolve, {
    depth: 0,
    stack: [],
    chain: { conditions: [], via: [] },
  })

  // The unconditional ones first, and within that the deepest chains — an
  // effect four calls away that nothing gates is the one a reviewer has least
  // chance of having noticed on their own.
  effects.sort(
    (a, b) =>
      a.conditions.length - b.conditions.length ||
      b.via.length - a.via.length ||
      String(a.label).localeCompare(String(b.label))
  )

  const direct = effects.filter((e) => e.via.length === 0)
  return {
    available: true,
    workflowId: root.id,
    effects: effects.map((e) => ({
      nodeId: e.nodeId,
      label: e.label,
      type: e.type,
      kind: e.kind,
      target: e.target,
      workflowId: e.workflowId,
      workflowName: e.workflowName,
      via: e.via,
      conditions: e.conditions,
      always: e.conditions.length === 0,
      recursive: Boolean(e.recursive),
      truncated: Boolean(e.truncated),
    })),
    unresolved,
    summary: {
      total: effects.length,
      // The number the per-graph report would have given, so the difference is
      // visible rather than something to work out by counting.
      direct: direct.length,
      inherited: effects.length - direct.length,
      unconditional: effects.filter((e) => e.conditions.length === 0).length,
      workflows: new Set(effects.map((e) => e.workflowId)).size,
      deepest: effects.reduce((n, e) => Math.max(n, e.via.length), 0),
    },
  }
}

module.exports = { reachableEffects, MAX_DEPTH }
