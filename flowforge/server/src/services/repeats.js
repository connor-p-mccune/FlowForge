// What happens twice?
//
// Three mechanisms in this engine execute the same logical step more than once,
// and each is correct on its own terms:
//
//   * **Node retries.** Every node except the four single-attempt types gets
//     `EXEC_MAX_ATTEMPTS` attempts — three by default, on by default, on every
//     run. A retry fires on a timeout, and a timeout is exactly the case where
//     the far side may already have done the work.
//   * **Resume from failure.** Re-executes everything that did not succeed.
//   * **Crash recovery.** Re-runs a step whose outcome nobody recorded.
//
// [`stepIdempotency.js`](./stepIdempotency.js) gives an author the means to
// make a repeat safe, and [`crashRecovery.js`](./crashRecovery.js) gives them a
// policy that says how much repetition they will tolerate. Nothing tells them
// what their graph actually does under either.
//
// That gap is the whole subject. `recovery_policy: 'resume'` is documented as
// *"for a graph whose steps are idempotent, which only its author can know"* —
// a claim, made once, in a dropdown, about a graph that has been edited fifty
// times since. This checks it.
//
// ---
//
// ## The verdicts
//
// One per node whose repeat could matter to anybody:
//
//   safe     A repeat changes nothing outside. A read, or a method that RFC
//            9110 defines as idempotent.
//   guarded  Not naturally safe, but the node declares `idempotent` and its
//            runner sends the key, so the far side recognises the repeat.
//   unsafe   A repeat does the work again.
//   billed   A repeat changes nothing outside and costs money anyway. Kept
//            apart from `unsafe` because the response to it is a budget
//            decision, not a correctness one, and folding them together would
//            make every AI workflow look broken.
//   unknown  The graph does not determine the method, so neither does this.
//   opaque   A sub-workflow call whose callee could not be read.
//
// **PUT and DELETE count as safe, and that is a claim about the protocol rather
// than about the server.** RFC 9110 defines them as idempotent: the state after
// N identical requests is the state after one. A server that violates that is
// broken in a way FlowForge cannot see, and treating every PUT as a hazard
// would bury the POST that actually is one. The narrower failure — a second
// DELETE returning 404 and *failing the retry* — is a different problem from
// doing the work twice, and this report is about the second.
//
// **An email is never guarded.** There is no header a receiving mail server
// deduplicates on, which is why `stepIdempotency.KEYED_TYPES` refuses the
// declaration there; a node that declares it anyway is reported as unsafe and
// the linter says why.
//
// ## Errs toward saying less
//
// A templated method is `unknown` rather than unsafe. The asymmetry is the
// opposite of the [effect report's](./effects.js) and for the same underlying
// reason: what matters is that the finding stays believed. A report that
// flagged every node with a computed method would be a report somebody turns
// off, and then the real POST goes with it.

const { KEYED_TYPES, isEnabled } = require('./stepIdempotency')

// The engine's retry shape, restated rather than imported: pulling the whole
// run loop into a static analysis is a cost nothing else here pays, and a route
// that only wants a verdict should not load the scheduler to get one.
//
// Restating it is a drift risk, so the risk is paid where it belongs — the test
// imports both modules and asserts they agree. Nothing at run time does.
const MAX_ATTEMPTS = parseInt(process.env.EXEC_MAX_ATTEMPTS || '3', 10)

// Node types the engine will not retry: their work is a nested run or a wait
// for a person, and re-attempting either is not a retry but a second ask.
const SINGLE_ATTEMPT_TYPES = new Set(['sub-workflow', 'for-each', 'approval', 'wait-callback'])

const SUB_WORKFLOW_TYPES = new Set(['sub-workflow', 'for-each'])

// Methods RFC 9110 defines as idempotent. A repeat leaves the server in the
// state one request would have.
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE', 'PUT', 'DELETE'])

// Model calls: a repeat changes nothing outside and is charged for twice.
const BILLED_TYPES = new Set(['ai-prompt', 'ai-classify', 'ai-extract'])

// Sends something a person or a system receives, with no way to deduplicate it.
const UNGUARDABLE_TYPES = new Set(['action-email', 'action-slack', 'approval', 'wait-callback'])

// Deep enough for any call chain drawn on purpose; the same bound the reach
// walk uses, for the same reason.
const MAX_DEPTH = 4

// Ranked worst-first, so a sub-workflow can inherit the worst thing its callee
// does in one comparison.
const SEVERITY = { unsafe: 5, unknown: 4, opaque: 3, billed: 2, guarded: 1, safe: 0 }

const worst = (a, b) => (SEVERITY[a] >= SEVERITY[b] ? a : b)

// The method this node will use, or null when the graph does not fix it.
//
// An absent method is not unknown: the runner defaults to GET, so an author who
// left it blank gets a read, and reporting that as indeterminate would invent a
// hazard out of a default.
function methodOf(node) {
  const raw = node?.data?.config?.method
  if (raw == null || raw === '') return 'GET'
  const text = String(raw)
  if (text.includes('{{')) return null
  return text.toUpperCase()
}

function verdictForHttp(node) {
  const method = methodOf(node)
  if (method === null) {
    return { verdict: 'unknown', why: 'the method is computed at run time, so the graph does not fix it' }
  }
  if (IDEMPOTENT_METHODS.has(method)) {
    return {
      verdict: 'safe',
      method,
      why:
        method === 'GET' || method === 'HEAD' || method === 'OPTIONS' || method === 'TRACE'
          ? `a ${method} reads`
          : `RFC 9110 defines ${method} as idempotent — a repeat leaves the same state`,
    }
  }
  if (isEnabled(node)) {
    return {
      verdict: 'guarded',
      method,
      why: `declares idempotent, so every attempt carries the same Idempotency-Key`,
    }
  }
  return {
    verdict: 'unsafe',
    method,
    why: `a ${method} with no idempotency key — a repeat sends the request again`,
  }
}

function verdictFor(node) {
  if (node.type === 'action-http') return verdictForHttp(node)
  if (BILLED_TYPES.has(node.type)) {
    return { verdict: 'billed', why: 'a repeat produces another completion and is charged for it' }
  }
  if (UNGUARDABLE_TYPES.has(node.type)) {
    // A declaration here is refused by stepIdempotency and warned about by the
    // linter. Saying so in the reason is what connects the two for somebody who
    // ticked the box and expected it to mean something.
    const claimed = node?.data?.config?.idempotent === true || node?.data?.config?.idempotent === 'true'
    const base =
      node.type === 'approval' || node.type === 'wait-callback'
        ? 'its effect is a request somebody may already have answered'
        : 'there is nothing a recipient deduplicates on'
    return {
      verdict: 'unsafe',
      why: claimed
        ? `${base} — the idempotent declaration on this node is not sent and does nothing`
        : base,
      declaredButUnsendable: claimed,
    }
  }
  return null
}

// Walk one graph, expanding sub-workflow calls through `resolve` when it is
// given. Returns the flat node list; a call contributes one row carrying the
// worst thing its callee can do, rather than the callee's rows, because the
// question is about this workflow's steps and the call is one of them.
function walk(workflow, resolve, { depth, stack, cache }) {
  const rows = []
  const nodes = workflow?.graph?.nodes || []

  for (const node of nodes) {
    if (SUB_WORKFLOW_TYPES.has(node.type)) {
      rows.push(subWorkflowRow(node, workflow, resolve, { depth, stack, cache }))
      continue
    }
    const verdict = verdictFor(node)
    if (!verdict) continue
    rows.push({
      nodeId: node.id,
      label: node.data?.label || node.id,
      type: node.type,
      // Single-attempt types aside, the engine retries on its own. That is the
      // difference between a hazard that needs a crash and one that happens on
      // an ordinary bad afternoon.
      retried: !SINGLE_ATTEMPT_TYPES.has(node.type),
      ...verdict,
    })
  }
  return rows
}

function subWorkflowRow(node, workflow, resolve, { depth, stack, cache }) {
  const base = {
    nodeId: node.id,
    label: node.data?.label || node.id,
    type: node.type,
    // Never retried by the engine, but re-run by a resume or a recovery — so a
    // nested charge repeats there and only there.
    retried: false,
  }
  const target = node.data?.config?.workflowId
  if (!target) {
    return { ...base, verdict: 'opaque', why: 'the call has no target workflow' }
  }
  if (!resolve) {
    return { ...base, verdict: 'opaque', why: 'its callee decides, and this report did not read it' }
  }
  if (stack.includes(target)) {
    return { ...base, verdict: 'opaque', why: 'the call is recursive, so the walk stopped here' }
  }
  if (depth >= MAX_DEPTH) {
    return { ...base, verdict: 'opaque', why: 'the call chain is deeper than this walk follows' }
  }
  const callee = resolve(target)
  if (!callee) {
    return { ...base, verdict: 'opaque', why: 'the callee could not be read from here' }
  }

  const key = `${target}:${depth}`
  let inner = cache.get(key)
  if (!inner) {
    inner = walk(callee, resolve, { depth: depth + 1, stack: [...stack, workflow.id], cache })
    cache.set(key, inner)
  }

  const verdict = inner.reduce((acc, r) => worst(acc, r.verdict), 'safe')
  return {
    ...base,
    verdict,
    calls: { workflowId: callee.id, name: callee.name, steps: inner.length },
    why:
      inner.length === 0
        ? 'the callee does nothing a repeat would change'
        : `the worst a repeat of ${callee.name} does is ${verdict}`,
  }
}

// Does the workflow's recovery policy describe the graph it is set on?
//
// `resume` is the interesting one, because it is an *assertion*: "always
// continue — for a graph whose steps are idempotent, which only its author can
// know". This is the one place that claim can be held against the graph, and a
// graph gets edited long after a dropdown is set.
function judgePolicy(recoveryPolicy, counts) {
  if (recoveryPolicy === 'manual') {
    return { verdict: 'consistent', why: 'nothing is recovered automatically' }
  }
  if (recoveryPolicy === 'resume') {
    if (counts.unsafe > 0) {
      return {
        verdict: 'contradicted',
        why:
          `the policy says every step is safe to repeat; ${counts.unsafe} ` +
          `${counts.unsafe === 1 ? 'is' : 'are'} not`,
      }
    }
    if (counts.unknown > 0 || counts.opaque > 0) {
      return {
        verdict: 'unverified',
        why: `${counts.unknown + counts.opaque} step(s) the graph does not settle either way`,
      }
    }
    return { verdict: 'consistent', why: 'every step is safe or guarded' }
  }
  // 'safe' (the default): the unsafe steps are the ones that will stop a
  // recovery and park the run for a person. That is the policy working, and it
  // is also a list of the declarations worth making.
  if (counts.unsafe === 0 && counts.unknown === 0 && counts.opaque === 0) {
    return { verdict: 'consistent', why: 'no step would block an automatic recovery' }
  }
  return {
    verdict: 'blocks-recovery',
    why: `${counts.unsafe + counts.unknown + counts.opaque} step(s) would stop a crashed run and need a person`,
  }
}

// What a repeat of this workflow's steps would do.
//
// `resolve(id)` → `{ id, name, graph }` or null, as in `reach.js`. Optional:
// without it a sub-workflow call is reported as opaque rather than guessed at.
function analyzeRepeats(
  workflow,
  resolve = null,
  { recoveryPolicy = 'safe', maxAttempts = MAX_ATTEMPTS } = {}
) {
  if (!workflow?.graph?.nodes) return { available: false, reason: 'empty' }

  const rows = walk(workflow, resolve, { depth: 0, stack: [], cache: new Map() })
  if (rows.length === 0) {
    return {
      available: true,
      workflowId: workflow.id,
      steps: [],
      recovery: { policy: recoveryPolicy, verdict: 'consistent', why: 'no step repeats anything' },
      summary: emptySummary(recoveryPolicy, maxAttempts),
    }
  }

  // Worst first, and within a verdict the ones the engine repeats on its own
  // ahead of the ones that need a crash — that is the order somebody should
  // read them in, because only the first group happens without anything going
  // unusually wrong.
  rows.sort(
    (a, b) =>
      SEVERITY[b.verdict] - SEVERITY[a.verdict] ||
      Number(b.retried) - Number(a.retried) ||
      String(a.label).localeCompare(String(b.label))
  )

  const counts = { safe: 0, guarded: 0, unsafe: 0, billed: 0, unknown: 0, opaque: 0 }
  for (const row of rows) counts[row.verdict] += 1

  // The finding that needs no crash, no resume and no bad luck beyond a
  // timeout: a step the engine retries by itself whose repeat is not safe.
  const automatic = rows.filter((r) => r.retried && (r.verdict === 'unsafe' || r.verdict === 'unknown'))

  return {
    available: true,
    workflowId: workflow.id,
    steps: rows,
    recovery: { policy: recoveryPolicy, ...judgePolicy(recoveryPolicy, counts) },
    summary: {
      ...counts,
      steps: rows.length,
      maxAttempts,
      // Reported as its own number because it is the only one that describes
      // what happens on an ordinary day.
      retriedUnsafe: automatic.length,
      declaredButUnsendable: rows.filter((r) => r.declaredButUnsendable).length,
    },
  }
}

function emptySummary(recoveryPolicy, maxAttempts) {
  return {
    safe: 0,
    guarded: 0,
    unsafe: 0,
    billed: 0,
    unknown: 0,
    opaque: 0,
    steps: 0,
    maxAttempts,
    retriedUnsafe: 0,
    declaredButUnsendable: 0,
    policy: recoveryPolicy,
  }
}

module.exports = {
  analyzeRepeats,
  MAX_ATTEMPTS,
  verdictFor,
  methodOf,
  IDEMPOTENT_METHODS,
  SINGLE_ATTEMPT_TYPES,
  KEYED_TYPES,
  MAX_DEPTH,
}
