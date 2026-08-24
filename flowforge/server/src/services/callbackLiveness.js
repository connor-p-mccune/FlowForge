// Can this callback wait ever be satisfied?
//
// A `wait-callback` node parks the run until an external system POSTs to a
// one-time URL. The engine mints that URL at run start and exposes it as
// `{{callbacks.<node-id>}}`, so some node has to put it in a request, an email
// or a message — and, as the runner's own comment says, an **upstream** node.
// Nothing checked the "upstream".
//
// Three ways a wait can be unsatisfiable, and all three look identical at run
// time:
//
//   1. **Nothing sends it.** No node's config mentions `{{callbacks.W}}` at
//      all. The token is minted per run, so if this graph does not transmit it,
//      nothing on earth can call it.
//   2. **Only something downstream sends it.** The node that would send the URL
//      sits after the wait, so it cannot run until the wait finishes, and the
//      wait cannot finish until it runs. A wait-for cycle, in a DAG that has no
//      cycles.
//   3. **It is only logged.** `{{callbacks.W}}` in an `output-log` writes the
//      URL to stdout. Nobody outside the process can read stdout.
//
// The wait does eventually time out — an hour by default, up to a week — so
// this is not a hang. It is worse than a hang in one specific way: **the graph
// is indistinguishable at run time from a partner system that never replied.**
// The investigation starts at the partner, and the answer was in the canvas.
//
// ---
//
// **Sending is a dataflow question, not a string search.** Looking only for
// nodes whose own config contains `{{callbacks.W}}` reports a false alarm on
// the commonest real shape: a transform builds the request body, and the HTTP
// node references `{{build.body}}`. The URL is sent; no HTTP node mentions it.
//
// So the URL is followed forward: a node *carries* the callback if its config
// mentions it directly, or if it references a node that carries it. The
// question is then whether anything that reaches **outside FlowForge** carries
// it — which is the same set of node types the
// [effect report](./effects.js) is built on, reused rather than re-listed.
//
// Pure: a graph in, findings out.

const { executionGraph } = require('./guarantees')
const { ENTRY, EXIT, immediateDominators, dominates } = require('./dominance')
const { EFFECT_KINDS } = require('./effects')

// `{{callbacks.<node-id>}}` — the engine substitutes the run's minted URL.
const CALLBACK_REF = /\{\{\s*callbacks\.([\w-]+)\s*\}\}/g
// Any `{{node.path}}`, for following the URL through a node that repackages it.
const NODE_REF = /\{\{\s*([\w-]+)(?:\.[\w-]+)*\s*\}\}/g

const RESERVED = new Set(['secrets', 'vars', 'callbacks', 'rollback'])

const labelOf = (node) => node?.data?.label || node?.id || ''

// Every string in a node's config, however nested.
function strings(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out))
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => strings(v, out))
  return out
}

// Which nodes mention `{{callbacks.<waitId>}}` directly, and which nodes each
// one reads from. One pass over every config, because the analysis needs both.
function scan(nodes) {
  const mentions = new Map() // waitId -> Set(nodeId)
  const reads = new Map() // nodeId -> Set(nodeId it references)

  for (const node of nodes) {
    const found = new Set()
    for (const text of strings(node.data?.config)) {
      for (const match of text.matchAll(CALLBACK_REF)) {
        const waitId = match[1]
        if (!mentions.has(waitId)) mentions.set(waitId, new Set())
        mentions.get(waitId).add(node.id)
      }
      for (const match of text.matchAll(NODE_REF)) {
        const head = match[1]
        if (!RESERVED.has(head) && head !== node.id) found.add(head)
      }
    }
    reads.set(node.id, found)
  }
  return { mentions, reads }
}

// Forward closure: every node that carries the callback URL, starting from the
// ones that name it and following each reference that repackages it.
//
// Over-approximates on purpose. A node that references a carrier is treated as
// carrying it even if it only reads one unrelated field off it, because the
// alternative — tracking which *field* of a transform's output holds the URL —
// would need a full value-level taint analysis, and being wrong in that
// direction reports a live wait as dead. Fewer findings, never invented ones.
function carriers(seeds, reads) {
  const carried = new Set(seeds)
  let changed = true
  while (changed) {
    changed = false
    for (const [nodeId, referenced] of reads) {
      if (carried.has(nodeId)) continue
      for (const source of referenced) {
        if (carried.has(source)) {
          carried.add(nodeId)
          changed = true
          break
        }
      }
    }
  }
  return carried
}

function reachSet(graph, starts) {
  const seen = new Set()
  const queue = [...starts]
  while (queue.length) {
    const current = queue.shift()
    if (current == null || current === EXIT || current === ENTRY || seen.has(current)) continue
    seen.add(current)
    for (const next of graph.succ.get(current) || []) queue.push(next)
  }
  return seen
}

// Does the sender run whenever the wait does?
//
// **Not** a dominance test, and that distinction is the whole of this function.
// Dominance asks whether every *path* to the wait goes through the sender,
// which is the right question for a sequential engine and the wrong one here:
// this engine runs independent branches in parallel, so `t1 → send` beside
// `t1 → wait` executes both. Dominance would call that a maybe and send
// somebody to fix a graph that is correct.
//
// What actually decides it is whether some **decision** can route away from the
// sender while still reaching the wait. So for every decision that governs the
// sender — one that dominates it, and therefore decides whether it runs at all
// — the sender is only guaranteed when no outcome that skips it still arrives
// at the wait, and when the wait cannot be reached without passing that
// decision at all.
function alwaysRunsWhen(senderId, waitId, decisionReach, idom) {
  for (const [decisionId, groups] of decisionReach) {
    if (decisionId === senderId) continue
    if (!dominates(idom, decisionId, senderId)) continue
    const skips = groups.filter((g) => !g.reach.has(senderId))
    if (skips.some((g) => g.reach.has(waitId))) return false
    // The wait is also reachable by a route that never consults this decision,
    // so there is a run in which it waits and the sender never ran.
    if (!dominates(idom, decisionId, waitId)) return false
  }
  return true
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

// → [{ severity, code, message, nodeId }], the linter's finding shape.
function callbackIssues(rawGraph) {
  const graph = executionGraph(rawGraph)
  const waits = graph.nodes.filter((n) => n.type === 'wait-callback')
  if (waits.length === 0) return []
  // A cyclic graph never runs, so nothing about it waits.
  if (hasCycle(graph)) return []

  const { mentions, reads } = scan(graph.nodes)
  const idom = immediateDominators({ entry: ENTRY, succ: graph.succ, pred: graph.pred })

  // What each decision's outcomes lead to, computed once — the same outcome
  // partition the effect report and the convergence analysis are built on, so a
  // condition, a switch, a validate gate, an approval and a per-node error
  // branch are all handled here without this file knowing what any of them are.
  const decisionReach = new Map()
  for (const [id, groups] of graph.decisions) {
    decisionReach.set(
      id,
      groups.map((group) => ({
        name: group.name,
        reach: reachSet(graph, group.edges.map((e) => e.target)),
      }))
    )
  }

  const issues = []

  for (const wait of waits) {
    const named = mentions.get(wait.id)
    const label = labelOf(wait)

    if (!named || named.size === 0) {
      issues.push({
        severity: 'error',
        code: 'callback-never-sent',
        message:
          `${label}: nothing in this workflow sends {{callbacks.${wait.id}}}, so the ` +
          'callback URL never leaves FlowForge and this wait can only time out.',
        nodeId: wait.id,
      })
      continue
    }

    // Everything the URL flows into, then the subset that actually leaves.
    const carried = carriers(named, reads)
    const senders = [...carried].filter((id) => {
      if (id === wait.id) return false
      return Boolean(EFFECT_KINDS[graph.byId.get(id)?.type])
    })

    if (senders.length === 0) {
      const holders = [...carried]
        .filter((id) => id !== wait.id)
        .map((id) => labelOf(graph.byId.get(id)))
        .filter(Boolean)
      issues.push({
        severity: 'error',
        code: 'callback-never-sent',
        message:
          `${label}: {{callbacks.${wait.id}}} reaches ${holders.join(', ') || 'no node'}, ` +
          'but nothing that sends it anywhere — a logged callback URL is not a delivered ' +
          'one, so this wait can only time out.',
        nodeId: wait.id,
      })
      continue
    }

    // Rule (2): a sender that cannot run until the wait finishes.
    const downstream = reachSet(graph, (graph.outgoing.get(wait.id) || []).map((e) => e.target))
    const usable = senders.filter((id) => !downstream.has(id))

    if (usable.length === 0) {
      const names = senders.map((id) => labelOf(graph.byId.get(id))).join(', ')
      issues.push({
        severity: 'error',
        code: 'callback-deadlock',
        message:
          `${label}: the only node that sends {{callbacks.${wait.id}}} is ${names}, which ` +
          'runs after this wait — so the wait cannot finish until it runs, and it cannot ' +
          'run until the wait finishes. Move it upstream.',
        nodeId: wait.id,
      })
      continue
    }

    // Rule (3): a sender that only runs on some paths. The wait is live when
    // that path was taken and dead otherwise, which is the hardest version of
    // this to diagnose from a run.
    if (!usable.some((id) => alwaysRunsWhen(id, wait.id, decisionReach, idom))) {
      const names = usable.map((id) => labelOf(graph.byId.get(id))).join(', ')
      issues.push({
        severity: 'warning',
        code: 'callback-may-not-be-sent',
        message:
          `${label}: {{callbacks.${wait.id}}} is sent by ${names}, which does not run on ` +
          'every path that reaches this wait — on the others the URL never goes out and ' +
          'the run waits for the full timeout.',
        nodeId: wait.id,
      })
    }
  }

  return issues
}

module.exports = { callbackIssues, carriers, scan }
