// Path feasibility — which branches of a workflow any input can actually take,
// and what input takes them.
//
// This is the fifth lens over a canvas, and it differs from the other four
// along the axis none of them vary on. The linter reasons about **structure and
// config**, `typeInference` about the **shape** of what flows, `lineage` about
// its **provenance**, `guarantees` about which **paths exist**. Every one of
// them is silent about a branch that exists in the graph and that no run will
// ever take:
//
//     switch (kind)  case "refund" → …          ← downstream of a condition
//                                                  that already required
//                                                  kind == "order"
//
// The graph says the path is there. Dominance agrees. Types agree. The branch
// is dead, the node behind it has never run, and nothing says so.
//
// The reason is that all four ask about the graph and this question is about
// the **data**: is the conjunction of the branch conditions along a path
// satisfiable? That is a solver question, and `services/constraints.js` is the
// solver. This module is the part that turns a canvas into constraints — and,
// because the solver returns a *model* rather than a yes, turns the answer back
// into a concrete trigger payload that drives the branch.
//
// So one analysis produces two things nobody had:
//
//   * **dead branches**, as a lint finding with the conflicting condition named;
//   * **a test scenario per branch**, generated rather than written, which is
//     what makes branch coverage of a workflow a thing that can exist at all.
//
// ## Variable identity is the whole correctness argument
//
// Two reads of `amount` at different nodes are the same value only if nothing
// between them rewrote it. Getting that wrong in one direction is harmless and
// in the other is not: **merging two variables that are actually different can
// manufacture a contradiction** — reporting a live branch dead — while
// splitting one that is actually the same can only lose a finding. So the rule
// is to split unless the graph proves otherwise:
//
//   * `{{node.field}}` names its producer, so it resolves exactly.
//   * A bare identifier in an expression resolves through the inferred output
//     types: if exactly one upstream node could have produced that field, it is
//     that node's; if several could, the read gets a variable of its own and
//     the analysis simply declines to correlate it.
//   * Every trigger node emits the run's one payload (the engine's
//     `baseInput` for a `trigger-*` node is `{ ...triggerPayload }`), so all of
//     them share a single `trigger.*` namespace. That is the one place two
//     reads are merged, and it is merged because it is provably the same value.
//
// Anything outside the solver's fragment — a JSON Schema check, a human
// approval, a function call, a `contains` comparison — becomes a free
// proposition: it constrains nothing, but its two outcomes still exclude each
// other, which is how a validate gate keeps `valid` and `invalid` apart without
// the solver knowing what a schema is.

const T = require('./types')
const C = require('./constraints')
const { parse } = require('./expression/parser')
const { inferGraphTypes } = require('./typeInference')
const { analyzeGraph } = require('./guarantees')
const { ENTRY, EXIT } = require('./dominance')

// Bounds. A canvas produces graphs with a handful of decisions, so these are
// far above anything real; they exist so a pathological import cannot make a
// lint pass hang. Hitting one marks the report **truncated**, and a truncated
// report never claims a branch is dead — an unexplored path is not a
// non-existent one.
const MAX_PATH_STATES = 4000
const MAX_SOLVER_CALLS = 3000

// A proposition's value in a dry run, where one is forced. Test scenarios
// execute in dry-run mode, so this is what decides whether a branch can be
// *driven* by a generated payload at all: approvals auto-approve
// (nodeRunners/approval.js) and callbacks report `received`
// (nodeRunners/waitCallback.js), so the other side of those gates is
// unreachable in test mode however the payload is written.
const DRY_RUN_FORCED = {
  approval: true,
  'wait-callback': true,
  // A node's failure branch: nothing fires in a dry run, so the caught-failure
  // outcome does not occur. Stated as an assumption rather than a guarantee —
  // a transform can still throw — which is why it only ever *withholds* a
  // generated scenario rather than asserting anything.
  error: false,
}

const labelOf = (node) => node?.data?.label || node?.id || '(unknown)'

// — reading a reference ————————————————————————————————————————————————

const EXACT_PLACEHOLDER = /^\{\{\s*([\w-]+(?:\.[\w-]+)*)\s*\}\}$/
const HAS_PLACEHOLDER = /\{\{/

// Scope names that are not node ids: reserved namespaces the engine resolves
// beside node outputs. They are real, stable values — a workspace variable does
// not change between two reads in one run — so they get a variable rather than
// being discarded, they are simply not something a trigger payload can set.
const RESERVED_SCOPES = new Set(['secrets', 'vars', 'callbacks'])

// A canonical string for an AST, used to key the variable a sub-expression the
// fragment cannot model stands for. Built from *resolved* variable ids rather
// than source text, so `len(items)` at two nodes correlates only when `items`
// resolved to the same thing at both.
function sourceKey(ast, ctx) {
  if (!ast) return '?'
  switch (ast.type) {
    case 'Literal':
      return JSON.stringify(ast.value)
    case 'Identifier':
    case 'Member': {
      const path = pathOf(ast)
      if (path) {
        const resolved = ctx.resolvePath(path)
        return resolved ? resolved.id : `?${path.join('.')}`
      }
      return `member(${sourceKey(ast.object, ctx)})`
    }
    case 'Unary':
      return `${ast.op}(${sourceKey(ast.argument, ctx)})`
    case 'Binary':
    case 'Logical':
      return `(${sourceKey(ast.left, ctx)}${ast.op}${sourceKey(ast.right, ctx)})`
    case 'Call':
      return `${ast.callee}(${ast.args.map((a) => sourceKey(a, ctx)).join(',')})`
    case 'Array':
      return `[${ast.elements.map((a) => sourceKey(a, ctx)).join(',')}]`
    case 'Conditional':
      return `(${sourceKey(ast.test, ctx)}?${sourceKey(ast.consequent, ctx)}:${sourceKey(ast.alternate, ctx)})`
    default:
      return '?'
  }
}

// The dotted path an identifier/member chain names, or null when a computed
// index makes it dynamic.
function pathOf(ast) {
  if (!ast) return null
  if (ast.type === 'Identifier') return [ast.name]
  if (ast.type !== 'Member') return null
  const base = pathOf(ast.object)
  if (!base) return null
  if (!ast.computed) return [...base, ast.property]
  const key = ast.property
  if (key?.type === 'Literal' && (typeof key.value === 'string' || typeof key.value === 'number')) {
    return [...base, String(key.value)]
  }
  return null
}

// — translating an expression ——————————————————————————————————————————
//
// Two mutually recursive readings of the same AST, because FXL has no types at
// this level: `translateBoolean` reads a subtree as a condition and
// `translateTerm` reads one as a value. The split is what lets `flag &&
// amount > 10` put `flag` through the truthiness rule and `amount` through the
// arithmetic one without either having to guess.

// A term is a constant, a variable, or nothing the fragment can express.
const constant = (value) => ({ kind: 'const', value })
const variable = (id) => ({ kind: 'var', id })

function translateTerm(ast, ctx) {
  if (!ast) return null
  switch (ast.type) {
    case 'Literal':
      return constant(ast.value)
    case 'Unary':
      if (ast.op === '-') {
        const inner = translateTerm(ast.argument, ctx)
        if (inner?.kind === 'const' && typeof inner.value === 'number') return constant(-inner.value)
      }
      if (ast.op === '+') return translateTerm(ast.argument, ctx)
      return variable(ctx.opaque(ast))
    case 'Identifier':
    case 'Member': {
      const path = pathOf(ast)
      if (!path) return variable(ctx.opaque(ast))
      const resolved = ctx.resolvePath(path)
      return resolved ? variable(resolved.id) : variable(ctx.opaque(ast))
    }
    default:
      // Arithmetic, calls, and anything else become one opaque variable keyed
      // by what they compute over. `len(items) > 0` and `len(items) == 0` still
      // contradict each other; `len(items)` and `items` do not correlate,
      // which is the conservative direction.
      return variable(ctx.opaque(ast))
  }
}

const isNumeric = (v) =>
  typeof v === 'number' ? Number.isFinite(v)
    : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))

const asNumber = (v) => (typeof v === 'number' ? v : Number(v))

// `left op right`, where each side is already a term.
function comparison(left, right, op, ctx, ast) {
  if (!left || !right) return C.free(ctx.opaque(ast))

  const relational = op === '<' || op === '<=' || op === '>' || op === '>='
  const equality = op === '==' || op === '===' || op === '!=' || op === '!=='
  const negated = op === '!=' || op === '!=='

  if (left.kind === 'const' && right.kind === 'const') {
    // Both sides constant: the comparison is decided, not constrained.
    return decidedComparison(left.value, right.value, op) ? C.TRUE : C.FALSE
  }

  // Normalise so the variable is on the left.
  if (left.kind === 'const') {
    const flipped = { '<': '>', '<=': '>=', '>': '<', '>=': '<=' }[op] || op
    return comparison(right, left, flipped, ctx, ast)
  }

  if (right.kind === 'const') {
    const value = right.value
    if (relational) {
      // FXL compares numerically when both sides are numeric and
      // lexicographically otherwise (evaluate.js, `compare`); only the numeric
      // half is in the fragment.
      if (!isNumeric(value)) return C.free(ctx.opaque(ast))
      return C.num(left.id, op, asNumber(value))
    }
    if (equality) {
      // A numeric literal goes to the arithmetic theory so that `status == 200`
      // and `status > 400` are constraints on the same variable rather than on
      // two sorts of one.
      const body = isNumeric(value)
        ? C.numEq(left.id, asNumber(value))
        : C.val(left.id, 'eq', value)
      return negated ? C.not(body) : body
    }
    return C.free(ctx.opaque(ast))
  }

  // Variable against variable.
  if (relational) return C.diff(left.id, right.id, op, 0)
  if (equality) {
    // Deliberately a proposition rather than two difference constraints: an
    // equality between two variables says nothing about their sort, and
    // claiming they are numbers to express it could turn a satisfiable
    // conjunction into a contradiction. As a proposition it still contradicts
    // its own negation, which is the part that matters.
    const [a, b] = [left.id, right.id].sort()
    const body = C.free(`eq:${a}=${b}`)
    return negated ? C.not(body) : body
  }
  return C.free(ctx.opaque(ast))
}

function decidedComparison(a, b, op) {
  const numeric = isNumeric(a) && isNumeric(b)
  const [x, y] = numeric ? [asNumber(a), asNumber(b)] : [String(a), String(b)]
  switch (op) {
    case '<': return x < y
    case '<=': return x <= y
    case '>': return x > y
    case '>=': return x >= y
    case '!=':
    case '!==': return !(numeric ? x === y : String(a) === String(b))
    default: return numeric ? x === y : String(a) === String(b)
  }
}

// `needle in [a, b, c]` — the only membership shape the fragment covers. A
// haystack that is not a literal array (a string, an upstream value) falls
// through to a proposition.
function membership(ast, ctx) {
  const needle = translateTerm(ast.left, ctx)
  if (!needle || needle.kind !== 'var' || ast.right?.type !== 'Array') {
    return C.free(ctx.opaque(ast))
  }
  const elements = ast.right.elements.map((e) => translateTerm(e, ctx))
  if (elements.some((e) => !e || e.kind !== 'const')) return C.free(ctx.opaque(ast))
  // Mixed lists split cleanly because each element is decided on its own:
  // numbers go to the arithmetic theory, everything else to the domain one.
  return C.or(
    elements.map((e) =>
      isNumeric(e.value) ? C.numEq(needle.id, asNumber(e.value)) : C.val(needle.id, 'eq', e.value)
    )
  )
}

function translateBoolean(ast, ctx) {
  if (!ast) return C.TRUE
  switch (ast.type) {
    case 'Logical':
      return ast.op === '&&'
        ? C.and([translateBoolean(ast.left, ctx), translateBoolean(ast.right, ctx)])
        : C.or([translateBoolean(ast.left, ctx), translateBoolean(ast.right, ctx)])
    case 'Unary':
      if (ast.op === '!') return C.not(translateBoolean(ast.argument, ctx))
      return truthOf(ast, ctx)
    case 'Binary':
      if (ast.op === 'in') return membership(ast, ctx)
      if (['<', '<=', '>', '>=', '==', '===', '!=', '!=='].includes(ast.op)) {
        return comparison(translateTerm(ast.left, ctx), translateTerm(ast.right, ctx), ast.op, ctx, ast)
      }
      return truthOf(ast, ctx)
    case 'Conditional':
      // `t ? a : b` in boolean position is (t ∧ a) ∨ (¬t ∧ b) — the same
      // reading the evaluator gives it, written as a formula.
      return C.or([
        C.and([translateBoolean(ast.test, ctx), translateBoolean(ast.consequent, ctx)]),
        C.and([C.not(translateBoolean(ast.test, ctx)), translateBoolean(ast.alternate, ctx)]),
      ])
    case 'Literal':
      return truthyLiteral(ast.value) ? C.TRUE : C.FALSE
    default:
      return truthOf(ast, ctx)
  }
}

// FXL's `toBool`: a string is falsy only when empty, everything else follows
// Boolean.
const truthyLiteral = (v) => (typeof v === 'string' ? v.length > 0 : Boolean(v))

// A subtree used directly as a condition. A resolvable value gets the
// truthiness constraint; anything else is a proposition.
function truthOf(ast, ctx) {
  const term = translateTerm(ast, ctx)
  if (term?.kind === 'var') return C.truthy(term.id)
  if (term?.kind === 'const') return truthyLiteral(term.value) ? C.TRUE : C.FALSE
  return C.free(ctx.opaque(ast))
}

// — the per-node translation context ——————————————————————————————————

function makeContext(nodeId, resolveIdentifier) {
  const opaqueIds = new Map()
  const ctx = {
    nodeId,
    // A read the graph cannot attribute gets a variable scoped to this node, so
    // two such reads correlate within one expression and never across nodes.
    opaque(ast) {
      const key = sourceKey(ast, ctx)
      if (!opaqueIds.has(key)) opaqueIds.set(key, `~${nodeId}:${key}`)
      return opaqueIds.get(key)
    },
    resolvePath: (path) => resolveIdentifier(nodeId, path),
  }
  return ctx
}

// — decision guards ————————————————————————————————————————————————————
//
// One formula per outcome of a decision, in the same vocabulary
// `guarantees.outcomeGroups` names them. Everything the fragment cannot model
// becomes a proposition keyed on the node, so the outcomes stay mutually
// exclusive even when their content is opaque.

function parseOrNull(source) {
  if (source == null || String(source).trim() === '') return null
  try {
    return parse(String(source))
  } catch {
    // A broken expression is already a lint error in its own words; reporting
    // it a second time here would be noise, and analysing it would be fiction.
    return null
  }
}

// A `left`/`right` config field of the simple condition operator, which is a
// template string rather than an expression.
function templateTerm(raw, ctx) {
  if (raw == null) return constant('')
  const text = String(raw)
  const exact = text.match(EXACT_PLACEHOLDER)
  if (exact) {
    const resolved = ctx.resolvePath(exact[1].split('.'))
    return resolved ? variable(resolved.id) : variable(`~${ctx.nodeId}:${text}`)
  }
  // An interpolated string is a value built from parts; the fragment has no
  // concatenation, so it is one opaque variable rather than a constant.
  if (HAS_PLACEHOLDER.test(text)) return variable(`~${ctx.nodeId}:${text}`)
  return constant(text)
}

function conditionGuard(node, ctx) {
  const config = node.data?.config || {}
  if (config.operator === 'expression') {
    const ast = parseOrNull(config.expression)
    return ast ? translateBoolean(ast, ctx) : C.free(`${node.id}:expr`)
  }
  const left = templateTerm(config.left, ctx)
  const right = templateTerm(config.right, ctx)
  switch (config.operator || 'equals') {
    case 'equals':
      return comparison(left, right, '==', ctx, null)
    case 'not_equals':
      return C.not(comparison(left, right, '==', ctx, null))
    case 'greater_than':
      return comparison(left, right, '>', ctx, null)
    case 'less_than':
      return comparison(left, right, '<', ctx, null)
    default:
      // `contains` is substring matching, which the fragment has no theory for.
      return C.free(`${node.id}:${config.operator}`)
  }
}

// Cases are evaluated top to bottom and the first match wins, so a case's guard
// is its own expression conjoined with the negation of every case before it —
// which is exactly why `default` is reachable only when all of them fail, and
// why a case shadowed by an earlier one comes back unsatisfiable.
function switchGuards(node, ctx) {
  const cases = Array.isArray(node.data?.config?.cases) ? node.data.config.cases : []
  const guards = new Map()
  const priors = []
  for (let i = 0; i < cases.length; i++) {
    const label = typeof cases[i]?.label === 'string' ? cases[i].label.trim() : ''
    const ast = parseOrNull(cases[i]?.expression)
    const own = ast ? translateBoolean(ast, ctx) : C.free(`${node.id}:case${i}`)
    if (label) {
      const guard = C.and([...priors.map((p) => C.not(p)), own])
      // Two cases may share a label; the outcome fires if either matches.
      guards.set(label, guards.has(label) ? C.or([guards.get(label), guard]) : guard)
    }
    priors.push(own)
  }
  guards.set('default', C.and(priors.map((p) => C.not(p))))
  return guards
}

// The guard of every outcome of every decision, plus the propositions each one
// introduced (so generation can tell a data-driven branch from a
// human-driven one).
function decisionGuards(graph, resolveIdentifier) {
  const guards = new Map() // nodeId -> Map(outcomeName -> formula)
  const propositions = new Map() // propositionId -> { nodeId, dryRun }

  const declare = (id, nodeId, dryRun) => {
    if (!propositions.has(id)) propositions.set(id, { nodeId, dryRun })
    return C.free(id)
  }

  for (const [nodeId, groups] of graph.decisions) {
    const node = graph.byId.get(nodeId)
    const ctx = makeContext(nodeId, resolveIdentifier)
    const perOutcome = new Map()

    if (node.type === 'condition') {
      const guard = conditionGuard(node, ctx)
      perOutcome.set('true', guard)
      perOutcome.set('false', C.not(guard))
    } else if (node.type === 'switch') {
      for (const [label, guard] of switchGuards(node, ctx)) perOutcome.set(label, guard)
    } else if (node.type === 'validate') {
      // Whether a payload matches a JSON Schema is not an arithmetic fact, so
      // the two outcomes are a proposition and its negation: mutually
      // exclusive, and constraining nothing else.
      const p = declare(`${nodeId}:valid`, nodeId, null)
      perOutcome.set('valid', p)
      perOutcome.set('invalid', C.not(p))
    } else if (node.type === 'approval') {
      const p = declare(`${nodeId}:approved`, nodeId, DRY_RUN_FORCED.approval)
      perOutcome.set('true', p)
      perOutcome.set('false', C.not(p))
    } else if (node.type === 'wait-callback') {
      const p = declare(`${nodeId}:received`, nodeId, DRY_RUN_FORCED['wait-callback'])
      perOutcome.set('received', p)
      perOutcome.set('timed-out', C.not(p))
    } else {
      // The per-node error branch: succeeded, or was caught. The same two-way
      // shape, which is why it needs no case of its own beyond naming the
      // proposition.
      const p = declare(`${nodeId}:failed`, nodeId, DRY_RUN_FORCED.error)
      for (const group of groups) {
        perOutcome.set(group.name, group.name === 'error' ? p : C.not(p))
      }
    }

    // A decision whose outcome names the graph reports but the translation
    // above did not produce (a switch case with no label, say) is left
    // unconstrained rather than assumed false.
    for (const group of groups) {
      if (!perOutcome.has(group.name)) perOutcome.set(group.name, C.TRUE)
    }
    guards.set(nodeId, perOutcome)
  }

  return { guards, propositions }
}

// — variable identity ——————————————————————————————————————————————————

// Whose output a node's expressions can actually see. **Immediate predecessors,
// not ancestors**, because that is what the engine merges:
//
//   input = Object.assign(baseInput, ...activeIncoming.map(e => context[e.source]))
//
// A condition node outputs `{ result }` and nothing else, so `amount` is not in
// scope below one however far upstream it was produced. The two reference
// styles diverge here and the analysis has to follow: `{{hook.amount}}` reads
// the whole run context and works anywhere downstream, while a bare `amount` in
// an expression reads only the merge — which is why the resolver treats them
// differently rather than as two spellings of one thing.
function computeInputSources(graph) {
  const sources = new Map()
  for (const node of graph.nodes) {
    sources.set(node.id, (graph.incoming.get(node.id) || []).map((e) => e.source))
  }
  return sources
}

function makeResolver(graph, rawGraph) {
  const types = inferGraphTypes(rawGraph)
  const inputSources = computeInputSources(graph)
  const isTrigger = (id) => Boolean(graph.byId.get(id)?.type?.startsWith('trigger-'))

  // A reference the engine resolves through the template scope: `{{node.path}}`,
  // `{{secrets.NAME}}`, `{{vars.NAME}}`.
  function resolveTemplate(path) {
    const [head, ...rest] = path
    if (rest.length === 0) return null // the whole object — no scalar to constrain
    if (RESERVED_SCOPES.has(head)) return { id: `${head}.${rest.join('.')}`, controllable: false }
    if (!graph.byId.has(head)) return null
    if (isTrigger(head)) return { id: `trigger.${rest.join('.')}`, controllable: true }
    return { id: `${head}.${rest.join('.')}`, controllable: false }
  }

  // A bare identifier inside an expression, read against the node's merged
  // input. `input` is the alias the condition/switch/filter runners put in
  // scope for the whole upstream bag, so `input.amount` and `amount` are the
  // same read and must resolve to the same variable.
  function resolveIdentifier(nodeId, rawPath) {
    const path = rawPath[0] === 'input' ? rawPath.slice(1) : rawPath
    if (path.length === 0) return null

    // An explicit node reference wins: a graph with a node called `trigger`
    // would otherwise shadow the namespace, and the template form is
    // unambiguous by construction.
    const asTemplate = resolveTemplate(path)
    if (asTemplate) return asTemplate

    const field = path[0]
    const candidates = []
    for (const id of inputSources.get(nodeId) || []) {
      if (T.lookup(types.outputs[id], field).exists !== 'no') candidates.push(id)
    }
    if (candidates.length === 0) return null
    // Every trigger emits the run's single payload, so reads attributed to any
    // of them are the same value — the one merge this analysis makes, and it is
    // made because the engine guarantees it.
    if (candidates.every(isTrigger)) return { id: `trigger.${path.join('.')}`, controllable: true }
    if (candidates.length === 1) {
      return { id: `${candidates[0]}.${path.join('.')}`, controllable: false }
    }
    // Several nodes could have written this field. Correlating the reads could
    // only invent a contradiction, so they are left uncorrelated.
    return null
  }

  return { resolveIdentifier, types }
}

// — the search —————————————————————————————————————————————————————————

// Deletion-based minimal unsatisfiable subset, returned as indices into the
// guard list. Once a path is known unsatisfiable, dropping guards one at a time
// and re-solving finds the few that actually conflict — which is the difference
// between "this branch is unreachable" and "this branch is unreachable because
// the condition above it already required kind == 'order'".
//
// The guard list and the list of outcomes taken grow in lockstep during the
// search (only a decision contributes to either), so an index into one names an
// entry in the other — which is how a set of formulas becomes a sentence about
// nodes on a canvas.
function minimalCore(guards, solve) {
  let keep = guards.map((_, i) => i)
  for (let i = keep.length - 1; i >= 0; i--) {
    const without = keep.filter((_, j) => j !== i)
    if (solve(without.map((k) => guards[k])).status === 'unsat') keep = without
  }
  return keep
}

// A path is identified by the outcomes it took, not by the nodes it visited:
// two routes through an unconditional diamond impose the same constraints, so
// exploring the second one would only re-derive the first one's answer.
const signatureOf = (taken) => taken.map((t) => `${t.nodeId}=${t.outcome}`).sort().join('|')

function explore(graph, guardsByNode) {
  const budget = { solves: 0, states: 0, truncated: false }
  const cache = new Map()

  const solve = (formulas) => {
    const key = formulas.map((f) => JSON.stringify(f)).join('&')
    if (cache.has(key)) return cache.get(key)
    if (budget.solves >= MAX_SOLVER_CALLS) {
      budget.truncated = true
      return { status: 'unknown', model: null }
    }
    budget.solves++
    const result = C.solve(C.and(formulas))
    cache.set(key, result)
    return result
  }

  // nodeId -> { status, model, taken }, and the same per decision outcome.
  const nodeResult = new Map()
  const outcomeResult = new Map() // `${nodeId}:${outcome}` -> { … }
  const seen = new Map() // nodeId -> Set(signature)

  const record = (map, key, status, model, taken, guards) => {
    const existing = map.get(key)
    if (existing?.status === 'reachable') return
    if (status !== 'reachable' && existing) {
      // An `unknown` outcome outranks an `unreachable` one: it means some path
      // could not be decided, and a branch that might be live must not be
      // reported dead.
      if (existing.status === 'unknown' || status !== 'unknown') return
    }
    map.set(key, { status, model, taken, guards })
  }

  // An undecided path is not a dead one. When the solver cannot decide a
  // branch, everything downstream of it would otherwise simply never be
  // visited and would read as unreachable — the exact false positive this
  // analysis must not produce — so the subgraph is marked `unknown` explicitly.
  function taintUnknown(startIds) {
    const queue = [...startIds]
    const visited = new Set()
    while (queue.length) {
      const id = queue.shift()
      if (id === EXIT || visited.has(id)) continue
      visited.add(id)
      record(nodeResult, id, 'unknown', null, [], [])
      for (const group of graph.decisions.get(id) || []) {
        record(outcomeResult, `${id}:${group.name}`, 'unknown', null, [], [])
      }
      for (const next of graph.succ.get(id) || []) queue.push(next)
    }
  }

  function walk(nodeId, guards, taken) {
    if (budget.states >= MAX_PATH_STATES) {
      budget.truncated = true
      return
    }
    const signature = signatureOf(taken)
    if (!seen.has(nodeId)) seen.set(nodeId, new Set())
    if (seen.get(nodeId).has(signature)) return
    seen.get(nodeId).add(signature)
    budget.states++

    const verdict = solve(guards)
    if (verdict.status === 'unsat') {
      record(nodeResult, nodeId, 'unreachable', null, taken, guards)
      return
    }
    if (verdict.status === 'unknown') {
      taintUnknown([nodeId])
      return
    }
    record(nodeResult, nodeId, 'reachable', verdict.model, taken, guards)

    const groups = graph.decisions.get(nodeId)
    if (!groups) {
      for (const edge of graph.outgoing.get(nodeId) || []) walk(edge.target, guards, taken)
      return
    }

    const perOutcome = guardsByNode.get(nodeId)
    for (const group of groups) {
      const guard = perOutcome?.get(group.name) ?? C.TRUE
      const next = [...guards, guard]
      const nextTaken = [...taken, { nodeId, outcome: group.name }]
      const branchVerdict = solve(next)
      const key = `${nodeId}:${group.name}`
      if (branchVerdict.status === 'sat') {
        record(outcomeResult, key, 'reachable', branchVerdict.model, nextTaken, next)
        for (const edge of group.edges) walk(edge.target, next, nextTaken)
        continue
      }
      if (branchVerdict.status === 'unknown') {
        record(outcomeResult, key, 'unknown', null, nextTaken, next)
        taintUnknown(group.edges.map((e) => e.target))
        continue
      }
      record(outcomeResult, key, 'unreachable', null, nextTaken, next)
    }
  }

  for (const source of graph.succ.get(ENTRY) || []) walk(source, [], [])

  return { nodeResult, outcomeResult, budget, solve }
}

// — witnesses ——————————————————————————————————————————————————————————

// Turn a model into the two halves a person needs: the trigger payload that
// drives the path, and the assumptions it rests on. Separating them is the
// point — a witness that quietly depended on an API returning 500 would produce
// a generated test that fails for a reason nobody wrote down.
function describeWitness(model, propositionsOnPath) {
  const triggerData = {}
  const assumptions = []
  for (const [id, value] of Object.entries(model || {})) {
    if (id.startsWith('trigger.')) {
      setPath(triggerData, id.slice('trigger.'.length).split('.'), value)
    } else if (!id.startsWith('~')) {
      assumptions.push({ variable: id, value })
    }
  }
  for (const p of propositionsOnPath) assumptions.push({ proposition: p.label })
  return { triggerData, assumptions }
}

function setPath(target, segments, value) {
  let cursor = target
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i]
    if (typeof cursor[key] !== 'object' || cursor[key] === null) cursor[key] = {}
    cursor = cursor[key]
  }
  cursor[segments[segments.length - 1]] = value
}

// Which propositions a path's guards actually commit to, and with what
// polarity. Read off the negation normal form, so a proposition that appears
// only inside an unreached disjunct is not counted.
function propositionsUsed(guards, propositions) {
  const used = new Map()
  const visit = (formula) => {
    if (!formula) return
    if (formula.op === 'atom') {
      if (formula.atom.t === 'free' && propositions.has(formula.atom.id)) {
        used.set(formula.atom.id, !formula.atom.neg)
      }
      return
    }
    if (formula.op === 'and' || formula.op === 'or') formula.args.forEach(visit)
  }
  // Only top-level conjuncts commit the path; a disjunction leaves a choice.
  for (const guard of guards) {
    const nnf = C.nnf(guard)
    if (nnf.op === 'and') nnf.args.filter((a) => a.op === 'atom').forEach(visit)
    else if (nnf.op === 'atom') visit(nnf)
  }
  return used
}

// — generated scenarios ————————————————————————————————————————————————
//
// A witness is a payload that takes a branch; a *scenario* is that payload
// plus an assertion that it did. The assertion is what makes generation worth
// anything — a generated test that only runs the workflow proves nothing, while
// one asserting `steps["route"].result == "refund"` fails the moment an edit
// re-routes the branch it was written to cover.
//
// Every decision settles a `result` the engine routes on (executionEngine.js,
// `activeIncomingFor`), so the assertion is the same shape for all of them.
function outcomeAssertion(node, outcome) {
  const target = `steps[${JSON.stringify(node.id)}]`
  switch (node.type) {
    case 'condition':
    case 'approval':
      return `${target}.result == ${outcome === 'true' ? 'true' : 'false'}`
    case 'switch':
    case 'validate':
    case 'wait-callback':
      return `${target}.result == ${JSON.stringify(outcome)}`
    default:
      // The per-node error branch settles no routing value, so the only honest
      // assertion is that the node ran at all.
      return `${target} != null`
  }
}

// Can a generated payload actually drive this branch in a dry run? Three things
// have to hold, and each failure is worth naming rather than silently omitting
// the scenario: the witness must not depend on a value the payload cannot set,
// and every gate on the path must settle the way test mode makes it settle.
function generability(witness, committed, propositions, graph) {
  const blockers = []
  for (const assumption of witness.assumptions) {
    if (assumption.variable) {
      blockers.push(`depends on ${assumption.variable}`)
    }
  }
  for (const [id, polarity] of committed) {
    const meta = propositions.get(id)
    if (!meta) continue
    const label = labelOf(graph.byId.get(meta.nodeId))
    if (meta.dryRun === null || meta.dryRun === undefined) {
      blockers.push(`${label} decides this, and a payload cannot`)
    } else if (meta.dryRun !== polarity) {
      blockers.push(`test mode always takes the other side of ${label}`)
    }
  }
  return blockers
}

// — the report —————————————————————————————————————————————————————————

function analyzePaths(rawGraph) {
  const analysis = analyzeGraph(rawGraph)
  const graph = analysis.graph
  if (!analysis.ok) {
    return {
      analysed: false,
      reason: analysis.reason,
      truncated: false,
      nodes: [],
      branches: [],
      findings: [],
      scenarios: [],
      coverage: { branches: 0, reachable: 0, generatable: 0 },
    }
  }

  const { resolveIdentifier } = makeResolver(graph, rawGraph)
  const { guards, propositions } = decisionGuards(graph, resolveIdentifier)
  const { nodeResult, outcomeResult, budget, solve } = explore(graph, guards)

  // Which nodes the *graph* can reach, so a node nothing wires up is left to
  // the linter rather than reported twice in different words.
  const graphReachable = new Set()
  const queue = [...(graph.succ.get(ENTRY) || [])]
  while (queue.length) {
    const id = queue.shift()
    if (id === EXIT || graphReachable.has(id)) continue
    graphReachable.add(id)
    for (const next of graph.succ.get(id) || []) queue.push(next)
  }

  const label = (id) => labelOf(graph.byId.get(id))
  const statusOf = (result) => {
    if (result?.status === 'reachable') return 'reachable'
    if (result?.status === 'unknown' || budget.truncated) return 'unknown'
    return 'unreachable'
  }

  const branches = []
  const deadOutcomes = new Set()
  for (const [nodeId, groups] of graph.decisions) {
    const node = graph.byId.get(nodeId)
    for (const group of groups) {
      const key = `${nodeId}:${group.name}`
      const result = outcomeResult.get(key)
      const status = graphReachable.has(nodeId) ? statusOf(result) : 'unknown'
      const committed = result?.guards ? propositionsUsed(result.guards, propositions) : new Map()
      const witness =
        status === 'reachable'
          ? describeWitness(
              result.model,
              [...committed].map(([id, polarity]) => ({
                label: `${labelOf(graph.byId.get(propositions.get(id)?.nodeId))} ${
                  polarity ? 'takes' : 'does not take'
                } its ${id.split(':').pop()} outcome`,
              }))
            )
          : null
      const blockers = witness ? generability(witness, committed, propositions, graph) : []
      if (status === 'unreachable' && group.edges.length > 0) deadOutcomes.add(key)
      branches.push({
        nodeId,
        label: label(nodeId),
        nodeType: node?.type,
        outcome: group.name,
        wired: group.edges.length,
        status,
        witness,
        generatable: status === 'reachable' && blockers.length === 0,
        blockers,
        // Why it is dead, said in terms of the decisions that made it so — the
        // difference between a finding somebody can act on and one they have to
        // investigate.
        conflict:
          status === 'unreachable' && result?.guards
            ? minimalCore(result.guards, solve)
                .map((i) => result.taken[i])
                .filter((t) => t && t.nodeId !== nodeId)
                .map((t) => `${label(t.nodeId)} → ${t.outcome}`)
            : null,
      })
    }
  }

  // Per node, with the input that reaches it. The solver already computed the
  // model on the way to deciding reachability; surfacing it answers a question
  // the branch witnesses cannot — *what payload gets a run to this step?* —
  // which is what turns a surviving mutant into a test somebody can add.
  const nodes = graph.nodes.map((n) => {
    const result = nodeResult.get(n.id)
    const status = graphReachable.has(n.id) ? statusOf(result) : 'unwired'
    return {
      nodeId: n.id,
      label: labelOf(n),
      status,
      witness: status === 'reachable' && result?.model ? describeWitness(result.model, []) : null,
    }
  })

  // Findings. A dead branch is an error: the author wired an outcome that no
  // input reaches, so either the condition above it or the branch itself is
  // wrong. A node made unreachable *by* a dead branch is not reported again —
  // one cause, one finding.
  const findings = []
  for (const branch of branches) {
    if (branch.status !== 'unreachable' || branch.wired === 0) continue
    findings.push({
      severity: 'error',
      code: 'unreachable-branch',
      message:
        `No input can take "${branch.outcome}" out of ${branch.label} — ` +
        (branch.conflict?.length
          ? `it contradicts ${branch.conflict.join(', ')}`
          : 'its own conditions cannot all hold at once'),
      nodeId: branch.nodeId,
    })
  }

  const unreachableNodes = new Set(
    nodes.filter((n) => n.status === 'unreachable').map((n) => n.nodeId)
  )
  for (const node of nodes) {
    if (node.status !== 'unreachable') continue
    const incoming = graph.incoming.get(node.nodeId) || []
    const explained = incoming.every((e) => {
      if (unreachableNodes.has(e.source)) return true
      const groups = graph.decisions.get(e.source) || []
      return groups.some(
        (g) => g.edges.includes(e) && deadOutcomes.has(`${e.source}:${g.name}`)
      )
    })
    if (explained && incoming.length > 0) continue
    findings.push({
      severity: 'warning',
      code: 'unreachable-node',
      message: `${node.label} can never run — no input satisfies the conditions on the way to it`,
      nodeId: node.nodeId,
    })
  }

  // One scenario per drivable branch, named after what it covers.
  const scenarios = branches
    .filter((b) => b.generatable && b.wired > 0)
    .map((b) => ({
      name: `${b.label} → ${b.outcome}`.slice(0, 80),
      triggerData: b.witness.triggerData,
      assertions: [
        {
          expression: outcomeAssertion(graph.byId.get(b.nodeId), b.outcome),
          description: `takes the "${b.outcome}" branch`,
        },
      ],
      covers: { nodeId: b.nodeId, outcome: b.outcome },
    }))

  const wired = branches.filter((b) => b.wired > 0)
  return {
    analysed: true,
    reason: null,
    // A truncated search has not seen every path, so it never claims a branch
    // is dead — the report says so rather than quietly reporting less.
    truncated: budget.truncated,
    nodes,
    branches,
    findings,
    scenarios,
    coverage: {
      branches: wired.length,
      reachable: wired.filter((b) => b.status === 'reachable').length,
      generatable: wired.filter((b) => b.generatable).length,
    },
  }
}

// Linter integration. Only the errors cross over: a dead branch is a defect in
// the same class as a dangling edge, while the rest of the report is a panel's
// worth of detail nobody wants in an issue list.
function pathIssues(rawGraph) {
  const report = analyzePaths(rawGraph)
  if (!report.analysed || report.truncated) return []
  return report.findings
}

module.exports = {
  MAX_PATH_STATES,
  MAX_SOLVER_CALLS,
  DRY_RUN_FORCED,
  analyzePaths,
  pathIssues,
  outcomeAssertion,
  // Exported for the analysis layer and for tests that drive the translation
  // without building a whole graph.
  translateBoolean,
  translateTerm,
  conditionGuard,
  switchGuards,
  decisionGuards,
  makeContext,
  makeResolver,
  computeInputSources,
  explore,
  minimalCore,
  describeWitness,
  propositionsUsed,
  analyzeGraph,
  labelOf,
}
