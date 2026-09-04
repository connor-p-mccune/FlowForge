// Why didn't it send the email?
//
// That is the question, and it is asked about every workflow tool ever built.
// The run says `completed`. The email step says `skipped`. Everything is
// green and the customer did not get their receipt.
//
// Answering it means holding three things together, and FlowForge already has
// all three and has never joined them up:
//
//   1. **What the run did** — `execution_steps`, including the rows the engine
//      settles as `skipped` for nodes a branch went past.
//   2. **What gates what** — control dependence, which
//      [`effects.js`](./effects.js) already computes to say *"Charge card
//      requires Approve = true"*.
//   3. **Which way each gate actually went** — the decision node's own recorded
//      output, sitting in the same steps table.
//
// Put together, they turn "skipped" into a sentence:
//
//     Send receipt did not run.
//       High risk? was true, and its "true" branch does not reach it.
//
// This is the runtime counterpart to the effect report. That one says what a
// run *could* do and what would have to be true first; this says what one run
// *did*, and which of those conditions decided it.
//
// ---
//
// ## Naming the decision, not a decision
//
// A node skipped in a run is usually excluded by exactly one decision, but the
// graph can gate it behind several. Reporting all of them is noise — a reviewer
// wants the reason, not the audit trail — so the report names the **deepest**
// one that excluded it: the last gate the run passed before the path to this
// node was closed off.
//
// That is the one somebody would point at. Everything upstream of it is why
// *that* gate was reached, which is the next question and not this one.
//
// ## Reading a condition out loud
//
// A decision's own outcome is recorded, so no re-derivation is needed to say
// which way it went. The interesting part is *why*, and for an FXL expression
// that is answerable exactly: the expression is pure, its scope is the step's
// recorded input, and the identifiers it reads are in the AST.
//
// So `total > 100` becomes `total > 100 — total was 85`. No re-evaluation and
// no guessing: the values are read out of the row the engine already wrote.
//
// A left/right comparison is reported without operands. Those are `{{…}}`
// templates resolved against a scope spanning every prior node's output, and
// that scope is not recorded per step — reconstructing it would be inventing a
// value and printing it as a fact.

const db = require('../config/database')
const { parse } = require('./expression')
const { executionGraph } = require('./guarantees')
const { ENTRY, EXIT, immediateDominators, dominates } = require('./dominance')

// `executionGraph` already partitions a decision's outgoing edges into the
// outcome groups exactly one of which activates, and hands them over in
// `graph.decisions`. That is what makes "why was this skipped" answerable for a
// condition, a switch, a validate gate, an approval, a wait-callback and a
// per-node error branch without this file knowing what any of them are.
const SETTLED = new Set(['succeeded', 'failed', 'skipped'])

// Every identifier an expression reads, in source order and without duplicates.
// `a.b` yields `a.b`; `a[expr]` yields `a` because the property is computed and
// naming it would require evaluating the run again.
function identifiers(ast, out = [], seen = new Set()) {
  if (!ast || typeof ast !== 'object') return out
  if (ast.type === 'Identifier') {
    if (!seen.has(ast.name)) {
      seen.add(ast.name)
      out.push(ast.name)
    }
    return out
  }
  if (ast.type === 'Member' && !ast.computed) {
    const path = memberPath(ast)
    if (path) {
      if (!seen.has(path)) {
        seen.add(path)
        out.push(path)
      }
      // The base is covered by the full path — reporting `order` beside
      // `order.total` is the whole object printed next to the field somebody
      // asked about. Only the computed indices inside the chain are still
      // worth naming, because `a.b[c].d` really does read `c`.
      return memberInterior(ast.object, out, seen)
    }
    return identifiers(ast.object, out, seen)
  }
  for (const key of Object.keys(ast)) {
    const child = ast[key]
    if (Array.isArray(child)) child.forEach((c) => identifiers(c, out, seen))
    else if (child && typeof child === 'object') identifiers(child, out, seen)
  }
  return out
}

// The parts of a member chain that are not already covered by its dotted path:
// the index expressions of any computed links.
function memberInterior(node, out, seen) {
  if (!node || typeof node !== 'object') return out
  if (node.type === 'Identifier') return out
  if (node.type === 'Member') {
    if (node.computed) identifiers(node.property, out, seen)
    return memberInterior(node.object, out, seen)
  }
  return identifiers(node, out, seen)
}

function memberPath(node) {
  if (node.type === 'Identifier') return node.name
  if (node.type === 'Member' && !node.computed) {
    const base = memberPath(node.object)
    return base ? `${base}.${node.property}` : null
  }
  return null
}

const readPath = (scope, path) =>
  path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), scope)

// A value as a reader should see it. Long strings and deep objects are the
// reason a debug panel gets closed again, so they are cut rather than dumped.
function display(value) {
  if (value === undefined) return 'not set'
  if (value === null) return 'null'
  if (typeof value === 'string') return value.length > 40 ? `"${value.slice(0, 39)}…"` : `"${value}"`
  if (typeof value === 'object') {
    const json = JSON.stringify(value)
    return json.length > 40 ? `${json.slice(0, 39)}…` : json
  }
  return String(value)
}

// What a decision node decided, and what it read to decide it.
function readDecision(node, step) {
  const config = node.data?.config || {}
  const out = { operator: config.operator || null, reads: [] }

  if (node.type !== 'condition' || config.operator !== 'expression') return out

  const source = config.expression
  if (!source) return out
  let scope
  try {
    scope = JSON.parse(step?.input_json || '{}')
  } catch {
    return out
  }
  try {
    out.expression = String(source)
    for (const path of identifiers(parse(String(source)))) {
      // `input` is the alias for the whole merged bag; printing it would be
      // printing the scope back at the reader.
      if (path === 'input') continue
      out.reads.push({ path, value: display(readPath(scope, path)) })
    }
  } catch {
    // An expression that will not parse cannot have run either; the linter
    // owns saying so and this is not the place to repeat it.
    delete out.expression
  }
  return out
}

// The outcome a decision took in this run, as the name of its edge group.
//
// A condition records `{ result: true|false }` and its groups are named 'true'
// and 'false'. Anything else settles its own outcome name in the output, and a
// node that failed took no outcome at all.
function outcomeTaken(node, step, groups) {
  if (!step || step.status !== 'succeeded') return null
  let output
  try {
    output = JSON.parse(step.output_json || 'null')
  } catch {
    return null
  }
  if (output && typeof output === 'object') {
    if (typeof output.result === 'boolean') return String(output.result)
    for (const key of ['outcome', 'branch', 'decision', 'status']) {
      const value = output[key]
      if (typeof value === 'string' && groups.some((g) => g.name === value)) return value
    }
  }
  return null
}

// Every node reachable from a set of starting nodes. Excludes the virtual EXIT,
// which is reachable from everywhere and would make every node look reachable
// from every outcome — the same exclusion the effect report makes, for the same
// reason.
function reachSet(graph, starts) {
  const seen = new Set()
  const stack = [...starts]
  while (stack.length > 0) {
    const id = stack.pop()
    if (id === EXIT || seen.has(id)) continue
    seen.add(id)
    for (const next of graph.succ.get(id) || []) stack.push(next)
  }
  return seen
}

// Which decision closed the path to this node, or null.
//
// The deepest gate that (a) dominates the node, (b) actually settled in this
// run, and (c) took an outcome whose reachable set does not contain the node.
// Deepest because that is the one somebody would point at: everything upstream
// of it is why *that* gate was reached, which is the next question.
function excludedBy(nodeId, decisions, idom, depth) {
  let best = null
  for (const d of decisions) {
    if (d.nodeId === nodeId || !d.taken) continue
    if (!dominates(idom, d.nodeId, nodeId)) continue
    const group = d.groups.find((g) => g.name === d.taken)
    if (!group || group.reach.has(nodeId)) continue
    if (!best || (depth.get(d.nodeId) ?? 0) > (depth.get(best.nodeId) ?? 0)) best = d
  }
  return best
}

// Longest-path depth from the entry, so "deepest" is well defined on a DAG.
function depths(graph, ids) {
  const depth = new Map(ids.map((id) => [id, 0]))
  for (const id of topological(graph, ids)) {
    for (const next of graph.succ.get(id) || []) {
      if (!depth.has(next)) continue
      depth.set(next, Math.max(depth.get(next), (depth.get(id) ?? 0) + 1))
    }
  }
  return depth
}

function topological(graph, ids) {
  const indegree = new Map(ids.map((id) => [id, 0]))
  for (const id of ids) {
    for (const next of graph.succ.get(id) || []) {
      if (indegree.has(next)) indegree.set(next, indegree.get(next) + 1)
    }
  }
  const queue = ids.filter((id) => indegree.get(id) === 0)
  const out = []
  while (queue.length > 0) {
    const id = queue.shift()
    out.push(id)
    for (const next of graph.succ.get(id) || []) {
      if (!indegree.has(next)) continue
      indegree.set(next, indegree.get(next) - 1)
      if (indegree.get(next) === 0) queue.push(next)
    }
  }
  return out
}

// Why one run did what it did.
function explainRun(executionId) {
  const execution = db
    .prepare('SELECT id, workflow_id, status, created_at, finished_at FROM executions WHERE id = ?')
    .get(executionId)
  if (!execution) return { available: false, reason: 'not-found' }

  const workflow = db
    .prepare('SELECT id, name, graph_json FROM workflows WHERE id = ?')
    .get(execution.workflow_id)
  if (!workflow) return { available: false, reason: 'workflow-gone', executionId }

  let raw
  try {
    raw = JSON.parse(workflow.graph_json)
  } catch {
    return { available: false, reason: 'unreadable-graph', executionId }
  }

  const graph = executionGraph(raw)
  if (graph.nodes.length === 0) return { available: false, reason: 'empty', executionId }

  const steps = new Map(
    db
      .prepare('SELECT node_id, node_type, status, error, input_json, output_json FROM execution_steps WHERE execution_id = ?')
      .all(executionId)
      .map((s) => [s.node_id, s])
  )
  const ids = graph.nodes.map((n) => n.id)
  const byId = graph.byId
  const idom = immediateDominators({ entry: ENTRY, succ: graph.succ, pred: graph.pred })
  const depth = depths(graph, ids)

  // Every node whose edges partition into outcomes, with the one this run took.
  // `graph.decisions` has already done the partitioning; what this adds is the
  // reach set per outcome, which is what turns "it went left" into "and that is
  // why the right-hand half of the graph did not run".
  const decisions = []
  for (const [nodeId, described] of graph.decisions) {
    const node = byId.get(nodeId)
    if (!node) continue
    const groups = described.map((g) => ({
      name: g.name,
      reach: reachSet(graph, g.edges.map((e) => e.target)),
    }))
    const step = steps.get(nodeId)
    decisions.push({
      nodeId,
      label: node.data?.label || nodeId,
      type: node.type,
      status: step?.status || 'not-reached',
      taken: outcomeTaken(node, step, groups),
      groups,
      ...readDecision(node, step),
    })
  }

  const explained = []
  for (const nodeId of ids) {
    const node = byId.get(nodeId)
    if (!node) continue
    const step = steps.get(nodeId)
    const status = step && SETTLED.has(step.status) ? step.status : step?.status || 'not-reached'
    const row = {
      nodeId,
      label: node.data?.label || nodeId,
      type: node.type,
      status,
    }
    if (status === 'failed' && step?.error) row.error = step.error
    if (status === 'skipped' || status === 'not-reached') {
      const cause = excludedBy(nodeId, decisions, idom, depth)
      if (cause) {
        row.because = {
          nodeId: cause.nodeId,
          label: cause.label,
          outcome: cause.taken,
          expression: cause.expression || null,
          reads: cause.reads,
        }
      }
    }
    explained.push(row)
  }

  const counts = { ran: 0, skipped: 0, failed: 0, unreached: 0 }
  for (const row of explained) {
    if (row.status === 'succeeded') counts.ran += 1
    else if (row.status === 'failed') counts.failed += 1
    else if (row.status === 'skipped') counts.skipped += 1
    else counts.unreached += 1
  }

  return {
    available: true,
    executionId,
    workflowId: workflow.id,
    name: workflow.name,
    status: execution.status,
    steps: explained,
    decisions: decisions.map((d) => ({
      nodeId: d.nodeId,
      label: d.label,
      type: d.type,
      status: d.status,
      outcome: d.taken,
      expression: d.expression || null,
      reads: d.reads,
      // The branches this decision closed, which is the inverse reading and the
      // one somebody asks about a run that did too little.
      closed: d.taken ? d.groups.filter((g) => g.name !== d.taken).map((g) => g.name) : [],
    })),
    summary: {
      ...counts,
      decisions: decisions.length,
      // Skipped nodes this could not attribute. Reported rather than hidden: a
      // report claiming to explain everything, that quietly does not, is worse
      // than one that says which rows it could not.
      unexplained: explained.filter((r) => r.status === 'skipped' && !r.because).length,
    },
  }
}

module.exports = { explainRun, identifiers, display }
