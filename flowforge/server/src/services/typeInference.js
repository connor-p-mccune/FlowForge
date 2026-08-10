// Schema inference across a workflow graph.
//
// Every runner in `services/nodeRunners/` returns a shape it guarantees — an
// HTTP node yields `{ status, body }`, a Filter yields `{ items, count, total }`
// — and the engine merges those shapes into each downstream node's input with
// `Object.assign`. That is a dataflow with a static type, and this module
// recovers it: one topological pass that gives every node an input type and an
// output type, from which two checks fall out that nothing else could make.
//
//   * `{{http-1.bdy}}` — a reference to a field that cannot exist. Today it
//     resolves to empty string at run time and the run quietly does the wrong
//     thing; here it is a lint error with a spelling suggestion.
//   * `amount * customer`, `tags.length`, `sum(status)` — FXL expressions
//     checked against what the graph proves is actually in scope, by
//     `expression/typecheck.js`.
//
// Three decisions shape the result.
//
// **The output table is transcribed from the runners, not invented.** A schema
// that drifts from what a node really returns turns the checker into a
// generator of false alarms, which is worse than no checker; so the table lists
// exactly the keys each runner constructs, and where a runner has two shapes
// (a real call vs. a dry-run preview) the dry-run keys are recorded as optional
// rather than pretended away.
//
// **Uncertainty is modelled, not rounded off.** A node fed by a branch may
// never receive that branch's fields, so `mergeAssign` records them optional; a
// node whose `onError` policy is `continue` can settle the engine's error
// object instead of its own output, so its type is the union of both; under
// `branch`, the edge leaving the error handle carries the error shape while the
// normal edges carry the normal one. Each of those mirrors a specific line in
// the engine rather than an approximation of it.
//
// **Anything unproven is `unknown`, and `unknown` reports nothing.** A parsed
// HTTP body is `any`, a sub-workflow's return is `unknown`, a node type with no
// rule is `unknown` — and every check downstream of one of those stays silent.

const T = require('./types')
const { buildAdjacency, topoSort } = require('./dagParser')
const { checkTypes } = require('./expression/typecheck')
const { parse } = require('./expression/parser')
const { ExpressionError } = require('./expression/errors')

// A string that is *exactly* one placeholder keeps the referenced value's type
// (the engine's resolveTemplates does this); anything else is interpolation and
// comes out a string.
const EXACT_PLACEHOLDER = /^\{\{\s*([\w-]+(?:\.[\w-]+)*)\s*\}\}$/
const PLACEHOLDER = /\{\{\s*([\w-]+(?:\.[\w-]+)*)\s*\}\}/g

// Nodes that settle a routing result: their outgoing edges fire selectively, so
// a downstream node can't count on any one of them having run.
const BRANCHING_TYPES = new Set([
  'condition',
  'switch',
  'validate',
  'approval',
  'wait-callback',
])

// What the engine settles as a node's output when its failure is caught.
const CAUGHT_ERROR = T.objectOf({
  failed: T.BOOLEAN,
  error: T.objectOf({ message: T.STRING, nodeId: T.STRING, nodeType: T.STRING }),
})

const OPEN_OBJECT = T.objectOf({}, { open: true })

// The preview a side-effecting runner returns instead of firing, in dry-run
// mode. Recorded as optional keys on the node's real shape so a reference to
// `wouldHaveSent` isn't reported as a typo — it is a real key, in test mode.
const DRY_RUN_FIELDS = {
  dryRun: { type: T.BOOLEAN, optional: true },
  wouldHaveSent: { type: OPEN_OBJECT, optional: true },
}

// A type for a concrete JSON value — used for literal config (a Transform
// node's template, a JSON array typed into a Filter's source).
function typeOfValue(value) {
  if (value === null) return T.NULL
  if (Array.isArray(value)) return T.arrayOf(T.joinAll(value.map(typeOfValue)))
  switch (typeof value) {
    case 'number':
      return T.NUMBER
    case 'boolean':
      return T.BOOLEAN
    case 'string':
      return T.STRING
    case 'object': {
      const shape = {}
      for (const [k, v] of Object.entries(value)) shape[k] = typeOfValue(v)
      return T.objectOf(shape)
    }
    default:
      return T.UNKNOWN
  }
}

// — the output table ————————————————————————————————————————————————————
//
// One entry per node type, transcribed from its runner. `ctx` carries the
// helpers a rule may need: `refType(path)` resolves a `{{…}}` reference against
// the nodes already inferred, and `exprType(source, env)` types an FXL
// expression.
const OUTPUT_RULES = {
  // A trigger passes its payload through with `triggered: true` alongside. The
  // payload is whatever the caller sent, so the shape is open — which is also
  // why a typo'd webhook field is *not* reported: we never claimed to know it.
  trigger: () => T.objectOf({ triggered: T.BOOLEAN }, { open: true }),

  'action-http': () =>
    T.objectOf({
      status: T.NUMBER,
      // The response body is parsed JSON when it parses and the raw text when
      // it doesn't. Dynamic by contract, so nothing under it is ever checked.
      body: T.ANY,
      ...DRY_RUN_FIELDS,
    }),

  // Delay passes its input straight through, plus how long it waited.
  'action-delay': (node, input) => withFields(input, { delayedMs: T.NUMBER }),

  'action-email': () =>
    T.objectOf({
      sent: { type: T.BOOLEAN, optional: true },
      simulated: { type: T.BOOLEAN, optional: true },
      messageId: { type: T.STRING, optional: true },
      to: { type: T.STRING, optional: true },
      subject: { type: T.STRING, optional: true },
      ...DRY_RUN_FIELDS,
    }),

  'action-slack': () =>
    T.objectOf({
      ok: { type: T.BOOLEAN, optional: true },
      text: { type: T.STRING, optional: true },
      ...DRY_RUN_FIELDS,
    }),

  transform: (node, input, ctx) => transformOutput(node, input, ctx),

  filter: (node, input, ctx) => {
    const element = sourceElement(node, input, ctx)
    return T.objectOf({ items: T.arrayOf(element), count: T.NUMBER, total: T.NUMBER })
  },

  map: (node, input, ctx) => {
    const element = sourceElement(node, input, ctx)
    const mapped = ctx.exprType(node.data?.config?.mapping, itemEnv(element))
    return T.objectOf({ items: T.arrayOf(mapped), count: T.NUMBER })
  },

  aggregate: (node) => {
    const config = node.data?.config || {}
    const hasValue = !isBlank(config.value)
    const hasGroup = !isBlank(config.groupBy)
    // The stats block only exists when a value expression was supplied;
    // count-only aggregation returns just the count.
    const stats = hasValue
      ? {
          sum: T.NUMBER,
          avg: T.NUMBER,
          // min/max are null for an empty list, so they are genuinely nullable.
          min: T.unionOf([T.NUMBER, T.NULL]),
          max: T.unionOf([T.NUMBER, T.NULL]),
        }
      : {}
    if (!hasGroup) return T.objectOf({ count: T.NUMBER, ...stats })
    return T.objectOf({
      count: T.NUMBER,
      groups: T.arrayOf(T.objectOf({ key: T.UNKNOWN, count: T.NUMBER, ...stats })),
    })
  },

  condition: () => T.objectOf({ result: T.BOOLEAN }),

  switch: () =>
    T.objectOf({
      result: T.STRING,
      matched: T.BOOLEAN,
      matchedLabel: T.STRING,
      matchedIndex: T.NUMBER,
    }),

  validate: () =>
    T.objectOf({
      result: T.STRING,
      valid: T.BOOLEAN,
      errors: T.arrayOf(T.objectOf({ path: T.STRING, message: T.STRING })),
      // Whatever was validated — the schema describes it, but the schema is
      // the user's, so this stays dynamic.
      data: T.ANY,
    }),

  'ai-prompt': () => T.objectOf({ text: T.STRING }),
  'ai-classify': () => T.objectOf({ label: T.STRING }),
  'ai-extract': () => T.objectOf({ data: T.ANY }),

  'output-log': () => T.objectOf({ message: T.STRING }),
  'output-return': (node, input) => withFields(input, {}),

  // A sub-workflow's output is whatever the target workflow returns, so this
  // recurses into that workflow's own graph — see returnTypeOf.
  'sub-workflow': (node, input, ctx) => ctx.subWorkflowType(node.data?.config?.workflowId),

  // For-each runs the target workflow once per item, so `results` is a list of
  // whatever that workflow returns — the same resolution the sub-workflow rule
  // makes, one level of array out.
  'for-each': (node, input, ctx) =>
    T.objectOf({
      count: T.NUMBER,
      succeeded: T.NUMBER,
      failed: T.NUMBER,
      results: T.arrayOf(ctx.subWorkflowType(node.data?.config?.workflowId)),
      errors: {
        type: T.arrayOf(T.objectOf({ index: T.NUMBER, error: T.STRING })),
        optional: true,
      },
    }),

  approval: () =>
    T.objectOf({
      result: T.BOOLEAN,
      outcome: T.STRING,
      respondedBy: { type: T.unionOf([T.STRING, T.NULL]), optional: true },
      note: { type: T.unionOf([T.STRING, T.NULL]), optional: true },
      simulated: { type: T.BOOLEAN, optional: true },
    }),

  'wait-callback': () =>
    T.objectOf({
      result: T.STRING,
      payload: T.ANY,
      receivedAt: { type: T.STRING, optional: true },
      simulated: { type: T.BOOLEAN, optional: true },
    }),
}

function isBlank(value) {
  return value == null || (typeof value === 'string' && value.trim() === '')
}

// An object type carrying `base`'s fields plus `extra`. A dynamic base can't be
// enumerated, so the result stays open.
function withFields(base, extra) {
  const merged = T.mergeAssign([{ type: base, certain: true }])
  for (const [name, type] of Object.entries(extra)) {
    merged.fields[name] = { type, optional: false }
  }
  return merged
}

// The FXL scope a per-item node (Filter / Map / Aggregate) evaluates against:
// the item's own fields directly, plus `item`, `index`, and `items`. Closed
// only when the element type is a closed object — otherwise a field we failed
// to infer would look like a typo.
function itemEnv(element) {
  const type = element || T.UNKNOWN
  const spread = type.kind === 'object' ? type.fields : {}
  // A list of strings spreads no fields at all, so `price > 10` over one is a
  // provable mistake — but only once we actually know the element type. An
  // element we couldn't infer leaves the scope open and every check silent.
  const open = T.isDynamic(type) ? true : type.kind === 'object' ? type.open : false
  return {
    kind: 'object',
    fields: {
      ...spread,
      item: { type, optional: false },
      index: { type: T.NUMBER, optional: false },
      items: { type: T.arrayOf(type), optional: false },
    },
    open,
  }
}

// The FXL scope a condition / switch evaluates against: the merged input's
// fields directly, plus `input` aliasing the whole bag.
function inputEnv(input) {
  if (T.isDynamic(input) || input.kind !== 'object') {
    return T.objectOf({ input: input || T.UNKNOWN }, { open: true })
  }
  return {
    kind: 'object',
    fields: { ...input.fields, input: { type: input, optional: false } },
    open: input.open,
  }
}

// The element type of a list-shaped node's source config: a `{{…}}` reference
// to an array, a JSON array literal, or nothing we can name.
function sourceElement(node, input, ctx) {
  const source = node.data?.config?.source ?? node.data?.config?.items
  if (isBlank(source)) return T.UNKNOWN
  if (typeof source === 'string') {
    const exact = source.match(EXACT_PLACEHOLDER)
    if (exact) {
      const resolved = ctx.refType(exact[1])
      return resolved.kind === 'array' ? resolved.element : T.UNKNOWN
    }
    const trimmed = source.trim()
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed)
        if (Array.isArray(parsed)) return T.joinAll(parsed.map(typeOfValue))
      } catch {
        /* not a literal list — nothing to infer */
      }
    }
    return T.UNKNOWN
  }
  if (Array.isArray(source)) return T.joinAll(source.map(typeOfValue))
  return T.UNKNOWN
}

// A Transform node returns its template verbatim, so the template *is* the
// schema — the one place in the product where a user writes an output shape
// down. Parse it and read the types off it: an exact `{{ref}}` keeps the
// referenced type, interpolation yields a string, literals type themselves.
function transformOutput(node, input, ctx) {
  const template = node.data?.config?.template
  if (isBlank(template)) return withFields(input, {})
  if (typeof template === 'object') return templateValueType(template, ctx)
  try {
    return templateValueType(JSON.parse(String(template)), ctx)
  } catch {
    // An unparseable template is wrapped by the runner as { value: <the text> }.
    return T.objectOf({ value: T.STRING })
  }
}

function templateValueType(value, ctx) {
  if (typeof value === 'string') {
    const exact = value.match(EXACT_PLACEHOLDER)
    if (exact) return ctx.refType(exact[1])
    return T.STRING
  }
  if (Array.isArray(value)) return T.arrayOf(T.joinAll(value.map((v) => templateValueType(v, ctx))))
  if (value && typeof value === 'object') {
    const shape = {}
    for (const [k, v] of Object.entries(value)) shape[k] = templateValueType(v, ctx)
    return T.objectOf(shape)
  }
  return typeOfValue(value)
}

// The rule for a node type, falling back to the trigger rule for every
// `trigger-*` and to "nothing known" for a type we have no contract for.
function outputRule(type) {
  if (typeof type === 'string' && type.startsWith('trigger-')) return OUTPUT_RULES.trigger
  return OUTPUT_RULES[type] || null
}

// Which FXL fields a node carries, and the environment each is evaluated in.
// Returns [{ field, source, env }].
function expressionFields(node, input, ctx) {
  const config = node.data?.config || {}
  switch (node.type) {
    case 'condition':
      return config.operator === 'expression' && !isBlank(config.expression)
        ? [{ field: 'the condition expression', source: config.expression, env: inputEnv(input) }]
        : []
    case 'switch': {
      const cases = Array.isArray(config.cases) ? config.cases : []
      const env = inputEnv(input)
      return cases
        .filter((c) => !isBlank(c?.expression))
        .map((c, i) => ({
          field: c?.label ? `case "${String(c.label).trim()}"` : `case ${i + 1}`,
          source: c.expression,
          env,
        }))
    }
    case 'filter': {
      if (isBlank(config.predicate)) return []
      return [
        {
          field: 'the filter predicate',
          source: config.predicate,
          env: itemEnv(sourceElement(node, input, ctx)),
        },
      ]
    }
    case 'map': {
      if (isBlank(config.mapping)) return []
      return [
        {
          field: 'the map expression',
          source: config.mapping,
          env: itemEnv(sourceElement(node, input, ctx)),
        },
      ]
    }
    case 'aggregate': {
      const env = itemEnv(sourceElement(node, input, ctx))
      const fields = []
      if (!isBlank(config.value)) {
        fields.push({ field: 'the value expression', source: config.value, env })
      }
      if (!isBlank(config.groupBy)) {
        fields.push({ field: 'the group-by expression', source: config.groupBy, env })
      }
      return fields
    }
    default:
      return []
  }
}

// — the pass ————————————————————————————————————————————————————————————

// How deep sub-workflow resolution will recurse. Bounded rather than
// unbounded-with-a-cycle-guard alone, because a legitimately deep call tree is
// still work done on every lint of every keystroke — and past a few levels the
// answer is `unknown` in practice anyway.
const MAX_SUBWORKFLOW_DEPTH = 3

// The type a workflow's run returns, mirroring the engine's own rule exactly:
// the output-return node's output when the graph has one, otherwise the last
// node in execution order that produced anything, otherwise `{}`. Getting this
// wrong in either direction would be worse than not resolving it at all, so it
// is one function rather than an approximation at each call site.
function returnTypeOf({ order, outputs }, nodeById) {
  const returnId = order.find((id) => nodeById[id]?.type === 'output-return')
  if (returnId && outputs[returnId]) return outputs[returnId]
  for (let i = order.length - 1; i >= 0; i--) {
    if (outputs[order[i]]) return outputs[order[i]]
  }
  return T.objectOf({})
}

// Infer every node's input and output type, and report what that makes
// checkable. Options:
//
//   resolveWorkflow(id) → { nodes, edges } | null
//     Look up another workflow's graph, so a sub-workflow node can be typed
//     from what its target actually returns. Omitted (the default) leaves
//     those nodes `unknown`, which is what keeps this module usable without a
//     database — the caller supplies the lookup, exactly as the policy engine's
//     document builder does.
//
//   callStack — workflow ids already being inferred, for the cycle guard.
//               Callers don't pass this; the recursion does.
//
// Returns { order, inputs, outputs, diagnostics } where diagnostics are
// `{ severity, code, message, nodeId, field?, position? }`. A graph that can't
// be ordered (a cycle) yields no types and no diagnostics — the linter already
// reports the cycle, and inference over a cycle would be fiction.
function inferGraphTypes(
  { nodes: rawNodes = [], edges: rawEdges = [] } = {},
  { resolveWorkflow = null, callStack = [], depth = 0 } = {}
) {
  const noteIds = new Set(rawNodes.filter((n) => n.type === 'note').map((n) => n.id))
  const nodes = rawNodes.filter((n) => !noteIds.has(n.id))
  const nodeIds = new Set(nodes.map((n) => n.id))
  const edges = rawEdges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))
  const nodeById = Object.fromEntries(nodes.map((n) => [n.id, n]))

  const empty = { order: [], inputs: {}, outputs: {}, diagnostics: [] }
  if (nodes.length === 0) return empty

  let order
  try {
    const { adj, inDegree } = buildAdjacency(nodes, edges)
    order = topoSort(nodes, adj, inDegree)
  } catch {
    return empty
  }

  const incomingByNode = {}
  for (const id of nodeIds) incomingByNode[id] = []
  for (const e of edges) incomingByNode[e.target].push(e)

  const outputs = {}
  // What a node's *normal* outgoing edges carry, which is not always what
  // `{{node.field}}` sees — see the on-error handling below.
  const normalOutputs = {}
  const inputs = {}
  const diagnostics = []

  // Does this node definitely execute when the run reaches this region of the
  // graph? A root always runs; anything else runs when at least one of its
  // incoming edges is *always* active. An edge is always active only when its
  // source always runs and routes unconditionally — a branching node picks one
  // handle, and an on-error `branch` policy makes both the normal and the error
  // handle conditional on how the node settled.
  //
  // Computed in topological order below, so a source's answer is always ready
  // before the edges leaving it are asked about.
  const certainNode = {}
  const edgeAlwaysActive = (e) => {
    const source = nodeById[e.source]
    if (!certainNode[e.source]) return false
    if (e.sourceHandle === 'error') return false
    if (BRANCHING_TYPES.has(source?.type)) return false
    return errorPolicy(source) !== 'branch'
  }

  // What actually travels an edge, which the on-error policies make more
  // interesting than "the source's output":
  //
  //   * `branch` — the error handle carries the engine's error object and
  //     nothing else, while the normal handles stay dark on a caught failure
  //     and therefore carry only the node's own shape.
  //   * `continue` — there is no error handle; the normal edges carry whichever
  //     of the two the node settled, so they carry the union.
  const edgePayload = (e) => {
    const source = nodeById[e.source]
    const policy = errorPolicy(source)
    if (policy === 'branch') {
      return e.sourceHandle === 'error'
        ? CAUGHT_ERROR
        : normalOutputs[e.source] || T.UNKNOWN
    }
    return outputs[e.source] || T.UNKNOWN
  }

  // A `{{path}}` reference's type. Reserved heads resolve to what the engine
  // substitutes (secrets, variables, and callback URLs are all strings);
  // anything else is a node id, looked up in what we've inferred so far.
  function refType(path) {
    const [head, ...rest] = String(path).split('.')
    if (head === 'secrets' || head === 'vars' || head === 'callbacks') return T.STRING
    const produced = outputs[head]
    if (!produced) return T.UNKNOWN
    const resolved = T.lookupPath(produced, rest, 'template')
    return resolved.exists === 'no' ? T.UNKNOWN : resolved.type
  }

  // The type a sub-workflow (or for-each) node's target returns.
  //
  // Three refusals, and each is the honest answer rather than a limitation:
  // a target already on the call stack is a cycle — the engine rejects that at
  // run time and the dependency analyser reports it statically, so producing a
  // type for it would be inventing one; past the depth cap the analysis stops
  // rather than walking an arbitrary call tree on every keystroke; and a target
  // the caller can't resolve (deleted, another workspace, undeployed) is a lint
  // error elsewhere, not a shape.
  const subWorkflowCache = new Map()
  function subWorkflowType(targetId) {
    if (!targetId || !resolveWorkflow) return T.UNKNOWN
    if (subWorkflowCache.has(targetId)) return subWorkflowCache.get(targetId)
    if (callStack.includes(targetId) || depth >= MAX_SUBWORKFLOW_DEPTH) return T.UNKNOWN

    let resolved = T.UNKNOWN
    try {
      const graph = resolveWorkflow(targetId)
      if (graph) {
        const inner = inferGraphTypes(graph, {
          resolveWorkflow,
          callStack: [...callStack, targetId],
          depth: depth + 1,
        })
        const innerNodes = Object.fromEntries((graph.nodes || []).map((n) => [n.id, n]))
        resolved = returnTypeOf(inner, innerNodes)
      }
    } catch {
      // A target that can't be read types as unknown, like any other value the
      // analysis has nothing to say about.
      resolved = T.UNKNOWN
    }
    subWorkflowCache.set(targetId, resolved)
    return resolved
  }

  // Type an FXL source, folding its diagnostics into the caller's list.
  function makeExprTyper(nodeId, fieldLabel) {
    return (source, env) => {
      if (isBlank(source)) return T.UNKNOWN
      let ast
      try {
        ast = parse(String(source))
      } catch (err) {
        // A syntax error is the linter's `invalid-expression`, already
        // reported there — typing it again would double the message.
        if (err instanceof ExpressionError) return T.UNKNOWN
        throw err
      }
      const { type, diagnostics: found } = checkTypes(ast, env)
      for (const d of found) {
        diagnostics.push({
          severity: d.severity,
          code: 'type-error',
          detail: d.code,
          message: `${fieldLabel}: ${d.message}`,
          nodeId,
          position: d.position,
        })
      }
      return type
    }
  }

  for (const nodeId of order) {
    const node = nodeById[nodeId]
    const incoming = incomingByNode[nodeId] || []

    certainNode[nodeId] = incoming.length === 0 || incoming.some(edgeAlwaysActive)

    // The node's input is what the engine builds: Object.assign over the
    // outputs of its *active* upstream edges. Certainty here is conditional on
    // this node running at all — which is why a single incoming edge is always
    // certain (if the node is executing, that edge is how it got there) while
    // one of several is certain only when it can never be dark.
    const contributions = incoming.map((e) => ({
      type: edgePayload(e),
      certain: incoming.length === 1 || edgeAlwaysActive(e),
    }))

    let input
    if (node.type.startsWith('trigger-') || incoming.length === 0) {
      // A trigger starts from the run's payload, which nobody typed — and a
      // node nobody has wired yet has no established input either. Both are
      // open, so a half-built canvas doesn't fill with findings about data the
      // author hasn't connected up.
      input = OPEN_OBJECT
    } else {
      input = T.mergeAssign(contributions)
    }
    inputs[nodeId] = input

    const ctx = { refType, subWorkflowType, exprType: makeExprTyper(nodeId, 'expression') }

    // Type the node's FXL fields first: `map`'s output depends on the type its
    // mapping expression computes, so the expressions have to be walked before
    // the output rule runs. Each field gets its own label for the message.
    let mappedTypeSource = null
    for (const { field, source, env } of expressionFields(node, input, ctx)) {
      const typed = makeExprTyper(nodeId, field)(source, env)
      if (node.type === 'map') mappedTypeSource = typed
    }

    const rule = outputRule(node.type)
    let output = rule
      ? rule(node, input, {
          refType,
          subWorkflowType,
          // The map rule re-types its mapping; reuse the value already computed
          // so the diagnostics aren't emitted twice.
          exprType: () => (mappedTypeSource === null ? T.UNKNOWN : mappedTypeSource),
        })
      : T.UNKNOWN

    // A node whose failure is caught — under *either* policy — settles the
    // engine's `{ failed, error }` object as its context value instead of its
    // own shape, so `{{node.error.message}}` is a legitimate reference on any
    // catching node. The policies differ only in which *edges* activate, which
    // `edgePayload` handles: the union below is what a reference sees, and
    // `normalOutputs` is what a non-error edge carries.
    normalOutputs[nodeId] = output
    if (errorPolicy(node) !== 'fail') output = T.join(output, CAUGHT_ERROR)

    outputs[nodeId] = output

    // Field-level checking of every {{…}} reference in the node's config.
    checkReferences(node, { outputs, nodeIds, diagnostics })
  }

  return { order, inputs, outputs, diagnostics }
}

// The engine reads a node's on-error policy from its *raw* config (upstream
// data must never decide routing), and ignores it on types whose failure can't
// be caught. Mirrored here so the inferred types match what actually happens.
const UNCATCHABLE = new Set(['condition', 'switch', 'validate', 'approval', 'wait-callback'])
function errorPolicy(node) {
  if (!node || typeof node.type !== 'string') return 'fail'
  if (node.type.startsWith('trigger-') || UNCATCHABLE.has(node.type)) return 'fail'
  const policy = node.data?.config?.onError
  return policy === 'continue' || policy === 'branch' ? policy : 'fail'
}

// Walk a node's config for `{{node.a.b}}` references and check the path against
// the referenced node's inferred output. Only a *definitely absent* field is
// reported: an open shape, a dynamic value, or a node we couldn't type is
// silent, and a head that isn't a node at all is the linter's own
// `unknown-node-ref`.
function checkReferences(node, { outputs, nodeIds, diagnostics }) {
  const seen = new Set()
  const walk = (value) => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(PLACEHOLDER)) {
        const path = match[1]
        if (seen.has(path)) continue
        seen.add(path)
        const [head, ...rest] = path.split('.')
        // Scope heads that aren't nodes: workspace secrets and variables, a
        // wait-callback's minted URL, and — inside a compensating node — the
        // failure that caused the rollback.
        if (head === 'secrets' || head === 'vars' || head === 'callbacks' || head === 'rollback') {
          continue
        }
        if (!nodeIds.has(head) || rest.length === 0) continue
        const produced = outputs[head]
        if (!produced) continue
        const resolved = T.lookupPath(produced, rest, 'template')
        if (resolved.exists !== 'no') continue
        const missing = rest[resolved.failedAt]
        const available = T.fieldNames(resolved.container)
        const hint = T.suggest(missing, available)
        const where = resolved.failedAt === 0 ? head : `${head}.${rest.slice(0, resolved.failedAt).join('.')}`
        diagnostics.push({
          severity: 'error',
          code: 'unknown-field',
          message:
            `${label(node)}: {{${path}}} — ${where} is ${T.describe(resolved.container)}` +
            ` and has no "${missing}"` +
            (hint ? `; did you mean "${hint}"?` : ''),
          nodeId: node.id,
        })
      }
    } else if (Array.isArray(value)) {
      value.forEach(walk)
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(walk)
    }
  }
  walk(node.data?.config || {})
}

function label(node) {
  return node.data?.label || node.id
}

// A serialisable view of the inference, for the API and the canvas data picker:
// each node's input/output type plus a rendered description and its field list.
function describeGraphTypes(graph, options = {}) {
  const { order, inputs, outputs, diagnostics } = inferGraphTypes(graph, options)
  const nodes = {}
  for (const nodeId of order) {
    nodes[nodeId] = {
      input: { type: inputs[nodeId], described: T.describe(inputs[nodeId]) },
      output: {
        type: outputs[nodeId],
        described: T.describe(outputs[nodeId]),
        fields: fieldSummary(outputs[nodeId]),
      },
    }
  }
  return { order, nodes, diagnostics }
}

// Flatten an output type into the pickable `{{node.path}}` references it
// offers, one level deep past each object so the picker can show `body.total`
// without unfolding an entire tree.
function fieldSummary(type, prefix = '', depth = 0) {
  const t = type || T.UNKNOWN
  if (t.kind !== 'object' || depth > 1) return []
  const out = []
  for (const [name, spec] of Object.entries(t.fields)) {
    const path = prefix ? `${prefix}.${name}` : name
    out.push({ path, type: T.describe(spec.type), optional: spec.optional })
    out.push(...fieldSummary(spec.type, path, depth + 1))
  }
  return out
}

module.exports = {
  inferGraphTypes,
  describeGraphTypes,
  // Exported for the linter's compensation pass. A compensating node sits
  // outside the DAG — it has no upstream, so it cannot be *inferred* — but it
  // reads the outputs of nodes that are in the DAG, and those were just typed.
  // Running this against the finished output table is what keeps
  // `{{charge-card.chrgId}}` inside a refund node as much of a lint error as it
  // would be anywhere else.
  checkReferences,
  returnTypeOf,
  typeOfValue,
  itemEnv,
  inputEnv,
  fieldSummary,
  OUTPUT_RULES,
  BRANCHING_TYPES,
  CAUGHT_ERROR,
  MAX_SUBWORKFLOW_DEPTH,
}
