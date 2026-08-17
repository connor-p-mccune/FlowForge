// Data lineage and taint analysis over a workflow graph.
//
// `workflowDependencies.js` answers "which workflow calls which?" and
// `typeInference.js` answers "what shape is this value?". Neither answers the
// question people actually ask about a graph they did not write:
//
//     Where does this value come from, and where does it end up?
//
// A canvas hides that. `{{http-1.body.email}}` appearing in a Send Email node
// tells you the field's name and nothing about its provenance — which trigger
// field it started as, which nodes reshaped it, whose API supplied it. Six
// nodes later nobody can reconstruct the path, and the two questions that
// matter are both unanswerable: *if I change this, what breaks?* and *is
// anything reaching that URL controlled by whoever sends the webhook?*
//
// This module recovers the dataflow the same way the type checker recovers the
// shapes — one pass over the DAG, reading exactly what the engine reads. Three
// things fall out of it.
//
// **Provenance and impact.** Every node gets a set of *origins* — the places
// its output data can have come from — and a set of *reads*, the specific
// `{{node.path}}` references its config makes. Together those form a second
// graph over the first, at field granularity where the reference is a field
// reference, and the two directions of it are the two questions above.
//
// **Taint.** Some origins are controlled by someone outside the workspace: a
// webhook body is written by whoever holds the URL, an HTTP response is written
// by the service that answered, a callback payload by whoever was handed the
// token. Some config fields are *sinks* where data leaves — the address a
// request goes to, the recipient of an email, the Slack webhook a message is
// posted to, which workflow a sub-workflow node runs. Untrusted data reaching a
// high-sensitivity sink is server-side request forgery with a drag-and-drop
// interface, and it lints exactly like a syntax error would.
//
// **Dead computation.** A node whose output no expression and no template ever
// references computed something for nobody. Usually harmless; on an AI node it
// is a bill.
//
// The analysis is built on the same refusal to guess that the type system is.
// Where a runner's contract makes attribution per-field, it is per-field; where
// it doesn't, it is per-node and says so. Where a node's output genuinely does
// not derive from its inputs — an HTTP node's `body` is the far side's answer,
// not a function of the URL it was asked for — taint deliberately does **not**
// propagate through it, because claiming otherwise would mark half of every
// graph and train people to ignore the finding.

const { buildAdjacency, topoSort } = require('./dagParser')
const { compensationPlan } = require('./compensation')

const PLACEHOLDER = /\{\{\s*([\w-]+(?:\.[\w-]+)*)\s*\}\}/g

// — where data comes from ————————————————————————————————————————————————
//
// `trust` is the axis the taint check reads. It is a three-way split rather
// than a boolean because the distinctions are real and collapsing them would
// either cry wolf or miss the case that matters:
//
//   untrusted    anyone who can reach the endpoint writes this
//   external     a system outside FlowForge wrote it — a third party, not an
//                attacker, but not the workflow's author either
//   internal     the workspace produced it: authored config, a variable, a
//                secret, a member's manual input
const ORIGIN_KINDS = {
  webhook: {
    trust: 'untrusted',
    label: 'the webhook payload',
    detail: 'written by whoever holds the trigger URL',
  },
  callback: {
    trust: 'untrusted',
    label: 'a callback payload',
    detail: 'written by whoever was handed the one-time URL',
  },
  response: {
    trust: 'external',
    label: 'an HTTP response',
    detail: 'written by the service that answered',
  },
  model: {
    trust: 'external',
    label: 'a model response',
    detail: 'generated text, not a value the workflow chose',
  },
  manual: { trust: 'internal', label: 'a manual run’s input' },
  schedule: { trust: 'internal', label: 'the schedule' },
  secret: { trust: 'internal', label: 'a workspace secret' },
  variable: { trust: 'internal', label: 'a workspace variable' },
  config: { trust: 'internal', label: 'authored config' },
  unknown: { trust: 'unknown', label: 'a sub-workflow’s return' },
}

// Node types whose output is *not* a function of their input, and what wrote it
// instead. Taint stops at these: an HTTP node asked a question and recorded the
// answer, so its `body` carries the far side's trust level rather than the
// URL's. Propagating the request's taint into the response would mark most of a
// typical graph and make the finding worthless.
const INTRINSIC_ORIGINS = {
  'action-http': 'response',
  'ai-prompt': 'model',
  'ai-classify': 'model',
  'ai-extract': 'model',
  'wait-callback': 'callback',
  'sub-workflow': 'unknown',
  'for-each': 'unknown',
}

const TRIGGER_ORIGINS = {
  'trigger-webhook': 'webhook',
  'trigger-manual': 'manual',
  'trigger-schedule': 'schedule',
}

// A Transform node's output is built entirely from its template's `{{…}}`
// references — it never merges its input — so its origins are exactly its
// reads. Listing it explicitly (rather than defaulting) is what keeps
// `{{trigger.x}}` → Transform → HTTP url reported and a Transform over literals
// silent.
const REFS_ONLY_TYPES = new Set(['transform', 'output-log'])

// — where data goes ——————————————————————————————————————————————————————
//
// A sink is a config field whose value leaves FlowForge. `sensitivity` is about
// what an attacker gains by controlling it, not about how secret the data is:
// controlling a request's *URL* redirects the call, which is categorically
// worse than controlling a line of its body.
const SINKS = {
  'action-http': [
    { key: 'url', kind: 'http-url', sensitivity: 'high', what: 'the address this request is sent to' },
    { key: 'headers', kind: 'http-headers', sensitivity: 'high', what: 'the request’s headers' },
    { key: 'body', kind: 'http-body', sensitivity: 'medium', what: 'the request body' },
  ],
  'action-email': [
    { key: 'to', kind: 'email-recipient', sensitivity: 'high', what: 'who this email is sent to' },
    { key: 'body', kind: 'email-body', sensitivity: 'medium', what: 'the email body' },
    { key: 'subject', kind: 'email-subject', sensitivity: 'low', what: 'the subject line' },
  ],
  'action-slack': [
    { key: 'webhookUrl', kind: 'slack-webhook', sensitivity: 'high', what: 'the Slack webhook posted to' },
    { key: 'text', kind: 'slack-message', sensitivity: 'low', what: 'the message text' },
  ],
  'sub-workflow': [
    { key: 'workflowId', kind: 'workflow-target', sensitivity: 'high', what: 'which workflow runs' },
  ],
  'for-each': [
    { key: 'workflowId', kind: 'workflow-target', sensitivity: 'high', what: 'which workflow runs' },
  ],
  'output-log': [
    { key: 'message', kind: 'log', sensitivity: 'low', what: 'the log line' },
  ],
}

// — where instructions come from ————————————————————————————————————————
//
// Config fields that end up inside an LLM's prompt. Not listed as sinks, and the
// distinction is the point: a sink is where data *leaves*, and the risk there is
// that a caller chooses the destination. Here the data stays, and the risk is
// that a caller chooses the *instructions* — the model becomes a confused deputy
// acting on text an outsider wrote.
//
// `control` says what an injection can reach if it succeeds, which is what makes
// the three cases worth telling apart rather than reporting as one:
//
//   arbitrary  free text, which then flows onward as data
//   bounded    one of the labels the author declared (the AI service refuses
//              anything else), so an injection can only pick a different one
//   shape      the values of the fields the author declared
const PROMPT_FIELDS = {
  'ai-prompt': [
    { key: 'prompt', control: 'arbitrary' },
    { key: 'system', control: 'arbitrary' },
  ],
  'ai-classify': [{ key: 'text', control: 'bounded' }],
  'ai-extract': [{ key: 'text', control: 'shape' }],
}

const CONTROL_TEXT = {
  arbitrary: 'and its reply is free text',
  bounded: 'and it chooses which of this node’s labels is returned',
  shape: 'and it steers the values this node extracts',
}

// Node types whose whole purpose is to route a run. A model answer reaching one
// of these decides which branch executes, which is the second half of the
// confused-deputy problem — the first half being that an outsider wrote the
// prompt.
const ROUTING_TYPES = new Set(['condition', 'switch', 'validate'])

// Node types that exist to compute a value for something else to use. A node
// here whose output is never referenced did work nobody consumes — which is
// worth saying, and is a bill rather than a curiosity on an AI node. Deliberately
// excludes side-effecting types (the call *is* the point, its return value is
// incidental) and routing types (their effect is on the graph, not on data).
const COMPUTING_TYPES = new Set([
  'transform', 'filter', 'map', 'aggregate',
  'ai-prompt', 'ai-classify', 'ai-extract',
  'sub-workflow', 'for-each',
])

function label(node) {
  return node?.data?.label || node?.id
}

// Every `{{…}}` reference in a value, as { head, path }. `where` names the
// config key it was found under, so a sink can report which field carried it.
function collectRefs(value, where, out) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(PLACEHOLDER)) {
      const [head, ...rest] = match[1].split('.')
      out.push({ head, path: rest, where, raw: match[1] })
    }
  } else if (Array.isArray(value)) {
    value.forEach((v) => collectRefs(v, where, out))
  } else if (value && typeof value === 'object') {
    // `where` stays the *top-level* config key all the way down: a reference
    // buried inside a JSON headers object is still "in the headers", which is
    // the granularity a sink is defined at.
    for (const v of Object.values(value)) collectRefs(v, where, out)
  }
  return out
}

function configRefs(node) {
  const config = node?.data?.config || {}
  const out = []
  for (const [key, value] of Object.entries(config)) collectRefs(value, key, out)
  return out
}

// Does this node's output carry its *input* forward? The engine merges every
// active upstream output into a node's input with Object.assign, and most
// runners spread that input into their result — so unless a type declares
// otherwise, upstream data reaches downstream whether or not anything
// referenced it by name.
function consumesInput(nodeType) {
  return !(nodeType in INTRINSIC_ORIGINS) && !REFS_ONLY_TYPES.has(nodeType)
}

// The core pass: one topological walk giving every node the set of origins its
// output can carry.
//
// Compensating nodes are analysed too, but they sit outside the DAG — they run
// after the fact and read the whole graph — so they are appended after the walk
// with their reads resolved against the finished table. A refund node that
// forwards a webhook field to a payment API is exactly as interesting as one in
// the main flow, and skipping it would leave a hole in precisely the node type
// where being wrong is most expensive.
function analyzeLineage({ nodes: rawNodes = [], edges: rawEdges = [] } = {}) {
  const noteIds = new Set(rawNodes.filter((n) => n.type === 'note').map((n) => n.id))
  const notelessNodes = rawNodes.filter((n) => !noteIds.has(n.id))
  const plan = compensationPlan(notelessNodes)

  const flowNodes = notelessNodes.filter((n) => !plan.compensationIds.has(n.id))
  const compensationNodes = notelessNodes.filter((n) => plan.compensationIds.has(n.id))
  const edges = rawEdges.filter(
    (e) =>
      !noteIds.has(e.source) && !noteIds.has(e.target) &&
      !plan.compensationIds.has(e.source) && !plan.compensationIds.has(e.target)
  )

  const byId = new Map(notelessNodes.map((n) => [n.id, n]))
  const incoming = new Map(flowNodes.map((n) => [n.id, []]))
  // Immediate graph successors. Needed for exactly one thing — see the
  // confused-deputy finding — because a routing node reads its *merged input*
  // rather than naming a `{{…}}` reference, so the read graph cannot see the
  // edge that carries a model's answer into a condition.
  const successors = new Map(flowNodes.map((n) => [n.id, []]))
  const outDegree = new Map(flowNodes.map((n) => [n.id, 0]))
  for (const e of edges) {
    if (incoming.has(e.target)) incoming.get(e.target).push(e.source)
    if (successors.has(e.source)) successors.get(e.source).push(e.target)
    if (outDegree.has(e.source)) outDegree.set(e.source, outDegree.get(e.source) + 1)
  }

  let order
  try {
    const { adj, inDegree } = buildAdjacency(flowNodes, edges)
    order = topoSort(flowNodes, adj, inDegree)
  } catch {
    // A cyclic graph has no dataflow to report — the linter already owns that
    // failure, and inventing an order here would produce confident nonsense.
    return { ok: false, reason: 'cycle', nodes: {}, findings: [], sinks: [], secrets: {} }
  }

  const info = {} // nodeId -> { origins:Set, reads:[], scopeReads:[] }
  const readBy = new Map() // nodeId -> Set(nodeId) — who references this node

  function record(node, { upstream = [] } = {}) {
    const refs = configRefs(node)
    const origins = new Set()
    const reads = []
    const scopeReads = []

    for (const ref of refs) {
      if (ref.head === 'secrets') {
        scopeReads.push({ kind: 'secret', name: ref.path[0] ?? null, where: ref.where })
        origins.add('secret')
        continue
      }
      if (ref.head === 'vars') {
        scopeReads.push({ kind: 'variable', name: ref.path[0] ?? null, where: ref.where })
        origins.add('variable')
        continue
      }
      if (ref.head === 'callbacks' || ref.head === 'rollback') continue
      if (!byId.has(ref.head)) continue
      reads.push({ nodeId: ref.head, path: ref.path, where: ref.where, raw: ref.raw })
      if (!readBy.has(ref.head)) readBy.set(ref.head, new Set())
      readBy.get(ref.head).add(node.id)
    }

    const intrinsic = INTRINSIC_ORIGINS[node.type] ?? TRIGGER_ORIGINS[node.type]
    if (intrinsic) {
      // The node's output is written by something outside the graph, so it
      // carries that one origin and nothing it read.
      origins.clear()
      origins.add(intrinsic)
    } else {
      for (const read of reads) {
        for (const o of info[read.nodeId]?.origins || []) origins.add(o)
      }
      if (consumesInput(node.type)) {
        for (const up of upstream) {
          for (const o of info[up]?.origins || []) origins.add(o)
        }
      }
      if (origins.size === 0) origins.add('config')
    }

    info[node.id] = {
      origins,
      reads,
      scopeReads,
      type: node.type,
      label: label(node),
      // A compensation is never a leaf in the sense the dead-computation check
      // means: it deliberately has no outgoing edge, and its value is the side
      // effect it causes rather than a result something downstream consumes.
      isLeaf: (outDegree.get(node.id) ?? 0) === 0 && !plan.compensationIds.has(node.id),
    }
  }

  for (const nodeId of order) {
    record(byId.get(nodeId), { upstream: incoming.get(nodeId) || [] })
  }
  // Compensations run after everything, so every node in the graph is upstream
  // of them in the only sense that matters here.
  for (const node of compensationNodes) record(node, { upstream: order })

  return {
    ok: true,
    order,
    nodes: info,
    readBy,
    sinks: collectSinks(byId, info),
    findings: findings(byId, info, readBy, successors),
    secrets: secretReach(byId, info),
  }
}

// Does a URL template let a reference decide *which host* is contacted?
//
// This distinction is the difference between a useful taint check and one
// nobody reads. `https://api.acme.com/orders/{{trigger.id}}` is the normal,
// correct way to build a request — the destination is pinned by the author and
// only a path segment varies. `{{trigger.url}}` and `https://{{trigger.host}}/x`
// are server-side request forgery: whoever sends the webhook chooses what the
// server connects to, which is how an internal metadata endpoint gets read.
//
// So only a dynamic *authority* counts as high sensitivity. Everything before
// the first `/`, `?` or `#` after the scheme decides the destination; a
// reference anywhere in there — including one standing in for the scheme
// itself — makes the target the caller's choice.
function dynamicAuthority(template) {
  const url = String(template ?? '')
  const schemeEnd = url.indexOf('://')
  if (schemeEnd === -1) {
    // No scheme at all: a bare `{{vars.BASE_URL}}/x` or `{{trigger.url}}` could
    // resolve to anything, so the whole string decides the destination.
    return url.includes('{{')
  }
  if (url.slice(0, schemeEnd).includes('{{')) return true
  const rest = url.slice(schemeEnd + 3)
  const end = rest.search(/[/?#]/)
  return (end === -1 ? rest : rest.slice(0, end)).includes('{{')
}

// Every sink in the graph, with the origins that actually reach it. A sink with
// no `{{…}}` reference in its field is a constant and is omitted: the author
// typed it, so there is nothing to trace.
function collectSinks(byId, info) {
  const out = []
  for (const [nodeId, node] of byId) {
    for (const rawSpec of SINKS[node.type] || []) {
      const carried = (info[nodeId]?.reads || []).filter((r) => r.where === rawSpec.key)
      if (carried.length === 0) continue

      // An HTTP URL whose host is pinned by the author cannot be redirected, so
      // it drops out of the high band: what remains is path/query influence,
      // which is worth recording in the lineage but is not the finding this
      // check exists for. (Slack's webhook URL is deliberately *not* softened
      // the same way — for Slack the path is the credential.)
      const spec =
        rawSpec.kind === 'http-url' && !dynamicAuthority(node.data?.config?.url)
          ? { ...rawSpec, sensitivity: 'medium', what: 'the path or query of this request' }
          : rawSpec
      const origins = new Set()
      for (const read of carried) {
        for (const o of info[read.nodeId]?.origins || []) origins.add(o)
      }
      out.push({
        nodeId,
        label: label(node),
        nodeType: node.type,
        key: spec.key,
        kind: spec.kind,
        sensitivity: spec.sensitivity,
        what: spec.what,
        via: carried.map((r) => r.raw),
        origins: [...origins],
      })
    }
  }
  return out
}

// AI nodes whose prompt is built from data somebody outside the workspace wrote.
//
// Only `untrusted` counts here, not `external`, and that is a deliberate
// narrowing rather than an oversight: an HTTP response feeding a prompt is a
// third party's text, not an adversary's *choice* of text, and counting it would
// mark most graphs that use an AI node at all. The confused-deputy story needs
// somebody who picks the words.
function collectPromptReads(byId, info) {
  const out = []
  for (const [nodeId, node] of byId) {
    for (const spec of PROMPT_FIELDS[node.type] || []) {
      const carried = (info[nodeId]?.reads || []).filter((r) => r.where === spec.key)
      if (carried.length === 0) continue
      const untrusted = new Set()
      for (const read of carried) {
        for (const o of info[read.nodeId]?.origins || []) {
          if (ORIGIN_KINDS[o]?.trust === 'untrusted') untrusted.add(o)
        }
      }
      if (untrusted.size === 0) continue
      out.push({
        nodeId,
        label: label(node),
        nodeType: node.type,
        key: spec.key,
        control: spec.control,
        via: carried.map((r) => r.raw),
        origins: [...untrusted],
      })
    }
  }
  return out
}

// Everything downstream that reads this node's output, transitively. The same
// closure `traceImpact` walks — a value's influence, not its taint — because the
// question here is what the model's answer gets to decide.
function influenceOf(nodeId, readBy) {
  const seen = new Set()
  const frontier = [nodeId]
  while (frontier.length > 0) {
    for (const readerId of readBy.get(frontier.shift()) || []) {
      if (seen.has(readerId)) continue
      seen.add(readerId)
      frontier.push(readerId)
    }
  }
  return seen
}

// Which nodes can see which secret. Not a finding — a fact worth surfacing,
// because "who can read STRIPE_KEY?" is a question every workspace eventually
// asks and the answer is otherwise a manual grep of every node's config.
function secretReach(byId, info) {
  const out = {}
  for (const [nodeId] of byId) {
    for (const scope of info[nodeId]?.scopeReads || []) {
      if (scope.kind !== 'secret' || !scope.name) continue
      ;(out[scope.name] ||= []).push({ nodeId, label: info[nodeId].label, where: scope.where })
    }
  }
  return out
}

function issue(severity, code, message, nodeId = null) {
  return { severity, code, message, nodeId }
}

function findings(byId, info, readBy, successors = new Map()) {
  const out = []

  // Taint: something outside the workspace controls a value that decides where
  // data goes. Reported as a warning, never an error, because it is frequently
  // deliberate — a webhook that carries the callback URL to reply to is a real
  // and correct pattern. The message therefore names the *specific* source and
  // what it controls, so the author can recognise their own design in one read
  // rather than being told something is wrong.
  for (const sink of collectSinks(byId, info)) {
    if (sink.sensitivity !== 'high') continue
    const risky = sink.origins.filter(
      (o) => ORIGIN_KINDS[o]?.trust === 'untrusted' || ORIGIN_KINDS[o]?.trust === 'external'
    )
    if (risky.length === 0) continue
    const worst =
      risky.find((o) => ORIGIN_KINDS[o].trust === 'untrusted') || risky[0]
    const spec = ORIGIN_KINDS[worst]
    out.push(
      issue(
        'warning',
        'tainted-sink',
        `${sink.label}: ${sink.what} is built from ${spec.label}` +
          (spec.detail ? ` (${spec.detail})` : '') +
          ` — via ${sink.via.map((v) => `{{${v}}}`).join(', ')}`,
        sink.nodeId
      )
    )
  }

  // The model as a confused deputy. Untrusted data reaching a prompt is not the
  // finding — it is what an AI node in a workflow is *for*, and reporting it
  // would fire on every one of them. The finding is the **composition**: an
  // outsider writes the instructions, *and* the model's answer decides something
  // the workflow then acts on.
  //
  // "Decides something" is read from the forward influence closure — the same one
  // impact analysis walks — and means either a high-sensitivity sink (the address
  // a request goes to, who an email reaches, which workflow runs) or a routing
  // node, whose whole job is to pick a branch. A model answer that only lands in
  // a log line or an email body is a different and much smaller problem, so it is
  // not reported.
  //
  // A warning, like every other finding here: the pattern is legitimate with the
  // containments the AI service applies, and the message's job is to let an
  // author recognise their own design and decide.
  const sinksBySource = new Map()
  for (const sink of collectSinks(byId, info)) {
    if (sink.sensitivity !== 'high') continue
    if (!sinksBySource.has(sink.nodeId)) sinksBySource.set(sink.nodeId, [])
    sinksBySource.get(sink.nodeId).push(sink)
  }
  for (const prompt of collectPromptReads(byId, info)) {
    const influenced = influenceOf(prompt.nodeId, readBy)
    const reachedSinks = [...influenced].flatMap((id) => sinksBySource.get(id) || [])
    // A routing node counts two ways, and the second is why this needs the
    // graph and not just the read edges. A condition that names
    // `{{risk.label}}` is an ordinary read. A condition in *expression* mode
    // reads `label` off its merged input and names nothing, so the read graph is
    // blind to it — and the engine merges only **immediate** predecessors, so an
    // immediate successor is exactly the set where the model's answer is still in
    // scope. Anything further away had to reference it, which the closure above
    // already covers.
    const routers = [
      ...new Set([
        ...[...influenced].filter((id) => ROUTING_TYPES.has(byId.get(id)?.type)),
        ...(successors.get(prompt.nodeId) || []).filter((id) =>
          ROUTING_TYPES.has(byId.get(id)?.type)
        ),
      ]),
    ]
    if (reachedSinks.length === 0 && routers.length === 0) continue

    const decides = reachedSinks.length > 0
      ? `${reachedSinks[0].label}: ${reachedSinks[0].what}`
      : `which branch ${label(byId.get(routers[0]))} takes`
    const spec = ORIGIN_KINDS[prompt.origins[0]]
    out.push(
      issue(
        'warning',
        'prompt-injection',
        `${prompt.label}: this node’s ${prompt.key} is built from ${spec.label}` +
          (spec.detail ? ` (${spec.detail})` : '') +
          `, ${CONTROL_TEXT[prompt.control]} — and that decides ${decides}. ` +
          `Via ${prompt.via.map((v) => `{{${v}}}`).join(', ')}.`,
        prompt.nodeId
      )
    )
  }

  // Dead computation: a node that exists to produce a value, whose value nobody
  // reads.
  //
  // The bar is deliberately high, because the cheap version of this check is
  // wrong rather than merely noisy: a node in the middle of a chain still has
  // its output merged into every downstream node's input by the engine, so
  // "nothing references it by name" does not mean "nothing uses it". Only a
  // **leaf** — no outgoing edge, and no `{{…}}` reference anywhere — provably
  // computed something for nobody.
  for (const [nodeId, node] of byId) {
    if (!COMPUTING_TYPES.has(node.type)) continue
    if (!info[nodeId]?.isLeaf) continue
    if ((readBy.get(nodeId)?.size ?? 0) > 0) continue
    const costly = node.type.startsWith('ai-')
    out.push(
      issue(
        'warning',
        'unread-output',
        `${label(node)}: nothing reads this node’s output and nothing follows it` +
          (costly ? ' — an AI call whose result is never used is a bill' : ''),
        nodeId
      )
    )
  }

  return out
}

// — the two questions ————————————————————————————————————————————————————

// Backwards: what feeds this node? Walks the read edges to their sources,
// depth-first, and reports the chain plus the origins it terminates in. Cycles
// are impossible over a DAG's read edges, but the visited set also collapses
// diamonds so a node fed by two paths from the same trigger is reported once.
function traceProvenance(lineage, nodeId, { depth = 12 } = {}) {
  const seen = new Set()
  const chain = []
  const walk = (id, level) => {
    if (level > depth || seen.has(id)) return
    seen.add(id)
    const node = lineage.nodes[id]
    if (!node) return
    for (const read of node.reads) {
      chain.push({
        from: read.nodeId,
        fromLabel: lineage.nodes[read.nodeId]?.label ?? read.nodeId,
        to: id,
        toLabel: node.label,
        path: read.path.join('.'),
        where: read.where,
        reference: read.raw,
      })
      walk(read.nodeId, level + 1)
    }
  }
  walk(nodeId, 0)
  const self = lineage.nodes[nodeId]

  // "Where does the data this node *uses* come from?" — the origins of what it
  // reads, not of what it emits. Those differ exactly at an external boundary,
  // and the difference is the interesting part: an HTTP node's input traces
  // back to a webhook while its output is the far side's answer. A node that
  // reads nothing is itself a source, so it reports its own.
  const inputOrigins = new Set()
  for (const read of self?.reads || []) {
    for (const o of lineage.nodes[read.nodeId]?.origins || []) inputOrigins.add(o)
  }
  for (const scope of self?.scopeReads || []) {
    inputOrigins.add(scope.kind === 'secret' ? 'secret' : 'variable')
  }
  if (inputOrigins.size === 0) for (const o of self?.origins || []) inputOrigins.add(o)

  const expand = (kinds) => [...kinds].map((kind) => ({ kind, ...ORIGIN_KINDS[kind] }))
  return {
    nodeId,
    label: self?.label ?? nodeId,
    origins: expand(inputOrigins),
    outputOrigins: expand(self?.origins || []),
    secrets: (self?.scopeReads || []).filter((s) => s.kind === 'secret'),
    variables: (self?.scopeReads || []).filter((s) => s.kind === 'variable'),
    chain,
  }
}

// Forwards: what breaks if this node changes? The transitive closure of "reads
// this", which is the honest answer to the question — an implicit merge into a
// downstream input is not an impact until something actually references it.
//
// Note this closure deliberately *does* cross the external boundaries that
// taint stops at, and the asymmetry is correct rather than an oversight.
// Changing a webhook field does not make an HTTP node's response untrusted in
// any new way — the far side always wrote it — but it does change which URL is
// called, so everything downstream of that response really is affected. Taint
// asks "who controls this value's content"; impact asks "what does this value
// participate in deciding". Different questions, different closures.
function traceImpact(lineage, nodeId, { depth = 12 } = {}) {
  const seen = new Set()
  const affected = []
  const frontier = [{ id: nodeId, level: 0 }]
  while (frontier.length > 0) {
    const { id, level } = frontier.shift()
    if (level > depth) continue
    for (const readerId of lineage.readBy.get(id) || []) {
      if (seen.has(readerId)) continue
      seen.add(readerId)
      const reader = lineage.nodes[readerId]
      affected.push({
        nodeId: readerId,
        label: reader?.label ?? readerId,
        nodeType: reader?.type ?? null,
        distance: level + 1,
        references: (reader?.reads || [])
          .filter((r) => r.nodeId === id)
          .map((r) => ({ reference: r.raw, where: r.where })),
      })
      frontier.push({ id: readerId, level: level + 1 })
    }
  }
  return {
    nodeId,
    label: lineage.nodes[nodeId]?.label ?? nodeId,
    affected,
    // Sinks downstream of this node are the part worth calling out: a change
    // here changes what leaves the system.
    sinks: lineage.sinks.filter((s) => s.nodeId === nodeId || seen.has(s.nodeId)),
  }
}

// The wire shape. Origins are expanded to their labels because the caller
// (a CLI table, a panel) should not have to carry a copy of the taxonomy, and
// the per-node entry is trimmed to what a reader needs rather than the internal
// bookkeeping.
function describeLineage(graph) {
  const lineage = analyzeLineage(graph)
  if (!lineage.ok) return { ok: false, reason: lineage.reason, nodes: [], sinks: [], findings: [] }
  return {
    ok: true,
    nodes: Object.entries(lineage.nodes).map(([nodeId, entry]) => ({
      nodeId,
      label: entry.label,
      nodeType: entry.type,
      origins: [...entry.origins].map((kind) => ({
        kind,
        trust: ORIGIN_KINDS[kind]?.trust ?? 'unknown',
        label: ORIGIN_KINDS[kind]?.label ?? kind,
      })),
      reads: entry.reads.map((r) => ({
        nodeId: r.nodeId,
        reference: r.raw,
        where: r.where,
      })),
      readBy: [...(lineage.readBy.get(nodeId) || [])],
      secrets: entry.scopeReads.filter((s) => s.kind === 'secret').map((s) => s.name),
      variables: entry.scopeReads.filter((s) => s.kind === 'variable').map((s) => s.name),
    })),
    sinks: lineage.sinks,
    secretReach: lineage.secrets,
    findings: lineage.findings,
  }
}

module.exports = {
  analyzeLineage,
  describeLineage,
  traceProvenance,
  traceImpact,
  ORIGIN_KINDS,
  INTRINSIC_ORIGINS,
  SINKS,
  PROMPT_FIELDS,
  ROUTING_TYPES,
  COMPUTING_TYPES,
  collectRefs,
  configRefs,
}
