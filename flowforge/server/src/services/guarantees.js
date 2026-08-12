// Workflow guarantees — path invariants verified over every execution the graph
// admits, not over the one that happened to run.
//
// Everything else that inspects a canvas asks a question about a *place*. The
// linter asks whether a node's config is complete; the type checker asks what
// shape a value has here; lineage asks where a value came from; a policy asks
// whether this workflow is allowed to exist. None of them can answer the
// question that keeps somebody up at night, which is about a *path*:
//
//     can this ever charge a card without the approval having been granted?
//
// That is not a config question. Every node involved lints perfectly. It is a
// question about the set of executions the graph permits, and the only honest
// way to answer it is to reason about all of them at once.
//
// The execution model makes that tractable. A node runs iff at least one of its
// incoming edges activated, and an edge activates iff its source succeeded and
// — for a node that routes — the edge's handle matches the outcome it settled
// (executionEngine.js, `activeIncomingFor`). So a node executed exactly when
// some chain of active edges reached it from a source node, and every such
// chain is a path in the graph. "A ran before B could" is therefore precisely
// **A dominates B**, and the dominator tree (services/dominance.js) decides it
// for every pair at once.
//
// Three kinds of invariant, each a different classical analysis:
//
//   requires   A dominates B          — B never runs unless A ran
//   ensures    B post-dominates A     — if A runs, B runs too
//   exclusive  A and B are separated  — no single run executes both
//              by some decision
//
// Declared per workflow, checked while editing, and enforced at deploy. The
// enforcement point is deliberate: a guarantee is the author's own statement
// about their design, so an edit that breaks one is a regression, and the last
// moment anybody is looking is the deploy. It is never applied to a run — a
// governance check that can take production down is worse than the bug it
// looks for, the same rule the policy engine follows.

const { compensationPlan } = require('./compensation')
const {
  ENTRY,
  EXIT,
  immediateDominators,
  dominatorChain,
  dominates,
  pathAvoiding,
  reverse,
} = require('./dominance')

const KINDS = ['requires', 'ensures', 'exclusive']

// Nodes whose failure the engine routes rather than propagates are excluded
// from the `onError` outcome split below — they already settle a routing
// result, and the engine ignores a policy on them (see the linter's
// UNCATCHABLE set, which this mirrors).
const UNCATCHABLE = new Set(['condition', 'switch', 'validate', 'approval'])

// Types worth suggesting an invariant *about*: a node that reaches outside
// FlowForge or spends money. Nobody needs an invariant guarding a Transform.
const CONSEQUENTIAL = new Set([
  'action-http',
  'action-email',
  'action-slack',
  'sub-workflow',
  'for-each',
  'ai-prompt',
  'ai-classify',
  'ai-extract',
])

// Types that exist to *decide* something, and are therefore what an author
// meant to put in front of a consequential node.
const GATE = new Set(['approval', 'condition', 'switch', 'validate', 'wait-callback'])

const labelOf = (node) => node?.data?.label || node?.id || '(unknown)'

// — the outcome partition ————————————————————————————————————————————————
//
// The one structural fact everything below is built on. When a node settles,
// some of its outgoing edges activate and the rest stay dark, and for most
// nodes that is "all of them" — a plain action fans out to every successor at
// once. A *decision* is a node whose outgoing edges are split into groups of
// which exactly one activates.
//
// Modelling it as a partition rather than per-type special cases is what lets
// one check cover a condition, a switch with nine cases, a validate gate, an
// approval, a callback, and the per-node error branch. They differ only in how
// many groups they have and what the groups are called.
function outcomeGroups(node) {
  const config = node.data?.config || {}
  switch (node.type) {
    case 'condition':
    case 'approval':
      return [['true'], ['false']]
    case 'validate':
      return [['valid'], ['invalid']]
    case 'wait-callback':
      // A callback gate told to fail on timeout has one *routed* outcome; the
      // other is a run failure, which every check here excludes by contract.
      return config.onTimeout === 'fail'
        ? [['received']]
        : [['received'], ['timed-out']]
    case 'switch': {
      const cases = Array.isArray(config.cases) ? config.cases : []
      const labels = cases
        .map((c) => (typeof c?.label === 'string' ? c.label.trim() : ''))
        .filter(Boolean)
      return [...new Set(labels)].map((l) => [l]).concat([['default']])
    }
    default:
      // Per-node error handling is the same shape wearing different clothes: a
      // node whose policy is `branch` either succeeds (every ordinary edge
      // activates) or is caught (only the error edge does). That is a two-way
      // decision, and a caught failure still leaves a run that can complete —
      // so it belongs here rather than being waved away as "a failure".
      if (config.onError === 'branch' && !node.type.startsWith('trigger-') && !UNCATCHABLE.has(node.type)) {
        return [['error'], [null]] // null = "every handle that isn't `error`"
      }
      return [[null]]
  }
}

// Does an edge leaving `node` belong to outcome group `group`?
// `null` in a group means "any handle the node's other groups don't claim",
// which is how the error-branch split names the ordinary edges without having
// to enumerate them.
function edgeInGroup(edge, group, allNamed) {
  if (group.includes(null)) return !allNamed.has(edge.sourceHandle)
  return group.includes(edge.sourceHandle)
}

// — the execution graph ——————————————————————————————————————————————————
//
// Exactly the graph the engine will run: sticky notes and compensating nodes
// stripped (the engine drops both before building its adjacency), dangling
// edges dropped, plus two virtual nodes.
//
// ENTRY feeds every source node, because the engine starts *all* of them — a
// graph with two triggers runs both, so both are unconditional and dominance
// has to be measured from a single root that reflects that.
//
// EXIT is where a run's flow ends, and it is fed from more places than the
// sinks. A decision whose outcome has no edge wired to it ends the flow right
// there — the run completes, having simply stopped. Post-dominance computed
// without those edges would claim "every run that charges a card also writes
// the audit log" about a graph where the false branch dangles, which is the
// exact class of false assurance this module exists to refuse.
function executionGraph({ nodes: rawNodes = [], edges: rawEdges = [] } = {}) {
  const noteIds = new Set(rawNodes.filter((n) => n.type === 'note').map((n) => n.id))
  const noteless = rawNodes.filter((n) => !noteIds.has(n.id))
  const plan = compensationPlan(noteless)
  const nodes = noteless.filter((n) => !plan.compensationIds.has(n.id))
  const ids = new Set(nodes.map((n) => n.id))
  const edges = rawEdges.filter((e) => ids.has(e.source) && ids.has(e.target))

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const succ = new Map([[ENTRY, []], [EXIT, []]])
  const pred = new Map([[ENTRY, []], [EXIT, []]])
  for (const n of nodes) {
    succ.set(n.id, [])
    pred.set(n.id, [])
  }
  const link = (a, b) => {
    succ.get(a).push(b)
    pred.get(b).push(a)
  }

  const outgoing = new Map(nodes.map((n) => [n.id, []]))
  const incoming = new Map(nodes.map((n) => [n.id, []]))
  for (const e of edges) {
    outgoing.get(e.source).push(e)
    incoming.get(e.target).push(e)
    link(e.source, e.target)
  }

  for (const n of nodes) {
    if (incoming.get(n.id).length === 0) link(ENTRY, n.id)
  }

  // Decisions, and the outcomes that lead nowhere.
  const decisions = new Map() // id -> [{ name, targets: Set }]
  for (const n of nodes) {
    const groups = outcomeGroups(n)
    const named = new Set(groups.flat().filter((h) => h !== null))
    const out = outgoing.get(n.id)
    const described = groups.map((group) => ({
      name: group.includes(null) ? 'ok' : group.join('/'),
      handles: group,
      edges: out.filter((e) => edgeInGroup(e, group, named)),
    }))
    if (groups.length > 1) decisions.set(n.id, described)
    // Any outcome with nothing wired to it terminates the run there — for a
    // decision *and* for a node that simply has no successors.
    const dangling = described.some((g) => g.edges.length === 0)
    if (dangling || out.length === 0) link(n.id, EXIT)
  }

  return { nodes, byId, edges, succ, pred, decisions, outgoing, incoming, ids }
}

// A cyclic graph never runs at all (the engine refuses it before any node
// executes), so every invariant over it is vacuous. Say so rather than
// reporting a tree computed over something that cannot happen.
function hasCycle(graph) {
  const state = new Map() // 0 = visiting, 1 = done
  for (const n of graph.nodes) {
    if (state.has(n.id)) continue
    const stack = [[n.id, 0]]
    state.set(n.id, 0)
    while (stack.length) {
      const frame = stack[stack.length - 1]
      const kids = (graph.succ.get(frame[0]) || []).filter((k) => k !== EXIT)
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

// — the analysis ————————————————————————————————————————————————————————

function analyzeGraph(rawGraph) {
  const graph = executionGraph(rawGraph)
  if (graph.nodes.length === 0) return { ok: false, reason: 'empty', graph }
  if (hasCycle(graph)) return { ok: false, reason: 'cycle', graph }

  const idom = immediateDominators({ entry: ENTRY, succ: graph.succ, pred: graph.pred })
  const rev = reverse(graph)
  const ipdom = immediateDominators({ entry: EXIT, succ: rev.succ, pred: rev.pred })

  // Nodes every run executes. Two sound rules, unioned, because each catches a
  // shape the other misses: post-dominating the entry covers a diamond that
  // reconverges after a condition, and the fixpoint covers an unconditional
  // fan-out whose branches never rejoin (each leaf always runs, and neither is
  // on every path to the exit). Both under-approximate on purpose — this is a
  // fact reported to a human, and claiming a node always runs when it might not
  // is the only error that matters.
  const always = new Set()
  for (const n of graph.nodes) {
    if (dominates(ipdom, n.id, ENTRY)) always.add(n.id)
    if ((graph.incoming.get(n.id) || []).length === 0) always.add(n.id)
  }
  let grew = true
  while (grew) {
    grew = false
    for (const n of graph.nodes) {
      if (always.has(n.id)) continue
      const unconditional = (graph.incoming.get(n.id) || []).some(
        (e) => always.has(e.source) && !graph.decisions.has(e.source)
      )
      if (unconditional) {
        always.add(n.id)
        grew = true
      }
    }
  }

  // For each decision, which of its outcomes can lead to each node. Computed
  // once here because both the exclusivity check and its evidence need it.
  const viaOutcome = new Map() // decisionId -> Map(outcomeName -> Set(nodeId))
  for (const [id, groups] of graph.decisions) {
    const perOutcome = new Map()
    for (const group of groups) {
      const seen = new Set()
      const queue = group.edges.map((e) => e.target)
      while (queue.length) {
        const next = queue.shift()
        if (next === id || seen.has(next)) continue
        seen.add(next)
        for (const child of graph.succ.get(next) || []) {
          if (child !== EXIT) queue.push(child)
        }
      }
      perOutcome.set(group.name, seen)
    }
    viaOutcome.set(id, perOutcome)
  }

  return { ok: true, graph, idom, ipdom, always, viaOutcome }
}

// — the three checks ————————————————————————————————————————————————————

// "B never runs unless A ran first." Sound by construction: B executes only if
// an active chain of edges reached it, every such chain is a path from ENTRY,
// and dominance says every one of them contains A.
function checkRequires(analysis, a, b) {
  if (dominates(analysis.idom, a, b)) return { holds: true }
  // The counterexample is the finding. A path to B that never touches A is the
  // bug written out, and it is what the panel highlights on the canvas.
  const path = pathAvoiding(analysis.graph, ENTRY, b, new Set([a]))
  return { holds: false, path: path ? path.filter((id) => id !== ENTRY && id !== EXIT) : null }
}

// "If A runs, B runs too." Post-dominance over the graph whose exit edges
// include every unwired outcome, so a dangling branch is a counterexample
// rather than a silent pass.
//
// Conditional on the run not failing, and deliberately so: any node can fail,
// and a checker that reported "nothing is ever guaranteed to follow anything"
// would be correct, useless, and ignored. The caveat is documented rather than
// hidden — see GUARANTEES.md.
function checkEnsures(analysis, a, b) {
  if (dominates(analysis.ipdom, b, a)) return { holds: true }
  const path = pathAvoiding(reverse(analysis.graph), EXIT, a, new Set([b]))
  return {
    holds: false,
    path: path ? path.reverse().filter((id) => id !== ENTRY && id !== EXIT) : null,
  }
}

// "A and B never both run." True when some decision node separates them: it
// dominates both (so neither can be reached around it) and the outcomes that
// can lead to A are disjoint from those that can lead to B. Exactly one outcome
// activates per run, so no run reaches both.
function checkExclusive(analysis, a, b) {
  if (a === b) return { holds: false, reason: 'same-node' }
  for (const [id, perOutcome] of analysis.viaOutcome) {
    if (id === a || id === b) continue
    if (!dominates(analysis.idom, id, a) || !dominates(analysis.idom, id, b)) continue
    const forA = []
    const forB = []
    for (const [name, set] of perOutcome) {
      if (set.has(a)) forA.push(name)
      if (set.has(b)) forB.push(name)
    }
    if (forA.length === 0 || forB.length === 0) continue
    if (forA.some((name) => forB.includes(name))) continue
    return { holds: true, decision: id, outcomes: { a: forA, b: forB } }
  }
  // Not separated. The useful evidence is *where* they stop being separated —
  // the last decision they share an outcome under, or "nothing decides between
  // them" when no decision dominates both at all.
  let shared = null
  for (const [id, perOutcome] of analysis.viaOutcome) {
    if (!dominates(analysis.idom, id, a) || !dominates(analysis.idom, id, b)) continue
    for (const [name, set] of perOutcome) {
      if (set.has(a) && set.has(b)) shared = { decision: id, outcome: name }
    }
  }
  return { holds: false, shared }
}

// — declarations ————————————————————————————————————————————————————————

// A declaration is `{ kind, node, other, note? }` and reads left to right:
//
//   requires   <node> never runs unless <other> ran first
//   ensures    if <node> runs, <other> runs too
//   exclusive  <node> and <other> never both run
//
// Parsing is strict and total: anything malformed is dropped here rather than
// carried into the checker as a half-declaration that would quietly never fail.
function parseGuarantees(raw) {
  let list = raw
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const out = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const kind = String(item.kind || '')
    const node = typeof item.node === 'string' ? item.node.trim() : ''
    const other = typeof item.other === 'string' ? item.other.trim() : ''
    if (!KINDS.includes(kind) || !node || !other) continue
    // A guarantee about a node and itself is either a typo or a tautology, and
    // both are better refused than stored.
    if (node === other) continue
    const key = `${kind}:${node}:${other}`
    if (seen.has(key)) continue
    seen.add(key)
    const note = typeof item.note === 'string' ? item.note.slice(0, 200) : ''
    out.push(note ? { kind, node, other, note } : { kind, node, other })
  }
  return out.slice(0, 100)
}

function describe(guarantee, labels) {
  const a = labels(guarantee.node)
  const b = labels(guarantee.other)
  switch (guarantee.kind) {
    case 'requires':
      return `${a} never runs unless ${b} ran first`
    case 'ensures':
      return `if ${a} runs, ${b} runs too`
    default:
      return `${a} and ${b} never both run`
  }
}

// Verify every declaration against a graph. Returns one result per declaration,
// in declaration order, each carrying its own evidence.
function verifyGuarantees(rawGraph, declarations) {
  const list = parseGuarantees(declarations)
  const analysis = analyzeGraph(rawGraph)
  const graph = analysis.graph
  const labels = (id) => labelOf(graph.byId.get(id)) || id
  const base = list.map((g) => ({ ...g, statement: describe(g, labels) }))

  if (!analysis.ok) {
    // Nothing can be verified against a graph that cannot run. Reporting each
    // declaration as `unknown` rather than as holding is the whole point: a
    // guarantee whose check silently stopped running is worse than no
    // guarantee, because somebody is relying on it.
    const results = base.map((g) => ({
      ...g,
      status: 'unknown',
      message: reasonText(analysis.reason),
    }))
    return {
      ok: results.length === 0,
      analysed: false,
      reason: analysis.reason,
      results,
      facts: null,
      suggestions: [],
    }
  }

  const results = base.map((g) => {
    const missing = [g.node, g.other].filter((id) => !graph.ids.has(id))
    if (missing.length > 0) {
      return {
        ...g,
        status: 'unknown',
        message: `${missing.map((m) => `"${m}"`).join(' and ')} ${
          missing.length > 1 ? 'are' : 'is'
        } no longer in this workflow — the guarantee can't be checked`,
      }
    }
    if (g.kind === 'requires') {
      const check = checkRequires(analysis, g.other, g.node)
      if (check.holds) return { ...g, status: 'holds' }
      return {
        ...g,
        status: 'violated',
        counterexample: check.path,
        message: check.path
          ? `${check.path.map(labels).join(' → ')} reaches ${labels(g.node)} without ${labels(g.other)}`
          : `nothing reaches ${labels(g.node)} at all`,
      }
    }
    if (g.kind === 'ensures') {
      const check = checkEnsures(analysis, g.node, g.other)
      if (check.holds) return { ...g, status: 'holds' }
      return {
        ...g,
        status: 'violated',
        counterexample: check.path,
        message: check.path
          ? `${check.path.map(labels).join(' → ')} ends the run without reaching ${labels(g.other)}`
          : `${labels(g.node)} can finish without ${labels(g.other)} running`,
      }
    }
    const check = checkExclusive(analysis, g.node, g.other)
    if (check.holds) {
      return {
        ...g,
        status: 'holds',
        evidence: `${labels(check.decision)} decides between them`,
      }
    }
    return {
      ...g,
      status: 'violated',
      message: check.shared
        ? `both are downstream of ${labels(check.shared.decision)}'s "${check.shared.outcome}" outcome, so one run reaches both`
        : `no decision separates ${labels(g.node)} from ${labels(g.other)} — a single run can reach both`,
    }
  })

  return {
    // `ok` means what a CI gate needs it to mean — every declaration holds —
    // and `analysed` separately reports whether the graph could be reasoned
    // about at all. Two facts, because collapsing them would make a cyclic
    // graph with no declarations indistinguishable from a broken invariant.
    ok: results.every((r) => r.status === 'holds'),
    analysed: true,
    results,
    facts: {
      alwaysRuns: [...analysis.always].map((id) => ({ nodeId: id, label: labels(id) })),
      decisions: [...graph.decisions.keys()].map((id) => ({
        nodeId: id,
        label: labels(id),
        outcomes: graph.decisions.get(id).map((g) => g.name),
      })),
    },
    suggestions: suggest(analysis, labels),
  }
}

function reasonText(reason) {
  if (reason === 'cycle') return 'the graph contains a cycle, so no execution exists to verify against'
  return 'the graph has no nodes to verify'
}

// Invariants that hold today and are probably worth pinning. The bar is a gate
// node standing in front of something consequential — an approval before a
// charge, a validate before a sub-workflow call. That is the shape somebody
// built on purpose and would want to be told about if a later edit routed
// around it, which is exactly what a declared guarantee is for.
//
// Only the *nearest* gate is offered per node: every gate further up dominates
// it too, and a list of six true-but-redundant suggestions is a list nobody
// reads.
function suggest(analysis, labels) {
  const { graph, idom } = analysis
  const out = []
  for (const node of graph.nodes) {
    if (!CONSEQUENTIAL.has(node.type)) continue
    const chain = dominatorChain(idom, node.id).slice(1)
    const gate = chain.find((id) => {
      const n = graph.byId.get(id)
      return n && GATE.has(n.type)
    })
    if (!gate) continue
    out.push({
      kind: 'requires',
      node: node.id,
      other: gate,
      statement: `${labels(node.id)} never runs unless ${labels(gate)} ran first`,
    })
  }

  // Pairs a decision already keeps apart. Reported for consequential nodes only
  // and capped, because the number of mutually exclusive pairs in a branchy
  // graph is quadratic and almost all of them are uninteresting.
  const effects = graph.nodes.filter((n) => CONSEQUENTIAL.has(n.type))
  for (let i = 0; i < effects.length && out.length < 20; i++) {
    for (let j = i + 1; j < effects.length && out.length < 20; j++) {
      const check = checkExclusive(analysis, effects[i].id, effects[j].id)
      if (!check.holds) continue
      out.push({
        kind: 'exclusive',
        node: effects[i].id,
        other: effects[j].id,
        statement: `${labels(effects[i].id)} and ${labels(effects[j].id)} never both run`,
      })
    }
  }
  return out.slice(0, 20)
}

// Linter integration. A violated guarantee is an **error**: the author declared
// it, so it stopped being true because of an edit, which is the definition of a
// regression. A guarantee that can no longer be checked — a node it names was
// deleted — is an error for the sharper reason that it now passes silently.
function guaranteeIssues(rawGraph, declarations) {
  const list = parseGuarantees(declarations)
  if (list.length === 0) return []
  const report = verifyGuarantees(rawGraph, list)
  const issues = []
  for (const result of report.results) {
    if (result.status === 'holds') continue
    issues.push({
      severity: result.status === 'violated' ? 'error' : 'warning',
      code: result.status === 'violated' ? 'guarantee-violated' : 'guarantee-uncheckable',
      message: `Guarantee "${result.statement}" ${
        result.status === 'violated' ? 'no longer holds' : 'cannot be checked'
      } — ${result.message}`,
      nodeId: rawGraph?.nodes?.some((n) => n.id === result.node) ? result.node : null,
    })
  }
  return issues
}

module.exports = {
  KINDS,
  executionGraph,
  analyzeGraph,
  outcomeGroups,
  checkRequires,
  checkEnsures,
  checkExclusive,
  parseGuarantees,
  describe,
  verifyGuarantees,
  guaranteeIssues,
}
