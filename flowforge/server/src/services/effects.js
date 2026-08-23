// What can a run of this workflow actually *do* — and what has to be true first.
//
// The static checks either side of this one each answer a different half of the
// question and neither answers it whole:
//
//   * The **linter** asks whether a node's config is valid. It has no opinion
//     about whether the node runs.
//   * **Lineage** asks where a value came from and where it leaves. It names the
//     sinks, and says nothing about which of them a given run reaches.
//   * **Guarantees** ask whether a property holds over every execution the graph
//     admits — but only about properties somebody thought to declare.
//   * **Path feasibility** asks whether an input exists that takes a branch. It
//     is about the *data*, not about the effect at the end.
//
// The question none of them answers is the one a security review opens with:
//
//     "What can this workflow do to the outside world, and for each of those
//      things, what has to have happened first?"
//
// A person answers it today by reading the canvas and tracing backwards, which
// is exactly the kind of work a graph algorithm should be doing. And the answer
// is a classical one: an effect's preconditions are the **decisions it is
// control-dependent on**.
//
// The rule, stated precisely, is what keeps the report honest:
//
//     Effect node N requires outcome `o` of decision D when
//        (1) D **dominates** N — every path to N goes through D — and
//        (2) N is reachable from exactly one of D's outcome groups, namely o.
//
// (1) alone is not enough: a decision every path passes through might lead to N
// whichever way it goes, in which case it gates nothing. (2) alone is not enough
// either: N might also be reachable by a path that never touches D at all, which
// is precisely the hole the guarantees feature exists for — somebody wires a
// manual trigger straight at the charge node and the approval becomes optional.
// Together they are a proof, and the report claims nothing it cannot prove:
// anything ambiguous produces *fewer* conditions rather than more, because a
// precondition claimed and not real is a review that concluded the wrong thing.
//
// Pure: a graph in, a report out. `dominance.js` supplies the dominator tree and
// `guarantees.js` supplies the execution graph — including the outcome
// partition, which is why a condition, a nine-case switch, a validate gate, an
// approval, a callback and a per-node error branch all work here without this
// file knowing what any of them are.

const { executionGraph } = require('./guarantees')
const { ENTRY, EXIT, immediateDominators, dominates } = require('./dominance')

// The node types that reach outside FlowForge or cost money. A log node writes
// to stdout and a transform rearranges an object; neither is something a
// reviewer needs to know can happen, and listing them would bury the ones that
// are.
const EFFECT_KINDS = {
  'action-http': 'http',
  'action-email': 'email',
  'action-slack': 'slack',
  'sub-workflow': 'sub-workflow',
  'for-each': 'sub-workflow',
  'ai-prompt': 'model',
  'ai-classify': 'model',
  'ai-extract': 'model',
}

// The host a URL will actually be fetched from, or null when the graph does not
// determine it.
//
// Deliberately more precise than "does the string contain a template": in
// `https://api.acme.com/orders/{{trigger.id}}` the *authority* is fixed and only
// the path varies, so the destination is known. That is the same distinction
// lineage draws when it decides an SSRF finding — only a dynamic authority lets
// a caller choose where the request goes — and a report that called this URL
// "dynamic" would be telling a reviewer to investigate a pinned host.
function hostOf(url) {
  const text = String(url ?? '')
  if (!text) return null
  const match = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)/i.exec(text)
  if (!match) return null
  const [, scheme, authority] = match
  if (!authority || authority.includes('{{')) return null
  try {
    return new URL(`${scheme}${authority}`).host || null
  } catch {
    return null
  }
}

// A one-line description of what an effect node reaches. Null where the graph
// does not say, which the surfaces render as "dynamic" rather than inventing a
// value.
function targetOf(node) {
  const config = node.data?.config || {}
  switch (node.type) {
    case 'action-http':
      return hostOf(config.url)
    case 'action-slack':
      return hostOf(config.webhookUrl)
    case 'action-email': {
      const to = String(config.to ?? '')
      return to && !to.includes('{{') ? to : null
    }
    case 'sub-workflow':
    case 'for-each':
      return config.workflowId || null
    case 'ai-prompt':
    case 'ai-classify':
    case 'ai-extract':
      return config.model || null
    default:
      return null
  }
}

const labelOf = (node) => node?.data?.label || node?.id || ''

// Every node reachable from a set of starting nodes, over the execution graph's
// successors. Excludes the virtual EXIT, which is reachable from everywhere and
// would make every effect look reachable from every outcome.
function reachSet(graph, starts) {
  const seen = new Set()
  const queue = [...starts]
  while (queue.length) {
    const current = queue.shift()
    if (current == null || current === EXIT || seen.has(current)) continue
    seen.add(current)
    for (const next of graph.succ.get(current) || []) queue.push(next)
  }
  return seen
}

function hasCycle(graph) {
  const state = new Map()
  for (const n of graph.nodes) {
    if (state.has(n.id)) continue
    const stack = [[n.id, 0]]
    state.set(n.id, 0)
    while (stack.length) {
      const frame = stack[stack.length - 1]
      const kids = (graph.succ.get(frame[0]) || []).filter((k) => k !== EXIT && k !== ENTRY)
      if (frame[1] < kids.length) {
        const next = kids[frame[1]++]
        if (state.get(next) === 0) return true
        if (!state.has(next)) {
          state.set(next, 0)
          stack.push([next, 0])
        }
      } else {
        state.set(frame[0], 1)
        stack.pop()
      }
    }
  }
  return false
}

function analyzeEffects(rawGraph) {
  const graph = executionGraph(rawGraph)
  if (graph.nodes.length === 0) return { available: false, reason: 'empty' }
  // A cyclic graph never runs at all — the engine refuses it before any node
  // executes — so every claim about what it can do would be about something
  // that cannot happen.
  if (hasCycle(graph)) return { available: false, reason: 'cycle' }

  const idom = immediateDominators({ entry: ENTRY, succ: graph.succ, pred: graph.pred })

  // What each decision's outcomes lead to, computed once. The starts are the
  // *targets* of that outcome's edges, so the decision node itself is not in
  // its own reach set.
  const decisionReach = new Map() // decisionId -> [{ name, handles, reach:Set }]
  for (const [id, groups] of graph.decisions) {
    decisionReach.set(
      id,
      groups.map((group) => ({
        name: group.name,
        handles: group.handles,
        reach: reachSet(graph, group.edges.map((e) => e.target)),
      }))
    )
  }

  const effects = []
  for (const node of graph.nodes) {
    const kind = EFFECT_KINDS[node.type]
    if (!kind) continue

    const conditions = []
    for (const [decisionId, groups] of decisionReach) {
      if (decisionId === node.id) continue
      // (1) every path to this effect goes through the decision.
      if (!dominates(idom, decisionId, node.id)) continue
      // (2) exactly one of its outcomes leads here. Zero means the effect is
      // not downstream of the decision at all; more than one means the decision
      // gates nothing about it, whichever way it goes.
      const leading = groups.filter((g) => g.reach.has(node.id))
      if (leading.length !== 1) continue
      const decision = graph.byId.get(decisionId)
      conditions.push({
        nodeId: decisionId,
        label: labelOf(decision),
        type: decision?.type ?? null,
        outcome: leading[0].name,
      })
    }

    // Ordered by how close the decision is to the effect — a reviewer reads
    // "approved, then low-risk" rather than the order the map happened to
    // iterate in.
    conditions.sort((a, b) => (dominates(idom, a.nodeId, b.nodeId) ? -1 : 1))

    effects.push({
      nodeId: node.id,
      label: labelOf(node),
      type: node.type,
      kind,
      target: targetOf(node),
      conditions,
      // The headline. An effect with no preconditions happens on every run that
      // gets that far, which is the sentence a reviewer needs first.
      always: conditions.length === 0,
    })
  }

  effects.sort((a, b) => a.conditions.length - b.conditions.length || a.label.localeCompare(b.label))

  // The inverse view, and the one somebody actually asks out loud: *if this
  // gate rejects, what can still happen?* Same facts, read the other way.
  const decisions = []
  for (const [decisionId, groups] of decisionReach) {
    const node = graph.byId.get(decisionId)
    decisions.push({
      nodeId: decisionId,
      label: labelOf(node),
      type: node?.type ?? null,
      outcomes: groups.map((group) => ({
        name: group.name,
        // Effects that require *this* outcome — i.e. the ones any other outcome
        // rules out.
        gates: effects
          .filter((e) =>
            e.conditions.some((c) => c.nodeId === decisionId && c.outcome === group.name)
          )
          .map((e) => e.nodeId),
      })),
    })
  }
  decisions.sort((a, b) => a.label.localeCompare(b.label))

  const unconditional = effects.filter((e) => e.always).length
  return {
    available: true,
    effects,
    decisions,
    summary: {
      total: effects.length,
      unconditional,
      gated: effects.length - unconditional,
      dynamicTargets: effects.filter((e) => e.target === null).length,
    },
  }
}

module.exports = { analyzeEffects, hostOf, targetOf, EFFECT_KINDS }
