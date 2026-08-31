// Running the mutants: which of this workflow's checks notice a bug, and which
// bugs nothing notices.
//
// `mutation.js` produces the bugs; this decides whether anything catches them.
// A mutant is killed by whichever check notices first, and the checks are tried
// **cheapest-first** — which happens to be best-first too:
//
//   1. **The linter** refuses it. Caught before a run, for free, and by
//      something the author never had to write.
//   2. **A declared guarantee** breaks. Caught statically over every execution
//      the graph admits rather than the handful somebody wrote payloads for.
//   3. **A test scenario** fails. Caught empirically, on the inputs that are
//      declared.
//
// Anything still standing survived, and that is the report.
//
// The ordering also means the expensive step runs least often: a mutant killed
// by the linter costs a few milliseconds, and one that survives costs a full
// pass of the scenario suite. Which is the right way round — the graphs worth
// spending time on are the ones nothing else could rule out.
//
// **Nothing is written.** Mutants execute through the engine's `graphOverride`
// in dry-run mode, so no side-effecting node fires and the saved definition is
// untouched. The dry-run rows are deleted once their assertions have been read;
// a mutation analysis should leave no trace in a workflow's history.

const db = require('../config/database')
const { mutants, MAX_MUTANTS } = require('./mutation')
const { lintGraph } = require('./workflowLinter')
const { guaranteeIssues } = require('./guarantees')
const { runScenario } = require('./workflowTester')

// A mutation analysis is a foreground operation somebody is waiting for, so the
// scenario suite it runs per mutant is bounded too. Sixteen mutants against ten
// scenarios is already a hundred and sixty dry runs.
const MAX_SCENARIOS = 10

function parseGraph(json) {
  try {
    const parsed = JSON.parse(json)
    return {
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      edges: Array.isArray(parsed.edges) ? parsed.edges : [],
    }
  } catch {
    return null
  }
}

const parseDeclared = (json) => {
  try {
    const parsed = JSON.parse(json || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

// Every finding a check makes about a graph, as comparable signatures.
//
// Comparable, because a mutant is only killed by something the **mutation**
// introduced. A workflow that already fails to lint would otherwise hand every
// one of its mutants an inherited error and score a perfect 100 — a graph too
// broken to run reported as perfectly covered, which is the exact inversion of
// what this is for.
const key = (issue) => `${issue.code}|${issue.nodeId}|${issue.message}`

const signatures = (issues, counts) =>
  new Set(issues.filter(counts).map(key))

const firstNew = (issues, baseline, counts) => {
  for (const issue of issues) {
    if (!counts(issue)) continue
    if (!baseline.has(key(issue))) return issue.message
  }
  return null
}

// What counts as a kill differs between the two static checks, and the
// asymmetry is deliberate.
//
// For the **linter**, errors only. A warning means "legal but probably not what
// you meant", which is a description of every mutant — counting them would let
// each mutation kill itself.
//
// For a **guarantee**, an uncheckable one counts too. It is only a warning
// because a graph may legitimately be mid-edit, but a declaration reporting
// that the node it was about has vanished is precisely the bug the
// `remove-gate` operator introduces. `flowforge verify` already exits non-zero
// on it for the same reason.
const LINT_KILL = (issue) => issue.severity === 'error'
const GUARANTEE_KILL = (issue) =>
  issue.severity === 'error' || issue.code === 'guarantee-uncheckable'

// Does the linter refuse this graph for a reason the original did not already
// have?
//
// Errors only. A warning means "legal but probably not what you meant", which
// is precisely what a mutant is — counting warnings would let every mutation
// kill itself.
function refusedByLint(graph, baseline) {
  try {
    return firstNew(lintGraph(graph), baseline, LINT_KILL)
  } catch {
    return null
  }
}

function breaksGuarantee(graph, declared, baseline) {
  if (declared.length === 0) return null
  try {
    return firstNew(guaranteeIssues(graph, declared), baseline, GUARANTEE_KILL)
  } catch {
    return null
  }
}

// Run the suite against a mutant until something fails.
//
// Stops at the first failure, because the report only needs to know *that* the
// mutant was killed and by which scenario — and stopping is the difference
// between a hundred and sixty dry runs and forty.
async function killedByTests(workflow, scenarios, graph) {
  const created = []
  try {
    for (const scenario of scenarios) {
      const result = await runScenario(workflow, scenario, { graphOverride: graph })
      created.push(result.executionId)
      if (!result.passed) return { scenario: scenario.name, executionIds: created }
    }
    return null
  } finally {
    // A mutation analysis should leave no trace in a workflow's history.
    if (created.length > 0) {
      const list = created.map(() => '?').join(',')
      db.prepare(`DELETE FROM execution_steps WHERE execution_id IN (${list})`).run(...created)
      db.prepare(`DELETE FROM executions WHERE id IN (${list})`).run(...created)
    }
  }
}

async function analyzeMutations(workflow, { limit = MAX_MUTANTS } = {}) {
  const graph = parseGraph(workflow.graph_json)
  if (!graph || graph.nodes.length === 0) return { available: false, reason: 'empty' }

  const candidates = mutants(graph, { limit })
  if (candidates.length === 0) return { available: false, reason: 'no-mutations' }

  const declared = parseDeclared(workflow.guarantees_json)
  const scenarios = db
    .prepare('SELECT * FROM workflow_tests WHERE workflow_id = ? ORDER BY created_at, rowid LIMIT ?')
    .all(workflow.id, MAX_SCENARIOS)

  // What the original already fails, so a mutant is credited only with what its
  // mutation broke.
  let lintBaseline = new Set()
  let guaranteeBaseline = new Set()
  try {
    lintBaseline = signatures(lintGraph(graph), LINT_KILL)
    if (declared.length > 0) {
      guaranteeBaseline = signatures(guaranteeIssues(graph, declared), GUARANTEE_KILL)
    }
  } catch {
    /* a baseline that cannot be computed credits the mutants with nothing */
  }

  const results = []
  for (const mutant of candidates) {
    const lint = refusedByLint(mutant.graph, lintBaseline)
    if (lint) {
      results.push({ ...describe(mutant), killed: true, by: 'lint', detail: lint })
      continue
    }

    const guarantee = breaksGuarantee(mutant.graph, declared, guaranteeBaseline)
    if (guarantee) {
      results.push({ ...describe(mutant), killed: true, by: 'guarantee', detail: guarantee })
      continue
    }

    if (scenarios.length === 0) {
      results.push({ ...describe(mutant), killed: false, by: null, detail: null })
      continue
    }

    // eslint-disable-next-line no-await-in-loop
    const failed = await killedByTests(workflow, scenarios, mutant.graph)
    results.push(
      failed
        ? { ...describe(mutant), killed: true, by: 'test', detail: failed.scenario }
        : { ...describe(mutant), killed: false, by: null, detail: null }
    )
  }

  const killed = results.filter((r) => r.killed)
  return {
    available: true,
    workflowId: workflow.id,
    scenarios: scenarios.length,
    guarantees: declared.length,
    mutants: results,
    summary: {
      total: results.length,
      killed: killed.length,
      survived: results.length - killed.length,
      // A percentage, because that is what everybody expects from a mutation
      // score — and the survivors below it are what anybody should actually
      // read, since a score of 80% says nothing about *which* fifth got through.
      score: results.length === 0 ? null : Math.round((killed.length / results.length) * 100),
      byLint: killed.filter((r) => r.by === 'lint').length,
      byGuarantee: killed.filter((r) => r.by === 'guarantee').length,
      byTest: killed.filter((r) => r.by === 'test').length,
    },
  }
}

const describe = (mutant) => ({
  id: mutant.id,
  operator: mutant.operator,
  nodeId: mutant.nodeId,
  describe: mutant.describe,
})

module.exports = { analyzeMutations, MAX_SCENARIOS }
