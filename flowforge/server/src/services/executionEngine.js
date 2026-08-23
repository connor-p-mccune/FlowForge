// Execution engine: parses the workflow graph into a DAG and runs it with a
// ready-set scheduler — a node becomes runnable once every upstream node has
// settled, and independent branches run concurrently (bounded by
// EXEC_MAX_PARALLEL). Resolves {{node-id.field}} templates from the execution
// context, retries failures with exponential backoff (and can catch an
// exhausted failure per node via its on-error policy), records every step in
// execution_steps, and publishes exec-update events (Redis pub/sub by default).

const crypto = require('crypto')
const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const { buildAdjacency, topoSort } = require('./dagParser')
const { decryptSecret } = require('./secretVault')
const {
  recordExecution,
  recordStepCache,
  recordStepCost,
  recordFaultInjected,
  recordCompensation,
  recordRollback,
} = require('./metrics')
const compensation = require('./compensation')
const faultInjection = require('./faultInjection')
const costModel = require('./costModel')
const stepCache = require('./stepCache')
const tracing = require('./tracing')
const canary = require('./canary')
const debuggerService = require('./debugger')
const executionLease = require('./executionLease')
const stepIdempotency = require('./stepIdempotency')
const redaction = require('./redaction')
const nodePriority = require('./nodePriority')
const stepTimings = require('./stepTimings')
const scheduleSim = require('./scheduleSim')
const retryBudget = require('./retryBudget')
const convergence = require('./convergence')

const runners = {
  'action-http': require('./nodeRunners/httpRequest'),
  'action-delay': require('./nodeRunners/delay'),
  'action-email': require('./nodeRunners/sendEmail'),
  'action-slack': require('./nodeRunners/sendSlack'),
  'transform': require('./nodeRunners/transform'),
  'filter': require('./nodeRunners/filter'),
  'map': require('./nodeRunners/map'),
  'aggregate': require('./nodeRunners/aggregate'),
  'condition': require('./nodeRunners/condition'),
  'switch': require('./nodeRunners/switch'),
  'validate': require('./nodeRunners/validate'),
  'ai-prompt': require('./nodeRunners/llmPrompt'),
  'ai-classify': require('./nodeRunners/classify'),
  'ai-extract': require('./nodeRunners/extract'),
  'output-log': require('./nodeRunners/outputLog'),
  'output-return': require('./nodeRunners/outputReturn'),
  'sub-workflow': require('./nodeRunners/subWorkflow'),
  'for-each': require('./nodeRunners/forEach'),
  'approval': require('./nodeRunners/approval'),
  'wait-callback': require('./nodeRunners/waitCallback'),
}

// Node types that get exactly one attempt. Sub-workflow and for-each run whole
// nested executions that already retry their own nodes — retrying the wrapper
// would duplicate side effects and child execution rows. Approval waits on a
// human decision — a retry would file a duplicate approval request — and
// wait-callback would sit through its full timeout twice on a dead integration.
const SINGLE_ATTEMPT_TYPES = new Set(['sub-workflow', 'for-each', 'approval', 'wait-callback'])

// Node types whose failure can never be caught by an on-error policy. The
// branching nodes already settle a routing result — layering a second routing
// mechanism (the error handle) on top of the first would make an edge's
// meaning ambiguous — and a trigger that can't even emit its payload has
// nothing meaningful to route.
const UNCATCHABLE_TYPES = new Set(['condition', 'switch', 'validate', 'approval', 'wait-callback'])

// A node's on-error policy: 'fail' (default — the failure fails the run),
// 'continue' (settle the error object as the node's output and proceed down
// the normal edges), or 'branch' (activate only the edge wired to the node's
// dedicated 'error' handle). Read from the raw config, not the templated one —
// the policy is a static routing decision, so upstream data must not be able
// to decide it.
function errorPolicy(node) {
  if (node.type.startsWith('trigger-') || UNCATCHABLE_TYPES.has(node.type)) return 'fail'
  const policy = node.data?.config?.onError
  return policy === 'continue' || policy === 'branch' ? policy : 'fail'
}

const MAX_ATTEMPTS = parseInt(process.env.EXEC_MAX_ATTEMPTS || '3')
const BASE_BACKOFF_MS = parseInt(process.env.EXEC_RETRY_BASE_MS || '500')

// How many nodes of one run may execute at the same time. Independent branches
// (e.g. the two sides of a diamond) run concurrently up to this cap; 1 restores
// strictly sequential execution. Read per-run so tests can vary it, and read
// through scheduleSim so the scheduler and every analysis that models it can
// never disagree about what the cap is.
const maxParallel = scheduleSim.configuredCap

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getRunner(type) {
  // Triggers have no work of their own — they pass the trigger payload through
  if (type.startsWith('trigger-')) {
    return async (config, input) => ({ triggered: true, ...input })
  }
  const runner = runners[type]
  if (!runner) throw new Error(`No runner registered for node type "${type}"`)
  return runner
}

// Look up "node-id.path.to.field" in the execution context
function lookupPath(context, path) {
  const [nodeId, ...rest] = path.split('.')
  let value = context[nodeId]
  for (const key of rest) {
    if (value == null) return undefined
    value = value[key]
  }
  return value
}

const EXACT_PLACEHOLDER = /^\{\{\s*([\w-]+(?:\.[\w-]+)*)\s*\}\}$/
const PLACEHOLDER = /\{\{\s*([\w-]+(?:\.[\w-]+)*)\s*\}\}/g

// Recursively resolve {{node-id.field}} placeholders in config values.
// A string that is exactly one placeholder keeps the referenced value's type.
function resolveTemplates(value, context) {
  if (typeof value === 'string') {
    const exact = value.match(EXACT_PLACEHOLDER)
    if (exact) return lookupPath(context, exact[1])
    return value.replace(PLACEHOLDER, (_, path) => {
      const v = lookupPath(context, path)
      if (v === undefined || v === null) return ''
      return typeof v === 'object' ? JSON.stringify(v) : String(v)
    })
  }
  if (Array.isArray(value)) return value.map((v) => resolveTemplates(v, context))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveTemplates(v, context)])
    )
  }
  return value
}

// The object trigger nodes emit as their output. Prefer the payload handed in by
// the caller (a live webhook/replay job), otherwise fall back to the trigger_data
// persisted on the execution row (how a replay re-runs from the stored input).
// Manual runs have neither, so they start from {}.
function resolveTriggerPayload(payload, triggerData) {
  if (payload && typeof payload === 'object') return payload
  if (triggerData) {
    try {
      const parsed = JSON.parse(triggerData)
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      /* malformed/legacy trigger_data — fall through to empty payload */
    }
  }
  return {}
}

// Decrypt a workspace's secrets into a plain { NAME: value } map for template
// resolution. A row that fails to decrypt (rotated key, corrupted value) is
// skipped with a log line rather than failing the run — its references then
// resolve like any other missing placeholder.
function loadWorkspaceSecrets(workspaceId) {
  const rows = db.prepare(
    'SELECT name, value_encrypted FROM workspace_secrets WHERE workspace_id = ?'
  ).all(workspaceId)
  const secrets = {}
  for (const row of rows) {
    try {
      secrets[row.name] = decryptSecret(row.value_encrypted)
    } catch (err) {
      console.error(`Skipping secret "${row.name}": ${err.message}`)
    }
  }
  return secrets
}

// A workspace's variables as a plain { NAME: value } map for template
// resolution ({{vars.NAME}}). The non-secret sibling of the map above:
// values are cleartext configuration, resolved through the same scope but
// never redacted from persisted steps — a variable is exactly the kind of
// data a run log should show. Anything sensitive belongs in secrets.
function loadWorkspaceVariables(workspaceId) {
  const rows = db.prepare(
    'SELECT name, value FROM workspace_variables WHERE workspace_id = ?'
  ).all(workspaceId)
  return Object.fromEntries(rows.map((r) => [r.name, r.value]))
}

const REDACTED = '••••••'

// Build a scrubber that masks every secret value inside a string. Applied to
// everything that leaves engine memory — persisted step input/output JSON,
// published step events, and error messages — so a secret used by a node (or
// echoed back by an API it called) never lands in the database or the UI, while
// downstream nodes still receive the real value via the in-memory context.
// Values shorter than 4 chars are left alone: masking e.g. "1" would corrupt
// unrelated output far more than it protects.
function buildRedactor(secretValues) {
  const values = new Set()
  for (const v of secretValues) {
    if (typeof v !== 'string' || v.length < 4) continue
    values.add(v)
    // Secrets containing quotes/backslashes appear JSON-escaped inside the
    // serialized step rows — scrub that form too.
    const escaped = JSON.stringify(v).slice(1, -1)
    if (escaped !== v) values.add(escaped)
  }
  if (values.size === 0) return (str) => str
  return (str) => {
    if (typeof str !== 'string') return str
    let out = str
    for (const v of values) out = out.split(v).join(REDACTED)
    return out
  }
}

// Deep-copy a JSON-ish value with every string passed through the redactor.
function redactDeep(value, redact) {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, redact)]))
  }
  return value
}

// Remove the reserved metering key from a runner's return value. Shallow by
// design: `usage` is a contract between a runner and the engine at the top
// level of the returned object, never something nested that a user's data
// could accidentally collide with deeper down.
function stripUsage(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return output
  if (!('usage' in output)) return output
  const { usage: _usage, ...rest } = output
  return rest
}

function defaultPublish(payload) {
  // Lazy require so engine unit tests never touch Redis
  const redis = require('../config/redis')
  redis
    .publish('exec-update', JSON.stringify(payload))
    .catch((err) => console.error('Failed to publish exec-update:', err.message))
}

// A node's runner, wrapped by the run's chaos profile when one applies. The
// fault is resolved *once per node*, not per attempt, so a `fail` rule
// genuinely exercises the retry ladder — a node that re-drew its luck between
// attempts would test the retries' existence rather than their behaviour.
//
// Each mode intervenes at a different point, which is the whole vocabulary:
// `fail` replaces the call, `delay` precedes it, and `stub` substitutes its
// result.
function applyFault(runner, fault) {
  if (!fault) return runner
  // A deploy preview's stub is the same mechanism pointed at a different
  // problem, and it is deliberately not counted: `flowforge_faults_injected_total`
  // exists so a spike in run failures beside a spike in faults reads as an
  // experiment, and a preview is neither an experiment nor a failure.
  if (!fault.silent) recordFaultInjected(fault.mode)
  if (fault.mode === 'fail') {
    return async () => {
      throw new Error(`[chaos] ${fault.message}`)
    }
  }
  if (fault.mode === 'delay') {
    return async (...args) => {
      await sleep(fault.delayMs)
      return runner(...args)
    }
  }
  // stub: the node never runs, and downstream receives the canned output.
  return async () => ({ ...fault.output })
}

async function runWithRetries(node, config, input, isDryRun, ctx, fault) {
  const runner = applyFault(getRunner(node.type), fault)
  const maxAttempts = SINGLE_ATTEMPT_TYPES.has(node.type) ? 1 : MAX_ATTEMPTS
  // The URL this node will call, for the node types whose purpose is to call
  // one. Null everywhere else, and the budget then never applies — a Transform
  // node's retry costs nobody anything.
  const egressUrl = isDryRun ? null : retryBudget.egressUrlOf(node, config)

  for (let attempt = 1; ; attempt++) {
    try {
      return await runner(config, input, isDryRun, ctx)
    } catch (err) {
      if (attempt >= maxAttempts) throw err

      // Retry budget: a host under strain fails *some* requests, every failure
      // gets retried, and the retries are the load that finishes it off. The
      // circuit breaker cannot see this — it never gets N consecutive failures,
      // because the host keeps answering. So retries are capped as a fraction of
      // the host's requests, and once that is spent the run fails now rather
      // than after two more attempts that make things worse.
      //
      // The original error is what surfaces; the note is appended to it, because
      // "the API returned 503" is the cause and "we did not try again" is only
      // the reason it stopped there.
      if (egressUrl) {
        const state = retryBudget.allowRetry(egressUrl)
        if (!state.allowed) {
          err.message = `${err.message} (${retryBudget.suppressionNote(state)})`
          throw err
        }
        retryBudget.recordRetry(egressUrl)
      }

      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1))
    }
  }
}

// The lease wrapper (services/executionLease.js). Everything below assumes the
// process survives the run; this is what happens when it does not, and it does
// two jobs that are really the same job seen from either end.
//
// **A duplicate delivery becomes a no-op.** Bull re-delivers a job whose worker
// stopped reporting progress, and running the body again would insert a fresh
// step row per node and execute the whole graph a second time — re-sending the
// email, re-charging the card. `acquire` only succeeds on a run that has not
// started, so the second delivery returns instead. Restarting a run that is
// half-done is never the right recovery; continuing it is, and that is what the
// recovery sweep does with the persisted steps.
//
// **A worker that died stops being believed.** The lease is renewed by a timer
// rather than by the scheduler, because a run parked on an approval gate makes
// no progress for hours by design and must not look like a corpse; a dead
// process runs no timers, which is the whole mechanism.
//
// Only top-level, non-dry runs are leased. A sub-workflow child executes inside
// its parent's engine loop, so its parent's lease is the only one that means
// anything, and a dry run is interactive — somebody is watching it, which is a
// better liveness check than a column.
async function runExecution(executionId, options = {}) {
  const { dryRun = false, ancestorWorkflowIds = [] } = options
  if (dryRun || ancestorWorkflowIds.length > 0) {
    return runLeasedExecution(executionId, options, null)
  }

  const token = executionLease.acquire(executionId)
  if (!token) {
    const row = db.prepare('SELECT status FROM executions WHERE id = ?').get(executionId)
    // A missing row is a caller error and keeps its familiar message; a row
    // that has already started is a redelivery, and dropping it is the point.
    if (!row) throw new Error(`Execution ${executionId} not found`)
    if (row.status !== 'pending') {
      console.warn(
        `Execution ${executionId} is already ${row.status} — dropping duplicate delivery`
      )
    }
    return {}
  }

  const stopRenewal = executionLease.startRenewal(executionId, token)
  try {
    return await runLeasedExecution(executionId, options, token)
  } finally {
    stopRenewal()
    executionLease.release(executionId, token)
  }
}

// dryRun (test mode): side-effecting node runners (email/Slack/HTTP) skip their
// external call and instead return what they *would* have sent. Everything else
// — conditions, transforms, AI nodes — runs for real, so test output is genuine.
async function runLeasedExecution(
  executionId,
  { publish, payload, dryRun = false, ancestorWorkflowIds = [], graphOverride, stubs } = {},
  leaseToken = null
) {
  const pub = publish || defaultPublish

  const execution = db.prepare('SELECT * FROM executions WHERE id = ?').get(executionId)
  if (!execution) throw new Error(`Execution ${executionId} not found`)
  // Cancelled while still queued: the cancel route already finalized the row,
  // so the job is a no-op — don't resurrect it into 'running'.
  if (execution.status === 'cancelled') return {}
  const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(execution.workflow_id)
  if (!workflow) throw new Error(`Workflow ${execution.workflow_id} not found`)

  // Trigger nodes emit this object as their output, so webhook bodies (or a
  // replayed run's stored trigger_data) flow into the graph (e.g.
  // {{triggerNodeId.field}}). Manual runs start from {}.
  const triggerPayload = resolveTriggerPayload(payload, execution.trigger_data)

  const workflowId = workflow.id
  // Workflow ids on the current call stack, including this run's own. Handed to
  // sub-workflow nodes (via ctx) so they can reject a target already on the stack
  // — a cycle — before recursing into it.
  const callStack = [...ancestorWorkflowIds, workflowId]

  // Observability: every terminal state reports its status and wall time to
  // the /metrics registry. nested marks sub-workflow child runs.
  const runStartedMs = Date.now()
  const isNested = ancestorWorkflowIds.length > 0
  const recordTerminal = (status) =>
    recordExecution(status, (Date.now() - runStartedMs) / 1000, { nested: isNested })

  // Workspace secrets, decrypted just for this run. Node configs reference them
  // as {{secrets.NAME}}; the map lives only in engine memory, and the redactor
  // scrubs the plaintext from everything persisted or published below.
  const secrets = loadWorkspaceSecrets(workflow.workspace_id)
  // Workspace variables ride the same template scope ({{vars.NAME}}) but are
  // plain config: no redaction, and they may appear in persisted steps.
  const vars = loadWorkspaceVariables(workflow.workspace_id)

  // Progressive delivery. While a canary is running, this run executes either
  // the live canvas (the edits under test) or the pinned baseline version — and
  // which one it got is recorded on the row, because that label is the entire
  // experiment. Everything else below is unchanged: the engine reads one graph
  // per run, it just no longer assumes that graph is the workflow's current
  // one. Dry runs, resumes, and workflows with no canary all resolve to the
  // live graph, so this is a no-op for every run that isn't in an experiment.
  const release = canary.resolveRelease(execution, workflow, { dryRun })
  canary.recordRelease(executionId, release)

  // Deploy preview (services/backtest.js) hands a dry run two things the engine
  // otherwise derives: the graph to execute, and canned outputs for the nodes
  // whose work reaches outside FlowForge. Together they let a *candidate*
  // definition be replayed against a run that already happened, so a routing
  // difference is attributable to the edit rather than to test mode simulating
  // an HTTP response.
  //
  // Both are refused outside a dry run, deliberately and structurally: running a
  // definition the workflow does not hold, or settling a node from a value the
  // caller supplied, is a hole if it can ever fire real effects. The node test
  // bench makes the same trade one node at a time.
  const preview = dryRun && (graphOverride || stubs) ? { graphOverride, stubs } : null
  const graph = preview?.graphOverride
    ? { nodes: preview.graphOverride.nodes || [], edges: preview.graphOverride.edges || [] }
    : JSON.parse(release.graphJson)

  // Declared field redaction (services/redaction.js). A workflow can name the
  // trigger fields that carry personal data, and their values join the same
  // scrubber the secrets use — so an email is masked in the trigger's own step,
  // in the request body that interpolated it, and in the response that echoed it
  // back. Masking the declared *location* would scrub one of those and leave the
  // rest, which is the version of this that looks like it works.
  //
  // Built here rather than beside the secrets because it needs the graph: a
  // declaration may be written as `hook.email`, and only the graph says whether
  // `hook` is a trigger. Nothing between the two points uses the redactor.
  const triggerNodeIds = new Set(
    (graph.nodes || []).filter((n) => String(n.type || '').startsWith('trigger-')).map((n) => n.id)
  )
  const redact = buildRedactor([
    ...Object.values(secrets),
    ...redaction.valuesFor(workflow.redact_json, { triggerPayload, triggerNodeIds }),
  ])

  // Chaos profile, if this workflow has an armed one. Loading it here (rather
  // than per node) means one parse per run and one decision about scope: a
  // profile limited to test runs resolves to null on a real one, so nothing
  // downstream has to remember the rule.
  const chaosProfile = faultInjection.loadProfile(workflow.chaos_config)
  // Sticky notes are canvas annotations, not steps: they never execute, get
  // no step rows, and any edge touching one (only possible in a hand-edited
  // import — the UI renders notes without handles) is dropped with them.
  const noteIds = new Set((graph.nodes || []).filter((n) => n.type === 'note').map((n) => n.id))
  // Compensating transactions: a node that declares `compensates: <node-id>` is
  // the undo for that node, not a step of this run. It is stripped from the
  // forward graph exactly like a sticky note — no step row, no place in the
  // topological order, never launched — and executes only if the run ends badly
  // and the rollback pass reaches it. Keeping the plan here (rather than
  // re-deriving it after the failure) means the graph is read once and the
  // stripping and the unwinding can never disagree about which nodes are which.
  const plan = compensation.compensationPlan(graph.nodes || [])
  const excluded = new Set([...noteIds, ...plan.compensationIds])
  const nodes = (graph.nodes || []).filter((n) => !excluded.has(n.id))
  const edges = (graph.edges || []).filter((e) => !excluded.has(e.source) && !excluded.has(e.target))
  const nodeById = Object.fromEntries(nodes.map((n) => [n.id, n]))

  // Resume-from-failure: when this run continues an earlier failed/cancelled
  // one, the source run's succeeded steps can stand in for re-executing their
  // nodes — the recorded output is adopted and the step is marked 'reused'.
  // Eligibility is checked twice. Here: the node must still exist in the
  // current graph with the same type (an edited/replaced node re-executes),
  // and its recorded output must parse. At schedule time (canReuse below): all
  // of its upstream nodes must have settled exactly as they did in the source
  // run, so a reused output can never sit downstream of a node that re-ran.
  // 'reused' counts as succeeded so resuming a resumed run chains. Note the
  // adopted output is the *persisted* value — already secret-redacted — so a
  // secret echoed back by an API in the original run does not survive a
  // resume; downstream nodes that need the raw value re-execute.
  const priorOutputs = {}
  if (execution.resumed_from_execution_id) {
    const priorSteps = db.prepare(
      "SELECT node_id, node_type, output_json FROM execution_steps WHERE execution_id = ? AND status IN ('succeeded', 'reused', 'cached')"
    ).all(execution.resumed_from_execution_id)
    for (const step of priorSteps) {
      const node = nodeById[step.node_id]
      if (!node || node.type !== step.node_type) continue
      try {
        priorOutputs[step.node_id] = step.output_json ? JSON.parse(step.output_json) : {}
      } catch {
        /* unparseable prior output — the node re-executes */
      }
    }
  }

  // Machine-in-the-loop callbacks: every wait-callback node gets its row and
  // one-time token *before anything executes*, so an upstream node can send
  // the URL out ({{callbacks.<node-id>}} resolves in any config) and an
  // external reply can never race the runner into a lost delivery — a POST
  // landing before the node starts waiting parks on the 'armed' row and the
  // runner settles instantly when it gets there. Dry runs arm nothing (the
  // runner simulates); their references resolve to an inert placeholder so a
  // "would send" preview still shows the URL's shape.
  const callbackUrls = {}
  const waitCallbackNodes = nodes.filter((n) => n.type === 'wait-callback')
  if (waitCallbackNodes.length > 0) {
    if (dryRun) {
      for (const n of waitCallbackNodes) callbackUrls[n.id] = '/api/callbacks/dry-run'
    } else {
      const armCallback = db.prepare(
        `INSERT INTO execution_callbacks
           (id, execution_id, node_id, workflow_id, workspace_id, token, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'armed', ?)`
      )
      for (const n of waitCallbackNodes) {
        const token = crypto.randomBytes(24).toString('hex')
        armCallback.run(
          uuidv4(), executionId, n.id, workflowId, workflow.workspace_id, token,
          new Date().toISOString()
        )
        callbackUrls[n.id] = `/api/callbacks/${token}`
      }
    }
  }

  // A run that settles with a callback still armed (its node never ran —
  // upstream failure, cancellation, dead branch) or waiting retires it, so a
  // token dies with its run and a late delivery gets an honest 410 instead of
  // writing into a finished execution. Best-effort: bookkeeping must never
  // mask the run's real outcome.
  function settleLeftoverCallbacks() {
    if (dryRun || waitCallbackNodes.length === 0) return
    try {
      db.prepare(
        "UPDATE execution_callbacks SET status = 'cancelled' WHERE execution_id = ? AND status IN ('armed', 'waiting')"
      ).run(executionId)
    } catch (err) {
      console.error('Failed to settle leftover callbacks:', err.message)
    }
  }

  // Distributed tracing. The run gets a trace id and a root span the moment it
  // starts, so every step and every outbound call can hang off it. A run whose
  // trigger carried a W3C `traceparent` adopts that trace instead of minting
  // one — that adoption is what makes a webhook-triggered run a *child* of
  // whatever called it, rather than an unrelated trace somebody has to
  // correlate by timestamp.
  //
  // Written once, idempotently: a resumed or replayed run keeps the trace id it
  // was given, so the lineage stays one trace rather than fragmenting per
  // attempt.
  const traceId = execution.trace_id || tracing.newTraceId()
  const rootSpanId = execution.root_span_id || tracing.newSpanId()
  if (!execution.trace_id) {
    try {
      db.prepare('UPDATE executions SET trace_id = ?, root_span_id = ? WHERE id = ?')
        .run(traceId, rootSpanId, executionId)
    } catch (err) {
      console.error(`Failed to record trace context: ${err.message}`)
    }
  }

  // Every write that decides this run's outcome carries the fencing token when
  // one was taken. A worker stalled long enough to lose its lease still holds
  // all of its in-memory state and can wake up mid-write; the token is what
  // stops it finalising a run another worker has already adopted. Kleppmann's
  // argument, and the reason checking `held()` alone would not be enough — a
  // check is only true until it isn't.
  const updateExecutionRow = db.prepare(
    'UPDATE executions SET status = ?, started_at = COALESCE(started_at, ?), finished_at = ? WHERE id = ?'
  )
  const updateExecutionFenced = db.prepare(
    `UPDATE executions SET status = ?, started_at = COALESCE(started_at, ?), finished_at = ?
      WHERE id = ? AND lease_token = ?`
  )
  const updateExecution = {
    run: (status, startedAt, finishedAt, id) =>
      leaseToken
        ? updateExecutionFenced.run(status, startedAt, finishedAt, id, leaseToken)
        : updateExecutionRow.run(status, startedAt, finishedAt, id),
  }

  function publishExecution(status, error) {
    // dryRun rides along so clients (including collaborators who adopt a run they
    // didn't start) can show the test-mode banner without an extra fetch.
    pub({ kind: 'execution', workflowId, executionId, status, error: error || null, dryRun })
  }

  function failExecution(message) {
    const safeMessage = redact(message)
    settleLeftoverCallbacks()
    updateExecution.run('failed', new Date().toISOString(), new Date().toISOString(), executionId)
    publishExecution('failed', safeMessage)
    logRunActivity('execution.failed', safeMessage)
    recordTerminal('failed')
  }

  // Log a workspace activity event when a top-level run finishes. Skipped for
  // dry-runs (test mode) and sub-workflow child runs (ancestorWorkflowIds is non-
  // empty) so the feed shows real, user-facing runs only. Lazy-required like the
  // Redis publish above so engine unit tests don't pull in the service; logEvent
  // is itself best-effort and never throws.
  function logRunActivity(eventType, errorMsg) {
    if (dryRun || ancestorWorkflowIds.length > 0) return
    require('./activityService').logEvent(workflow.workspace_id, execution.triggered_by, eventType, {
      type: 'execution',
      id: executionId,
      name: workflow.name,
      metadata: {
        workflowId,
        triggerType: execution.trigger_type,
        ...(errorMsg ? { error: errorMsg } : {}),
      },
    })
  }

  updateExecution.run('running', new Date().toISOString(), null, executionId)
  publishExecution('running')

  let order
  try {
    const { adj, inDegree } = buildAdjacency(nodes, edges)
    order = topoSort(nodes, adj, inDegree)
  } catch (err) {
    failExecution(err.message)
    return
  }

  // One step row per node, in execution order. node_type is captured now so
  // analytics can aggregate per-type timing even if the graph is edited later.
  const insertStep = db.prepare(
    'INSERT INTO execution_steps (id, execution_id, node_id, node_type, status) VALUES (?, ?, ?, ?, ?)'
  )
  const stepIdByNode = {}
  // One span per step, minted up front with the row. Doing it here rather than
  // at launch means a node can reference its own span id before it runs — which
  // is what lets an HTTP node inject a header naming the step making the call.
  const spanIdByNode = {}
  for (const nodeId of order) {
    const stepId = uuidv4()
    stepIdByNode[nodeId] = stepId
    spanIdByNode[nodeId] = tracing.newSpanId()
    insertStep.run(stepId, executionId, nodeId, nodeById[nodeId]?.type ?? null, 'pending')
  }
  try {
    const setSpan = db.prepare('UPDATE execution_steps SET span_id = ? WHERE id = ?')
    for (const nodeId of order) setSpan.run(spanIdByNode[nodeId], stepIdByNode[nodeId])
  } catch (err) {
    // Tracing is observability: a run must not fail because a span id could
    // not be stored. The export derives a stable id from the step id instead.
    console.error(`Failed to record step spans: ${err.message}`)
  }

  const updateStep = db.prepare(`
    UPDATE execution_steps
    SET status = ?, input_json = ?, output_json = ?, error = ?,
        started_at = COALESCE(started_at, ?), finished_at = ?
    WHERE id = ?
  `)

  // The run's real completion sequence. Stamped on a step the moment its runner
  // returns — success, caught, or failure alike — so the column is set exactly
  // when this run performed that node's work. A skipped, cached or reused step
  // never gets one, which is precisely the set rollback must not compensate:
  // their side effects belong to an earlier run that still owns them.
  //
  // Kept out of updateStep's parameter list because it is written once per node
  // and that statement is the hot path for every status transition.
  const setCompletedSeq = db.prepare('UPDATE execution_steps SET completed_seq = ? WHERE id = ?')
  const completionOrder = [] // node ids, in the order their runners returned
  function markCompleted(nodeId) {
    const seq = completionOrder.length
    completionOrder.push(nodeId)
    try {
      setCompletedSeq.run(seq, stepIdByNode[nodeId])
    } catch (err) {
      // The in-memory order still drives this run's own rollback; only a later
      // manual rollback would read the column, and it degrades to skipping a
      // step rather than unwinding in the wrong order.
      console.error(`Failed to record completion order for ${nodeId}: ${err.message}`)
    }
  }

  // Cost accounting. A step's metered usage is recorded on its own row and
  // accumulated for the run, so "what did this run cost?" is a column rather
  // than a join over every step. Kept entirely separate from updateStep because
  // it applies to a handful of step types and must never widen the hot path's
  // write for the rest.
  //
  // Every call here is best-effort: metering is bookkeeping, and a run that
  // would have succeeded must not fail because its invoice line couldn't be
  // written.
  const setStepCost = db.prepare(
    'UPDATE execution_steps SET cost_micro_usd = ?, usage_json = ? WHERE id = ?'
  )
  let runCostMicroUsd = 0

  function meterStep(node, output) {
    try {
      const metered = costModel.meterStep(node, output)
      if (!metered) return
      runCostMicroUsd += metered.microUsd
      setStepCost.run(metered.microUsd, JSON.stringify(metered.usage), stepIdByNode[node.id])
      recordStepCost(node.type, metered.microUsd)
    } catch (err) {
      console.error(`Cost metering failed for ${node.id}: ${err.message}`)
    }
  }

  // Persist the run's total at every terminal path. A failed run still spent
  // whatever it spent before it failed — a budget that only counted successes
  // would be trivially defeated by a workflow that dies after its AI call.
  function persistRunCost() {
    try {
      db.prepare('UPDATE executions SET cost_micro_usd = ? WHERE id = ?')
        .run(runCostMicroUsd, executionId)
    } catch (err) {
      console.error(`Failed to persist run cost: ${err.message}`)
    }
  }

  function publishStep(nodeId, status, extra = {}) {
    pub({
      kind: 'step',
      workflowId,
      executionId,
      stepId: stepIdByNode[nodeId],
      nodeId,
      status,
      output: extra.output != null ? redactDeep(extra.output, redact) : null,
      error: extra.error != null ? redact(extra.error) : null,
    })
  }

  const context = {} // nodeId -> output object
  const nodeStatus = {} // nodeId -> 'success' | 'failed' | 'skipped' (settled nodes only)
  // Nodes whose failure was caught under the 'branch' on-error policy. They
  // settle as routable successes, but activate only their 'error' handle.
  const caughtBranch = new Set()
  // Every node whose failure was caught, under either policy. They settle with
  // nodeStatus 'success' so the scheduler can route through them — which makes
  // this set load-bearing for rollback: a caught node did *not* succeed, and
  // compensating one would undo an effect its author already decided how to
  // handle when they chose 'continue' or 'branch'.
  const caughtNodes = new Set()
  const now = () => new Date().toISOString()

  const incomingByNode = {}
  for (const nodeId of order) incomingByNode[nodeId] = []
  for (const e of edges) {
    if (incomingByNode[e.target]) incomingByNode[e.target].push(e)
  }

  // Sorted once, here, because a node's input is `Object.assign` over these and
  // that is last-writer-wins: the order of this array decides which of two
  // converging branches supplies a colliding field.
  //
  // Left as insertion order, that would be the order the author drew the
  // connections — invisible on the canvas, and rewritten differently by every
  // storage path the graph can take (a collab session sorts edges by id, the
  // `.flow` format and the artifact signature by source/target, a plain save
  // keeps the array). The same graph would then compute a different value
  // depending on how it was last written, with every check still green.
  //
  // `contributionOrder` derives the order from the graph instead: deeper
  // contributor wins, since it ran later and saw the shallower one's value.
  // Everything else that reads these lists asks `.every` or `.length`, so this
  // is the only place the order is observable.
  const mergeOrder = convergence.contributionOrder(nodes, edges)
  for (const nodeId of order) incomingByNode[nodeId].sort(mergeOrder)

  // Upstream edges whose source succeeded and — for condition sources — whose
  // handle matches the branch the condition took. Only meaningful once every
  // upstream node has settled.
  function activeIncomingFor(nodeId) {
    return incomingByNode[nodeId].filter((e) => {
      if (nodeStatus[e.source] !== 'success') return false
      // Per-node error handling: a caught failure routes exactly one way.
      // Under the 'branch' policy only the edge leaving the dedicated 'error'
      // handle activates; on a real success (or under 'continue', which has no
      // error handle) that handle stays dark. Checked before the branching
      // rule below so a stale error edge can never activate via a result match.
      if (e.sourceHandle === 'error') return caughtBranch.has(e.source)
      if (caughtBranch.has(e.source)) return false
      const sourceNode = nodeById[e.source]
      // Branching nodes only activate the matching handle: condition routes on
      // its true/false result, approval on approved (result true) vs rejected,
      // switch on its matched case label (or 'default'), validate on 'valid'
      // vs 'invalid', and wait-callback on 'received' vs 'timed-out'. All
      // settle a `result` string that the edge's sourceHandle must equal —
      // one check, not a branching system per type.
      const branching =
        sourceNode?.type === 'condition' ||
        sourceNode?.type === 'approval' ||
        sourceNode?.type === 'switch' ||
        sourceNode?.type === 'validate' ||
        sourceNode?.type === 'wait-callback'
      if (branching && e.sourceHandle != null) {
        return String(context[e.source]?.result) === e.sourceHandle
      }
      return true
    })
  }

  function skipNode(nodeId) {
    nodeStatus[nodeId] = 'skipped'
    updateStep.run('skipped', null, null, null, now(), now(), stepIdByNode[nodeId])
    publishStep(nodeId, 'skipped')
  }

  // Reuse (resume runs only): settle a node from its prior recorded output
  // without invoking its runner. Safe only while the node's inputs cannot have
  // changed: every upstream must have settled the same way it did in the
  // source run — succeeded upstreams must themselves have been reused, and
  // skipped upstreams re-skip identically because the condition/approval nodes
  // that routed them are reused with their original result. The moment any
  // upstream actually re-executed, its output may differ, so this node — and
  // transitively everything downstream — re-executes too.
  const reusedNodes = new Set()
  function canReuse(nodeId) {
    if (!(nodeId in priorOutputs)) return false
    return incomingByNode[nodeId].every(
      (e) =>
        nodeStatus[e.source] === 'skipped' ||
        (nodeStatus[e.source] === 'success' && reusedNodes.has(e.source))
    )
  }

  function reuseNode(nodeId) {
    const output = priorOutputs[nodeId]
    reusedNodes.add(nodeId)
    context[nodeId] = output
    nodeStatus[nodeId] = 'success'
    // Output was persisted redacted by the source run; storing it again is a
    // no-op for redaction but keeps this step self-contained.
    updateStep.run('reused', null, redact(JSON.stringify(output)), null, now(), now(), stepIdByNode[nodeId])
    publishStep(nodeId, 'reused', { output })
  }

  // Ready-set scheduler: a node is ready once all of its upstream nodes have
  // settled (succeeded / failed / skipped). Ready nodes with no active upstream
  // edge are skipped immediately (which can cascade); the rest launch
  // concurrently up to the parallelism cap. On the first failure the scheduler
  // stops launching, lets in-flight nodes settle, then skips whatever never ran
  // — so parallel siblings finish and record their results, but the run fails.
  const cap = maxParallel()
  const unscheduled = [...order] // not yet launched or skipped, topo order

  // Which ready node to launch when there are more of them than free slots.
  // Walking `unscheduled` and taking the first ones — what this did until now —
  // launches in topological order, which is declaration order, which is the
  // order somebody dropped nodes on a canvas. That is invisible until the ready
  // set outgrows the capacity, and then it sets the run's duration: a fan-out to
  // one 6s node and five 100ms ones finishes in 6.2s or 12s depending purely on
  // where the slow one happened to be drawn.
  //
  // So order by upward rank — most remaining work downstream first — weighted by
  // this workflow's own recorded step times. See services/nodePriority.js for
  // the rule and services/scheduleSim.js for the simulation that measures it.
  // The choice is semantically inert (same nodes, same active edges, same
  // inputs) and deterministic, so a replay reproduces the original interleaving.
  //
  // A graph that cannot fill the cap can never face the choice, so it skips the
  // timing query entirely; and any failure here degrades to the old order rather
  // than failing the run, because this is an optimisation and must behave like
  // one.
  const launchPlan = (() => {
    try {
      const weights = nodes.length > cap ? stepTimings.expectedDurations(workflowId) : {}
      return nodePriority.plan({ nodes, edges }, weights)
    } catch (err) {
      console.error(`Launch ordering unavailable for ${executionId}: ${err.message}`)
      return nodePriority.plan({ nodes, edges }, {}, { ordering: nodePriority.TOPOLOGICAL })
    }
  })()
  const inFlight = new Map() // nodeId -> settling promise (never rejects)
  let failure = null // first { node, err }, wins the run's error message

  // Cooperative cancellation: the cancel route flips cancel_requested on the
  // row; we poll it once per scheduling round (i.e. every time a node settles)
  // and wind the run down instead of launching anything further. A node that is
  // already in flight always runs to completion — cancellation is inter-node.
  const cancelCheck = db.prepare('SELECT cancel_requested FROM executions WHERE id = ?')
  let cancelled = false
  const isCancelRequested = () => Boolean(cancelCheck.get(executionId)?.cancel_requested)

  // Set when this worker's lease was taken while the run was in flight. It is
  // the one terminal path that writes nothing at all: the run has an owner, and
  // it is not this process.
  let leaseLost = false

  // Breakpoints (services/debugger.js). Null on every run not started as a
  // debug session, which is every scheduled, webhook and API-triggered run —
  // the plan is read off the execution row, and only the manual run submission
  // can put one there.
  //
  // `openBreaks` is what makes a break feel like the *run* pausing rather than
  // one branch stalling: the scheduler stops launching while it is non-zero, so
  // a parallel sibling does not quietly race ahead while somebody is reading
  // the node they stopped at. It is incremented synchronously at launch — before
  // the task starts awaiting — so the round loop cannot observe zero in between.
  const debugPlan = dryRun ? null : debuggerService.planFor(execution)
  let openBreaks = 0

  function launchNode(nodeId) {
    const node = nodeById[nodeId]
    // Input = merged outputs of all active upstream nodes. Trigger (source)
    // nodes start from the run's trigger payload instead of an empty object.
    const baseInput = node.type.startsWith('trigger-') ? { ...triggerPayload } : {}
    const input = Object.assign(
      baseInput,
      ...activeIncomingFor(nodeId).map((e) => context[e.source] || {})
    )

    // Step cache read: a caching node whose exact work — type + resolved
    // config + merged input — has a live entry settles synchronously, like a
    // skip or a resume reuse: the recorded output is adopted (step status
    // 'cached'), the runner is never invoked, and no execution slot is
    // occupied. The adopted value is the *persisted* (redacted)
    // serialisation, mirroring resume's 'reused' semantics — a secret echoed
    // back by the original call does not survive a hit. Dry runs bypass the
    // cache both ways (simulated outputs must not poison it), and any cache
    // fault degrades to a miss — memoisation must never fail a run that
    // would otherwise succeed. Everything upstream has settled by the time a
    // node launches, so resolving the config here reads the same values the
    // runner would.
    const cachePolicy = dryRun ? null : stepCache.cachePolicy(node)
    let cacheKey = null
    if (cachePolicy) {
      try {
        const config = resolveTemplates(node.data?.config || {}, {
          ...context,
          secrets,
          vars,
          callbacks: callbackUrls,
        })
        cacheKey = stepCache.cacheKey(workflowId, node.type, config, input)
        const hit = stepCache.lookup(cacheKey)
        if (hit) {
          const output = JSON.parse(hit.outputJson)
          context[nodeId] = output
          nodeStatus[nodeId] = 'success'
          updateStep.run(
            'cached', redact(JSON.stringify(input)), hit.outputJson, null,
            now(), now(), stepIdByNode[nodeId]
          )
          publishStep(nodeId, 'cached', { output })
          recordStepCache('hit')
          return
        }
        recordStepCache('miss')
      } catch (err) {
        console.error(`Step cache read failed for ${nodeId}: ${err.message}`)
      }
    }

    updateStep.run('running', redact(JSON.stringify(input)), null, null, now(), null, stepIdByNode[nodeId])
    publishStep(nodeId, 'running')

    // Decided synchronously so the round loop below cannot launch a sibling
    // between here and the pause the task is about to take.
    const willBreak = Boolean(debugPlan?.shouldBreak(nodeId))
    if (willBreak) openBreaks += 1

    const task = (async () => {
      try {
        // Config templates resolve against upstream outputs plus the decrypted
        // secrets map ({{secrets.NAME}}), the workspace's variables
        // ({{vars.NAME}}), and the run's callback URLs
        // ({{callbacks.<node-id>}}). Secrets ride only through this scope —
        // never through context — so they can't leak into a later node's input.
        let config = resolveTemplates(node.data?.config || {}, {
          ...context,
          secrets,
          vars,
          callbacks: callbackUrls,
        })

        // The breakpoint sits exactly here: after the config is resolved and
        // before the runner is called. It is the only moment where both facts
        // exist at once — what the node received, and what it is about to do
        // with it — and by the time either reaches a step row the interesting
        // intermediate is gone.
        if (willBreak) {
          const decision = await debuggerService.pauseAt({
            executionId,
            node,
            input,
            config,
            redact,
            publish: pub,
            isCancelled: isCancelRequested,
          })
          debugPlan.apply(decision.action)
          if (decision.action === 'abort') {
            db.prepare('UPDATE executions SET cancel_requested = 1 WHERE id = ?').run(executionId)
          }
          // An override is a patch over what the node was *about* to use, so it
          // merges rather than replaces — somebody changing one header should
          // not have to retype the URL. The step's recorded input is rewritten
          // to match, because a run whose history shows the pre-override value
          // would be a debugger that lies about what it did.
          if (decision.override?.config) {
            config = { ...config, ...decision.override.config }
          }
          if (decision.override?.input) {
            Object.assign(input, decision.override.input)
            updateStep.run(
              'running', redact(JSON.stringify(input)), null, null, now(), null,
              stepIdByNode[nodeId]
            )
          }
        }
        // Engine context for runners that need to reach back into the engine (only
        // sub-workflow does today): the call stack for cycle detection, the parent
        // execution + node so a spawned child run can be linked back, and the publish
        // fn so nested events ride the same channel.
        const ctx = {
          ancestorWorkflowIds: callStack,
          parentExecutionId: executionId,
          parentNodeId: nodeId,
          publish: pub,
          // The W3C header identifying *this step* as the caller. A runner that
          // reaches outside (the HTTP node today) forwards it, so the service on
          // the other side records its work as a child of this exact step rather
          // than of the run as a whole.
          traceparent: tracing.formatTraceparent(traceId, spanIdByNode[nodeId], true),
          // The `Idempotency-Key` for this step, when its author declared the
          // endpoint deduplicates. Computed here rather than in the runner for
          // the same reason `onError` and the cache policy are read here: the
          // decision comes from the node's **raw** config, so upstream data can
          // never switch it on or off. Null on every node that did not ask.
          idempotencyKey: stepIdempotency.headerFor(node, {
            parentExecutionId: executionId,
            parentNodeId: nodeId,
          }),
        }
        // A previewed node settles from the value the caller supplied rather
        // than running, expressed as a synthetic `stub` fault so it travels the
        // same path every other node does. That is not incidental: the task
        // below inserts itself into `inFlight` *after* it starts, so a body
        // that never awaited would delete its own entry before the entry
        // existed and leave the scheduler spinning on a settled promise
        // forever. Every runner is async and awaited, which is what makes that
        // unreachable — and a short-circuit here would have quietly made it
        // reachable again.
        //
        // The step is still recorded either way, which is the point: the
        // preview diffs *paths*, and a node with no step row is
        // indistinguishable from one that was skipped.
        const stub = preview?.stubs?.[nodeId]
        // Resolved once, before the retry ladder, so a `fail` rule exercises
        // the retries rather than re-rolling its luck between them.
        const fault = stub !== undefined
          ? { mode: 'stub', output: stub, silent: true }
          : faultInjection.faultFor(chaosProfile, node, { executionId, dryRun })
        const raw = (await runWithRetries(node, config, input, dryRun, ctx, fault)) ?? {}
        // Metering rides back from a runner on a reserved `usage` key, which is
        // then stripped: cost accounting is a side channel from runner to
        // engine, not data. Leaving it in would put token counts into the
        // context every downstream node reads, into persisted step output, and
        // into the run's return value — three places it has no business being.
        meterStep(node, raw)
        const output = stripUsage(raw)
        context[nodeId] = output
        nodeStatus[nodeId] = 'success'
        const outputJson = redact(JSON.stringify(output))
        updateStep.run(
          'succeeded', redact(JSON.stringify(input)), outputJson, null,
          now(), now(), stepIdByNode[nodeId]
        )
        publishStep(nodeId, 'succeeded', { output })
        markCompleted(nodeId)
        // Only clean successes are memoised — a caught failure is data, not
        // a result worth replaying. cacheKey was derived in launchNode from
        // the same resolved config and input this attempt just ran with.
        if (cachePolicy && cacheKey) {
          try {
            if (
              stepCache.store(cacheKey, {
                workflowId,
                nodeId,
                outputJson,
                ttlSeconds: cachePolicy.ttlSeconds,
              })
            ) {
              recordStepCache('store')
            }
          } catch (err) {
            console.error(`Step cache store failed for ${nodeId}: ${err.message}`)
          }
        }
      } catch (err) {
        const policy = errorPolicy(node)
        if (policy !== 'fail') {
          // Caught: the failure becomes data instead of failing the run. The
          // step records 'caught' — the node really did fail after its
          // retries, and hiding that would corrupt the timeline — but it
          // settles as routable: 'continue' proceeds down the normal edges
          // with the error object as its output, 'branch' activates only the
          // dedicated error handle (see activeIncomingFor).
          const output = {
            failed: true,
            error: { message: err.message, nodeId, nodeType: node.type },
          }
          context[nodeId] = output
          nodeStatus[nodeId] = 'success'
          caughtNodes.add(nodeId)
          if (policy === 'branch') caughtBranch.add(nodeId)
          updateStep.run(
            'caught', redact(JSON.stringify(input)), redact(JSON.stringify(output)),
            redact(err.message), now(), now(), stepIdByNode[nodeId]
          )
          publishStep(nodeId, 'caught', { output, error: err.message })
          markCompleted(nodeId)
        } else {
          nodeStatus[nodeId] = 'failed'
          updateStep.run(
            'failed', redact(JSON.stringify(input)), null, redact(err.message),
            now(), now(), stepIdByNode[nodeId]
          )
          publishStep(nodeId, 'failed', { error: err.message })
          markCompleted(nodeId)
          if (!failure) failure = { node, err }
        }
      } finally {
        // Released here rather than beside the pause: a config that fails to
        // resolve throws before the break is ever taken, and an unreleased
        // counter would stop the scheduler launching anything ever again.
        if (willBreak) openBreaks -= 1
        inFlight.delete(nodeId)
      }
    })()
    inFlight.set(nodeId, task)
  }

  // A node is ready once every upstream node has settled — succeeded, failed or
  // skipped. Whether it then *runs* is a separate question (a node all of whose
  // active incoming edges are dark is skipped, not launched).
  const isReady = (nodeId) =>
    incomingByNode[nodeId].every((e) => nodeStatus[e.source] !== undefined)

  // One scheduling round, in two phases.
  //
  // Splitting them is what makes the launch order mean anything. Settling and
  // launching used to interleave in a single pass over the topological order, so
  // the "ready set" a launch decision saw was whatever had been reached so far —
  // and a node further down the list could be both ready and better to start,
  // with nothing having looked at it yet. The ready set is only the real ready
  // set once everything that settles for free has settled.
  function scheduleRound() {
    let progressed = true
    while (progressed && !failure) {
      progressed = false

      // Phase 1 — synchronous settlements, to a fixed point. A dead branch is
      // skipped and a resumed run's healthy prefix is reused without ever
      // occupying an execution slot, and either can cascade into the next node,
      // so this loops until nothing more settles.
      let settled = true
      while (settled && !failure) {
        settled = false
        for (let i = 0; i < unscheduled.length; ) {
          const nodeId = unscheduled[i]
          if (!isReady(nodeId)) {
            i++
            continue
          }
          const incoming = incomingByNode[nodeId]
          if (incoming.length > 0 && activeIncomingFor(nodeId).length === 0) {
            unscheduled.splice(i, 1)
            skipNode(nodeId)
            settled = true
            progressed = true
          } else if (canReuse(nodeId)) {
            unscheduled.splice(i, 1)
            reuseNode(nodeId)
            settled = true
            progressed = true
          } else {
            i++
          }
        }
      }
      if (failure) break

      // Phase 2 — launch, highest priority first, while capacity allows.
      //
      // `openBreaks === 0` is what makes a breakpoint stop the *run* rather than
      // one branch of it. Without it a parallel sibling races ahead while
      // somebody is reading the node they stopped at, and the state they are
      // inspecting is already stale — which is precisely the thing a debugger
      // exists to prevent.
      if (openBreaks !== 0) break
      const launchable = unscheduled.filter(isReady)
      if (launchable.length === 0) break
      launchable.sort(launchPlan.compare)
      for (const nodeId of launchable) {
        if (failure || openBreaks !== 0 || inFlight.size >= cap) break
        unscheduled.splice(unscheduled.indexOf(nodeId), 1)
        // Not necessarily asynchronous: a step-cache hit settles inside
        // launchNode without occupying a slot, which can make a downstream node
        // ready. `progressed` sends us round again so that node is considered in
        // this same round rather than after the next await.
        launchNode(nodeId)
        progressed = true
      }
    }
  }

  while (unscheduled.length > 0 || inFlight.size > 0) {
    if (cancelCheck.get(executionId)?.cancel_requested) {
      cancelled = true
      break
    }
    // Somebody else now owns this run — the recovery sweep decided this worker
    // was gone and adopted it. Stop launching and write nothing terminal: the
    // adopter's record is the true one. Cooperative and inter-node, exactly
    // like cancellation, because tearing down a half-sent HTTP call is worse
    // than letting it finish into a run nobody is watching.
    if (leaseToken && !executionLease.held(executionId, leaseToken)) {
      leaseLost = true
      break
    }
    scheduleRound()
    if (failure) break
    if (inFlight.size === 0) {
      // Nothing running and nothing schedulable: with a valid DAG this only
      // means everything is settled.
      break
    }
    // Wait for any in-flight node to settle, then reschedule.
    await Promise.race(inFlight.values())
  }

  // Let in-flight siblings of a failed/cancelled run finish and record results.
  if (inFlight.size > 0) await Promise.all([...inFlight.values()])

  // Defensive: a pause always resolves or throws inside its own task, so by
  // here nothing should still be open. A worker that died mid-break is the case
  // this covers, and an orphaned 'paused' row would show the panel a pause
  // nothing is waiting on.
  if (debugPlan) debuggerService.settleOpenBreaks(executionId)

  // Compensating transactions: unwind the side effects this run already caused.
  // Deliberately runs *after* the terminal status is written and published —
  // the run failed, and that fact is not contingent on how well the cleanup
  // goes. A watcher sees `failed`, then the compensations, then the rollback
  // verdict, which is also the order the operator needs to reason in.
  //
  // Nested runs are not special-cased: a sub-workflow child that fails unwinds
  // its own compensations, and the parent then unwinds its own, which is
  // precisely how nested sagas are supposed to compose.
  //
  // Best-effort in full. A rollback that throws must never mask the run's real
  // outcome — the record of what failed is worth more than the cleanup.
  async function maybeRollback(reason) {
    if (!compensation.shouldRollback(compensation.rollbackPolicy(workflow), reason)) return
    if (plan.byTarget.size === 0 || completionOrder.length === 0) return
    try {
      await executeRollback({
        executionId,
        workflowId,
        workspaceId: workflow.workspace_id,
        graphNodes: graph.nodes || [],
        plan,
        // Genuine successes only: `caught` nodes settle as 'success' so the
        // scheduler can route past them, but they failed — the manual path
        // reaches the same set by selecting on the step's recorded status.
        completedNodeIds: completionOrder.filter(
          (id) => nodeStatus[id] === 'success' && !caughtNodes.has(id)
        ),
        context,
        secrets,
        vars,
        redact,
        publish: pub,
        dryRun,
        failureContext: {
          nodeId: failure?.node?.id ?? null,
          error: failure?.err?.message ?? null,
          reason,
        },
        callStack,
        traceparent: tracing.formatTraceparent(traceId, rootSpanId, true),
      })
    } catch (err) {
      console.error(`Rollback failed for execution ${executionId}: ${err.message}`)
    }
  }

  // Lost the lease: another worker adopted this run and is (or already has
  // been) recording its outcome. Persisting anything here would fight it, and
  // rolling back would unwind side effects the adopter may be relying on.
  // Every fenced write above would have been refused anyway; returning early
  // makes that explicit rather than incidental.
  if (leaseLost) {
    console.warn(`Execution ${executionId} lost its lease mid-run — another worker owns it`)
    return {}
  }

  if (failure) {
    // Everything that never launched is skipped, then the run fails. A failure
    // takes precedence over a concurrent cancel request — it says more.
    for (const nodeId of unscheduled) skipNode(nodeId)
    persistRunCost()
    failExecution(
      `Node "${failure.node.data?.label || failure.node.id}" failed: ${failure.err.message}`
    )
    await maybeRollback('failed')
    return
  }

  if (cancelled) {
    for (const nodeId of unscheduled) skipNode(nodeId)
    persistRunCost()
    settleLeftoverCallbacks()
    updateExecution.run('cancelled', now(), now(), executionId)
    publishExecution('cancelled')
    logRunActivity('execution.cancelled')
    recordTerminal('cancelled')
    await maybeRollback('cancelled')
    return {}
  }

  persistRunCost()
  settleLeftoverCallbacks()
  updateExecution.run('completed', new Date().toISOString(), new Date().toISOString(), executionId)
  publishExecution('completed')
  logRunActivity('execution.completed')
  recordTerminal('completed')

  // A run's final output: its output-return node's output if it has one, else the
  // last node (in execution order) that produced output. Returned so a parent
  // sub-workflow node can adopt it as that node's own output. The Bull worker and
  // other callers ignore the return value.
  const returnId = order.find((id) => nodeById[id]?.type === 'output-return')
  if (returnId && context[returnId] !== undefined) return context[returnId]
  for (let i = order.length - 1; i >= 0; i--) {
    if (context[order[i]] !== undefined) return context[order[i]]
  }
  return {}
}

// — the rollback pass ————————————————————————————————————————————————————
//
// Run the compensating actions for a run that ended badly, newest side effect
// first. This is the saga unwind: strictly sequential, tolerant of its own
// failures, and never repeating a compensation that already took.
//
// It is deliberately a plain function over explicit inputs rather than a method
// on the run, because it has two callers with different provenance for the same
// arguments: the engine hands it the live in-memory context immediately after a
// failure, and the manual rollback endpoint rebuilds an equivalent one from the
// persisted steps hours later. Both go through this one body, so "what a
// rollback does" cannot drift between the automatic and the manual path.
async function executeRollback({
  executionId,
  workflowId,
  workspaceId,
  graphNodes,
  plan,
  completedNodeIds,
  context,
  secrets = {},
  vars = {},
  redact = (s) => s,
  publish,
  dryRun = false,
  already,
  failureContext = {},
  callStack = [],
  traceparent = null,
}) {
  const byTarget = plan?.byTarget instanceof Map ? plan.byTarget : new Map()
  const sequence = compensation.rollbackSequence(completedNodeIds, byTarget, { already })
  if (sequence.length === 0) return { outcome: null, results: [] }

  const pub = publish || defaultPublish
  const insertCompensation = db.prepare(`
    INSERT INTO execution_compensations
      (id, execution_id, node_id, target_node_id, node_type, seq, status,
       input_json, output_json, error, attempts, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const labelOf = (id) =>
    graphNodes?.find?.((n) => n.id === id)?.data?.label || id

  // What the compensating node can read about *why* it is running. The target's
  // own output is already addressable as {{<target-id>.field}} — the whole run
  // context is in scope, because a compensation runs after the fact and is not
  // bound by the upstream rule that governs the forward pass. This adds the one
  // thing the graph cannot express: the failure that caused the unwind, so a
  // "post to the incident channel" compensation can say what happened.
  const rollbackScope = {
    executionId,
    workflowId,
    failedNode: failureContext.nodeId ?? null,
    failedNodeLabel: failureContext.nodeId ? labelOf(failureContext.nodeId) : null,
    error: failureContext.error ?? null,
    reason: failureContext.reason ?? 'failed',
  }

  const publishCompensation = (node, targetId, seq, state, extra = {}) => {
    pub({
      kind: 'compensation',
      workflowId,
      executionId,
      nodeId: node.id,
      targetNodeId: targetId,
      seq,
      status: state,
      output: extra.output != null ? redactDeep(extra.output, redact) : null,
      error: extra.error != null ? redact(extra.error) : null,
    })
  }

  const results = []
  for (const [index, { node, targetId }] of sequence.entries()) {
    const startedAt = new Date().toISOString()
    // The compensation's input is the output of the step it is undoing: the
    // charge id to refund, the reservation to release. Handing it the thing it
    // has to reverse is the only input that is always meaningful.
    const input = context?.[targetId] ?? {}
    publishCompensation(node, targetId, index, 'running')

    // Compensations retry on the same ladder as forward steps — the stakes are
    // higher, not lower, since a forward step that stays failed fails a run
    // while a compensation that stays failed leaves the outside world
    // inconsistent. Spelled out here rather than reusing runWithRetries so the
    // attempt count is *recorded*: "this refund went through on the third try"
    // is exactly the sort of thing you want in the record when reconciling an
    // incident, and a shared helper that swallows the count cannot provide it.
    const maxAttempts = SINGLE_ATTEMPT_TYPES.has(node.type) ? 1 : MAX_ATTEMPTS
    let attempts = 0
    let status = 'succeeded'
    let output = null
    let error = null

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attempts = attempt
      try {
        const config = resolveTemplates(node.data?.config || {}, {
          ...context,
          secrets,
          vars,
          rollback: rollbackScope,
        })
        const ctx = {
          ancestorWorkflowIds: callStack,
          parentExecutionId: executionId,
          parentNodeId: node.id,
          publish: pub,
          traceparent,
        }
        output = stripUsage((await getRunner(node.type)(config, input, dryRun, ctx)) ?? {})
        status = 'succeeded'
        error = null
        break
      } catch (err) {
        // A compensation that exhausts its retries does not stop the rollback.
        // The run has already failed — there is no worse status to reach — and
        // stopping here would strand every compensation *further back*, which
        // protect the earliest and usually most expensive side effects. Record
        // it, keep unwinding, and let the run settle as `partial`.
        status = 'failed'
        error = err.message
        if (attempt < maxAttempts) await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1))
      }
    }

    try {
      insertCompensation.run(
        uuidv4(), executionId, node.id, targetId, node.type, index, status,
        redact(JSON.stringify(input)),
        output == null ? null : redact(JSON.stringify(output)),
        error == null ? null : redact(error),
        attempts, startedAt, new Date().toISOString()
      )
    } catch (err) {
      console.error(`Failed to record compensation for ${node.id}: ${err.message}`)
    }
    recordCompensation(status)
    results.push({ nodeId: node.id, targetNodeId: targetId, status, attempts, error })
    publishCompensation(node, targetId, index, status, { output, error })
  }

  const outcome = compensation.rollbackOutcome(results)
  try {
    db.prepare('UPDATE executions SET rollback_status = ? WHERE id = ?').run(outcome, executionId)
  } catch (err) {
    console.error(`Failed to record rollback status: ${err.message}`)
  }
  if (outcome) recordRollback(outcome)
  pub({ kind: 'rollback', workflowId, executionId, status: outcome, compensated: results.length })

  // A partial rollback is workspace-visible news: some of the run's side effects
  // are still standing and a person has to decide what to do about them. A clean
  // unwind is not — it is the machinery working, and an activity feed that
  // announced every successful undo would bury the one that mattered.
  if (outcome === 'partial' && !dryRun && workspaceId) {
    try {
      require('./activityService').logEvent(workspaceId, null, 'execution.rollback_partial', {
        type: 'execution',
        id: executionId,
        name: rollbackScope.failedNodeLabel || 'run',
        metadata: {
          workflowId,
          failed: results.filter((r) => r.status === 'failed').map((r) => r.nodeId),
        },
      })
    } catch (err) {
      console.error(`Failed to log partial rollback: ${err.message}`)
    }
  }

  return { outcome, results }
}

// Manually unwind (or finish unwinding) a run that already settled.
//
// The endpoint behind `flowforge rollback`. Everything the engine held in
// memory is reconstructed from the persisted run: the graph it executed, the
// outputs its steps recorded, and the order they completed in. Two properties
// follow from that reconstruction and are deliberate.
//
// The context is the *redacted* persisted output, exactly as resume-from-failure
// adopts it — a secret echoed back by an API in the original run does not
// survive into a compensation's config hours later.
//
// And the graph is re-read now, not as it was: a compensation node added or
// repaired after the failure will run. That is the entire reason this endpoint
// exists — the common case for a partial rollback is that the compensating
// endpoint was itself broken, and retrying the old definition would simply fail
// the same way.
async function rollbackExecution(executionId, { publish, dryRun = false } = {}) {
  const execution = db.prepare('SELECT * FROM executions WHERE id = ?').get(executionId)
  if (!execution) throw new Error(`Execution ${executionId} not found`)
  const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(execution.workflow_id)
  if (!workflow) throw new Error(`Workflow ${execution.workflow_id} not found`)

  const version = execution.graph_version_id
    ? db.prepare('SELECT graph_json FROM workflow_versions WHERE id = ?').get(execution.graph_version_id)
    : null
  const graph = JSON.parse(version?.graph_json || workflow.graph_json)
  const plan = compensation.compensationPlan(graph.nodes || [])

  // Rebuild the run's data context from what the steps recorded. Every settled
  // status that carries an output is included — a compensation may legitimately
  // reference a cached or reused value even though those nodes are not
  // themselves compensated.
  const steps = db.prepare(
    `SELECT node_id, status, output_json, error, completed_seq
       FROM execution_steps WHERE execution_id = ?`
  ).all(executionId)
  const context = {}
  for (const step of steps) {
    if (!step.output_json) continue
    try {
      context[step.node_id] = JSON.parse(step.output_json)
    } catch {
      /* unparseable persisted output contributes nothing to the scope */
    }
  }

  const completedNodeIds = steps
    .filter((s) => s.completed_seq != null && s.status === 'succeeded')
    .sort((a, b) => a.completed_seq - b.completed_seq)
    .map((s) => s.node_id)

  // Resume, never repeat: a compensation that already succeeded is not run
  // again. Double-refunding a customer while cleaning up after a failure is a
  // worse outcome than the failure was.
  const already = new Set(
    db.prepare(
      "SELECT target_node_id FROM execution_compensations WHERE execution_id = ? AND status = 'succeeded'"
    ).all(executionId).map((r) => r.target_node_id)
  )

  const failedStep = steps.find((s) => s.status === 'failed')
  const secrets = loadWorkspaceSecrets(workflow.workspace_id)

  return executeRollback({
    executionId,
    workflowId: workflow.id,
    workspaceId: workflow.workspace_id,
    graphNodes: graph.nodes || [],
    plan,
    completedNodeIds,
    context,
    secrets,
    vars: loadWorkspaceVariables(workflow.workspace_id),
    redact: buildRedactor(Object.values(secrets)),
    publish,
    dryRun,
    already,
    failureContext: {
      nodeId: failedStep?.node_id ?? null,
      error: failedStep?.error ?? null,
      reason: execution.status === 'cancelled' ? 'cancelled' : 'failed',
    },
    callStack: [workflow.id],
    traceparent: execution.trace_id && execution.root_span_id
      ? tracing.formatTraceparent(execution.trace_id, execution.root_span_id, true)
      : null,
  })
}

module.exports = {
  runExecution,
  executeRollback,
  rollbackExecution,
  resolveTemplates,
  // Shared with the node test bench (routes/workflows.js test-node): running a
  // single node outside a run needs the same runner lookup, secret loading,
  // and redaction pipeline the engine uses — re-implementing them would let
  // the two paths drift.
  getRunner,
  loadWorkspaceSecrets,
  loadWorkspaceVariables,
  buildRedactor,
  redactDeep,
  // The node test bench drives runners directly, so it needs the same
  // usage-stripping the engine applies — otherwise benching an AI node would
  // show metering fields a real run never surfaces.
  stripUsage,
}
