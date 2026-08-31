// Are this workflow's checks any good?
//
// FlowForge has a lot of ways to check a workflow. Test scenarios run it
// against a payload and assert on the result. Guarantees prove path invariants.
// The linter and type checker refuse a graph that cannot work. Every one of
// them answers *"does this workflow pass?"*
//
// None of them answers the question underneath:
//
// > **If this workflow were subtly wrong, would any of them notice?**
//
// A suite of three scenarios that all assert `status == "completed"` passes on
// a workflow with the approval gate deleted. A guarantee nobody declared cannot
// break. Green is not the same as covered, and nothing in the product could
// tell the two apart.
//
// So: **mutation testing**. Introduce a plausible bug, re-run every check, and
// see whether anything goes red. A mutant nothing catches is a gap in the
// checks, named precisely — not "coverage is 61%" but *"the approval gate can
// be deleted and every one of your tests still passes."*
//
// ---
//
// ## The operators are bugs, not noise
//
// Random perturbation produces mutants nobody would ever write, and a report
// full of those is one people stop reading. Each operator below is a mistake
// somebody has actually made:
//
//   * **swap-branches** — a condition wired backwards. The commonest
//     copy-paste error on a canvas, and invisible: both edges exist, both
//     lint, the graph looks right.
//   * **off-by-one** — `> 100` becomes `> 101`. The threshold bug that
//     survives every test whose payloads are nowhere near the boundary.
//   * **remove-gate** — an approval or a validate deleted and the graph
//     rewired past it. Exactly what [guarantees](./guarantees.js) exist to
//     catch, which makes it the operator that tells somebody whether declaring
//     one was worth it.
//   * **skip-node** — a step removed. Tests whether anything asserts on what it
//     produced, or whether it is decoration.
//
// ## Three ways to die, and the order they are tried in
//
// A mutant is killed by whichever check notices first, and the checks are run
// cheapest-first — which is also best-first:
//
//   1. **The linter or type checker** refuses it. Caught before a run: the
//      strongest outcome, and free.
//   2. **A declared guarantee** breaks. Caught statically over every execution
//      the graph admits, not just the ones somebody wrote a payload for.
//   3. **A test scenario** fails. Caught empirically, on the inputs that
//      happen to be declared.
//
// Anything still standing **survived**, and that is the report.
//
// ## Nothing is written
//
// Mutants exist in memory. They are executed through `graphOverride` in dry-run
// mode — the engine's own facility for running a graph the workflow does not
// hold — so no side-effecting node fires and the saved definition is never
// touched. The dry-run rows are deleted once their assertions have been read.
//
// ## The honest limit
//
// **An equivalent mutant cannot be killed by anything**, because it does not
// change behaviour — removing a node whose output nothing reads, or shifting a
// threshold no input is near. Detecting them is undecidable in general, so a
// survivor is *evidence* of a gap rather than proof of one, and the report says
// which mutation it was so somebody can judge in a second whether it matters.

const { tokenize } = require('./expression/lexer')

// Bounded, because every mutant costs a run of the whole scenario suite and a
// report nobody waits for is a report nobody uses.
const MAX_MUTANTS = 16

const labelOf = (node) => node?.data?.label || node?.id || ''

const cloneGraph = (graph) => ({
  nodes: graph.nodes.map((n) => JSON.parse(JSON.stringify(n))),
  edges: graph.edges.map((e) => ({ ...e })),
})

// The node types whose failure a *person* is expected to gate on, and which a
// graph is therefore meaningfully wrong without.
const GATES = new Set(['approval', 'validate'])
// Types whose removal would change the graph's shape rather than its steps.
const STRUCTURAL = new Set(['condition', 'switch', 'approval', 'validate', 'wait-callback', 'for-each'])

// — swap-branches ——————————————————————————————————————————————————————

// A condition wired backwards: the true edges become false and vice versa.
//
// Only for a node with both handles wired, because swapping when one side is
// unwired produces a graph where the branch leads nowhere — which the linter
// refuses, so every such mutant would be "killed" by a check that noticed the
// mutation rather than the bug.
function swapBranches(graph) {
  const out = []
  for (const node of graph.nodes) {
    if (node.type !== 'condition') continue
    const edges = graph.edges.filter((e) => e.source === node.id)
    const yes = edges.filter((e) => e.sourceHandle === 'true')
    const no = edges.filter((e) => e.sourceHandle === 'false')
    if (yes.length === 0 || no.length === 0) continue

    const mutant = cloneGraph(graph)
    for (const edge of mutant.edges) {
      if (edge.source !== node.id) continue
      if (edge.sourceHandle === 'true') edge.sourceHandle = 'false'
      else if (edge.sourceHandle === 'false') edge.sourceHandle = 'true'
    }
    out.push({
      operator: 'swap-branches',
      nodeId: node.id,
      describe: `"${labelOf(node)}" wired backwards — its true and false branches swapped`,
      graph: mutant,
    })
  }
  return out
}

// — off-by-one ————————————————————————————————————————————————————————

// A threshold shifted by one.
//
// Spliced at the token's source position rather than by regex, so `> 100` in
// `total > 100` moves and the `100` inside `"order-100"` does not. Only when the
// expression contains exactly one number: with two, which one somebody meant is
// a guess, and a mutant nobody recognises is noise.
function offByOne(graph) {
  const out = []
  for (const node of graph.nodes) {
    const source = node.data?.config?.expression
    if (typeof source !== 'string' || source.trim() === '') continue

    let numbers
    try {
      numbers = tokenize(source).filter((t) => t.type === 'number' && Number.isFinite(t.value))
    } catch {
      // An expression that does not lex is the linter's finding, not ours.
      continue
    }
    if (numbers.length !== 1) continue

    const token = numbers[0]
    const text = String(token.value)
    const at = source.indexOf(text, Math.max(0, token.position - 1))
    if (at === -1) continue

    const mutated = `${source.slice(0, at)}${token.value + 1}${source.slice(at + text.length)}`
    const mutant = cloneGraph(graph)
    const target = mutant.nodes.find((n) => n.id === node.id)
    target.data.config.expression = mutated
    out.push({
      operator: 'off-by-one',
      nodeId: node.id,
      describe: `"${labelOf(node)}" off by one — ${text} became ${token.value + 1}`,
      graph: mutant,
    })
  }
  return out
}

// — removal ———————————————————————————————————————————————————————————

// Take a node out and join what was either side of it.
//
// Only the node's *pass* edges are rewired: an approval's rejection branch
// leads somewhere by design, and reconnecting it to the happy path would model
// a different bug from the one meant here.
function removeNode(graph, node, passHandles) {
  const mutant = cloneGraph(graph)
  const incoming = mutant.edges.filter((e) => e.target === node.id)
  const outgoing = mutant.edges.filter(
    (e) => e.source === node.id && (!passHandles || passHandles.includes(e.sourceHandle ?? null))
  )
  if (incoming.length === 0 || outgoing.length === 0) return null

  const kept = mutant.edges.filter((e) => e.source !== node.id && e.target !== node.id)
  for (const before of incoming) {
    for (const after of outgoing) {
      kept.push({
        id: `${before.source}-${after.target}-mut`,
        source: before.source,
        target: after.target,
        sourceHandle: before.sourceHandle ?? null,
      })
    }
  }
  mutant.nodes = mutant.nodes.filter((n) => n.id !== node.id)
  mutant.edges = kept
  return mutant
}

// An approval or a validate deleted, and the graph rewired past it. The
// operator that tells somebody whether declaring a guarantee was worth it.
function removeGate(graph) {
  const out = []
  for (const node of graph.nodes) {
    if (!GATES.has(node.type)) continue
    const mutant = removeNode(graph, node, ['true', 'valid', null])
    if (!mutant) continue
    out.push({
      operator: 'remove-gate',
      nodeId: node.id,
      describe: `"${labelOf(node)}" removed — the graph runs straight past the gate`,
      graph: mutant,
    })
  }
  return out
}

// An ordinary step removed. Tests whether anything asserts on what it produced,
// or whether it is decoration.
function skipNode(graph) {
  const out = []
  for (const node of graph.nodes) {
    if (node.type.startsWith('trigger-')) continue
    if (STRUCTURAL.has(node.type) || node.type === 'note') continue
    // One in, one out: anything else is a join or a fan-out, and rewiring it
    // models a structural change rather than a missing step.
    const incoming = graph.edges.filter((e) => e.target === node.id)
    const outgoing = graph.edges.filter((e) => e.source === node.id)
    if (incoming.length !== 1 || outgoing.length !== 1) continue

    const mutant = removeNode(graph, node, null)
    if (!mutant) continue
    out.push({
      operator: 'skip-node',
      nodeId: node.id,
      describe: `"${labelOf(node)}" removed — the step never runs`,
      graph: mutant,
    })
  }
  return out
}

// Every mutant of a graph, in a fixed order.
//
// Interleaved by operator rather than grouped, so a cap that truncates the list
// still leaves a spread — twelve off-by-ones and no removed gate would be a
// worse report than three of each.
function mutants(graph, { limit = MAX_MUTANTS } = {}) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return []
  const groups = [swapBranches(graph), offByOne(graph), removeGate(graph), skipNode(graph)]

  const out = []
  for (let round = 0; out.length < limit; round += 1) {
    let added = false
    for (const group of groups) {
      if (round >= group.length || out.length >= limit) continue
      out.push({ ...group[round], id: `m${out.length + 1}` })
      added = true
    }
    if (!added) break
  }
  return out
}

module.exports = { mutants, swapBranches, offByOne, removeGate, skipNode, MAX_MUTANTS }
