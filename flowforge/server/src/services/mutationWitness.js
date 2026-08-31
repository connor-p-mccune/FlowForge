// The input that would have caught it.
//
// A mutation report names a bug nothing noticed. That is the diagnosis, and a
// diagnosis is where most coverage tools stop: *"the threshold can be off by
// one and every test still passes."* True, and the next thing somebody says is
// **"so what do I write?"**
//
// This answers that, and it needs no new machinery at all —
// [path feasibility](./pathConstraints.js) already turns a branch into the
// payload that drives it, backed by a real solver. The only new idea is what to
// ask it:
//
// > Find an input on which the original and the mutant **disagree**.
//
// Such an input is exactly a test the current suite is missing, because a
// scenario running it and asserting on the outcome could not pass on both
// graphs.
//
// ---
//
// ## Per operator, what "disagree" means
//
//   * **off-by-one** — the interesting one, and the only one that needs a
//     solver call of its own. `total > 100` became `total > 101`, so the
//     distinguishing inputs are exactly those satisfying `total > 100 and not
//     (total > 101)` — that is, `total == 101`. A witness for the *original*
//     branch is no good: the solver is as likely to return `total = 5000`,
//     which both graphs agree about, and a generated test that passes on the
//     bug is worse than none.
//
//     So a **probe graph** is built — the original with that one condition
//     replaced by the conjunction — and the solver asked for an input taking
//     its true branch. If that is unsatisfiable the shift went the other way,
//     and the reversed conjunction is tried.
//
//   * **swap-branches** — the two graphs disagree on *every* input that reaches
//     the condition, so any witness for either of its outcomes will do. No
//     probe needed.
//
//   * **remove-gate**, **skip-node** — they disagree on every input that
//     reaches the removed node, which is what the per-node witness is.
//
// ## What it does not promise
//
// A witness proves the graphs **differ** on that input. It does not prove a
// scenario written around it would be a good test — the assertion still has to
// be about something the difference reaches. And where the solver cannot find
// one (a truncated search, a condition over a value it cannot model, an
// equivalent mutant that genuinely has no distinguishing input) the answer is
// `null` and the report says nothing rather than inventing a payload.

const { analyzePaths } = require('./pathConstraints')

// The solver is not free, and a workflow with many survivors would otherwise
// pay for a full path analysis per survivor.
const MAX_WITNESSES = 8

const cloneGraph = (graph) => ({
  nodes: graph.nodes.map((n) => JSON.parse(JSON.stringify(n))),
  edges: graph.edges.map((e) => ({ ...e })),
})

// The original graph with one condition rewritten, so the solver can be asked a
// question about a formula the graph does not contain.
function probe(graph, nodeId, expression) {
  const out = cloneGraph(graph)
  const target = out.nodes.find((n) => n.id === nodeId)
  if (!target) return null
  target.data = target.data || {}
  // `operator` is preserved: a condition is only read as an expression when it
  // says so, and a probe that dropped it would be asking the solver about a
  // node it no longer recognises as a decision.
  target.data.config = { ...(target.data.config || {}), expression }
  return out
}

const trueBranchWitness = (report, nodeId) =>
  report.analysed
    ? report.branches.find((b) => b.nodeId === nodeId && b.outcome === 'true' && b.witness)?.witness
    : null

// An input satisfying one condition and not the other.
//
// Both directions are tried because which one is satisfiable depends on which
// way the threshold moved: `> 100` → `> 101` is distinguished by the original
// holding and the mutant not, and `< 100` → `< 101` by the reverse.
function differingInput(graph, nodeId, original, mutated) {
  for (const expression of [
    `(${original}) and not (${mutated})`,
    `(${mutated}) and not (${original})`,
  ]) {
    const probed = probe(graph, nodeId, expression)
    if (!probed) return null
    let report
    try {
      report = analyzePaths(probed)
    } catch {
      return null
    }
    const witness = trueBranchWitness(report, nodeId)
    if (witness) return witness
  }
  return null
}

// A witness for a single surviving mutant, or null.
//
// `paths` is the path analysis of the *original* graph, computed once by the
// caller — three of the four operators need nothing more than a lookup in it,
// and only `off-by-one` pays for a solver call.
function witnessFor(graph, mutant, paths) {
  switch (mutant.operator) {
    case 'off-by-one': {
      const original = graph.nodes.find((n) => n.id === mutant.nodeId)?.data?.config?.expression
      const mutated = mutant.graph.nodes.find((n) => n.id === mutant.nodeId)?.data?.config
        ?.expression
      if (!original || !mutated) return null
      return differingInput(graph, mutant.nodeId, original, mutated)
    }

    case 'swap-branches': {
      // Every input reaching the condition distinguishes them, so either
      // outcome's witness works. The true branch is preferred only because it
      // is the one people write the scenario for.
      if (!paths.analysed) return null
      const branch =
        paths.branches.find((b) => b.nodeId === mutant.nodeId && b.outcome === 'true' && b.witness) ||
        paths.branches.find((b) => b.nodeId === mutant.nodeId && b.witness)
      return branch?.witness ?? null
    }

    case 'remove-gate':
    case 'skip-node': {
      if (!paths.analysed) return null
      return paths.nodes.find((n) => n.nodeId === mutant.nodeId)?.witness ?? null
    }

    default:
      return null
  }
}

// What a scenario built around this witness should assert.
//
// A payload alone is half an answer: running it proves nothing unless the
// assertion is about the thing the two graphs disagree on. For a decision that
// is the branch it took; for a removed step it is that the step produced
// something.
function suggestionFor(mutant) {
  switch (mutant.operator) {
    case 'off-by-one':
    case 'swap-branches':
      return `assert on which branch "${mutant.nodeId}" takes with this input — a scenario that only checks the run completed passes on both graphs`
    case 'remove-gate':
      return `assert that the run did not reach past "${mutant.nodeId}" without it — the gate is what the mutation removes`
    case 'skip-node':
      return `assert on what "${mutant.nodeId}" produced — nothing currently reads its output`
    default:
      return null
  }
}

// Attach a witness to each survivor, in order, up to the cap.
//
// Survivors only: a mutant something already caught needs no test written for
// it, and paying a solver call to describe one would be work spent on the part
// of the report nobody has to act on.
function witnessSurvivors(graph, mutantResults, byId, { limit = MAX_WITNESSES } = {}) {
  let paths
  try {
    paths = analyzePaths(graph)
  } catch {
    paths = { analysed: false, branches: [], nodes: [] }
  }

  let spent = 0
  return mutantResults.map((result) => {
    if (result.killed || spent >= limit) return result
    const mutant = byId.get(result.id)
    if (!mutant) return result
    spent += 1
    const witness = witnessFor(graph, mutant, paths)
    if (!witness) return result
    return {
      ...result,
      witness: { triggerData: witness.triggerData, assumptions: witness.assumptions },
      suggestion: suggestionFor(mutant),
    }
  })
}

module.exports = { witnessSurvivors, witnessFor, differingInput, suggestionFor, MAX_WITNESSES }
