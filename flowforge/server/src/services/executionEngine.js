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
// strictly sequential execution. Read per-run so tests can vary it.
function maxParallel() {
  const n = parseInt(process.env.EXEC_MAX_PARALLEL || '4', 10)
  return Number.isFinite(n) && n >= 1 ? n : 4
}

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
  recordFaultInjected(fault.mode)
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
  for (let attempt = 1; ; attempt++) {
    try {
      return await runner(config, input, isDryRun, ctx)
    } catch (err) {
      if (attempt >= maxAttempts) throw err
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1))
    }
  }
}

// dryRun (test mode): side-effecting node runners (email/Slack/HTTP) skip their
// external call and instead return what they *would* have sent. Everything else
// — conditions, transforms, AI nodes — runs for real, so test output is genuine.
async function runExecution(
  executionId,
  { publish, payload, dryRun = false, ancestorWorkflowIds = [] } = {}
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
  const redact = buildRedactor(Object.values(secrets))

  // Progressive delivery. While a canary is running, this run executes either
  // the live canvas (the edits under test) or the pinned baseline version — and
  // which one it got is recorded on the row, because that label is the entire
  // experiment. Everything else below is unchanged: the engine reads one graph
  // per run, it just no longer assumes that graph is the workflow's current
  // one. Dry runs, resumes, and workflows with no canary all resolve to the
  // live graph, so this is a no-op for every run that isn't in an experiment.
  const release = canary.resolveRelease(execution, workflow, { dryRun })
  canary.recordRelease(executionId, release)
  const graph = JSON.parse(release.graphJson)

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

  const updateExecution = db.prepare(
    'UPDATE executions SET status = ?, started_at = COALESCE(started_at, ?), finished_at = ? WHERE id = ?'
  )

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
  const inFlight = new Map() // nodeId -> settling promise (never rejects)
  let failure = null // first { node, err }, wins the run's error message

  // Cooperative cancellation: the cancel route flips cancel_requested on the
  // row; we poll it once per scheduling round (i.e. every time a node settles)
  // and wind the run down instead of launching anything further. A node that is
  // already in flight always runs to completion — cancellation is inter-node.
  const cancelCheck = db.prepare('SELECT cancel_requested FROM executions WHERE id = ?')
  let cancelled = false

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

    const task = (async () => {
      try {
        // Config templates resolve against upstream outputs plus the decrypted
        // secrets map ({{secrets.NAME}}), the workspace's variables
        // ({{vars.NAME}}), and the run's callback URLs
        // ({{callbacks.<node-id>}}). Secrets ride only through this scope —
        // never through context — so they can't leak into a later node's input.
        const config = resolveTemplates(node.data?.config || {}, {
          ...context,
          secrets,
          vars,
          callbacks: callbackUrls,
        })
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
        }
        // Resolved once, before the retry ladder, so a `fail` rule exercises
        // the retries rather than re-rolling its luck between them.
        const fault = faultInjection.faultFor(chaosProfile, node, { executionId, dryRun })
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
        inFlight.delete(nodeId)
      }
    })()
    inFlight.set(nodeId, task)
  }

  // One synchronous pass: settle every skippable ready node (looping because a
  // skip can make a downstream node ready-and-skippable) and launch ready
  // runnable nodes while capacity allows.
  function scheduleRound() {
    let progressed = true
    while (progressed && !failure) {
      progressed = false
      for (let i = 0; i < unscheduled.length; ) {
        const nodeId = unscheduled[i]
        const ready = incomingByNode[nodeId].every((e) => nodeStatus[e.source] !== undefined)
        if (!ready) {
          i++
          continue
        }
        const incoming = incomingByNode[nodeId]
        if (incoming.length > 0 && activeIncomingFor(nodeId).length === 0) {
          unscheduled.splice(i, 1)
          skipNode(nodeId)
          progressed = true
        } else if (canReuse(nodeId)) {
          // Reuse settles synchronously, like a skip — it never occupies an
          // execution slot, so a resumed run's healthy prefix replays in one
          // pass regardless of the parallelism cap.
          unscheduled.splice(i, 1)
          reuseNode(nodeId)
          progressed = true
        } else if (inFlight.size < cap) {
          unscheduled.splice(i, 1)
          launchNode(nodeId)
          progressed = true
        } else {
          i++
        }
      }
    }
  }

  while (unscheduled.length > 0 || inFlight.size > 0) {
    if (cancelCheck.get(executionId)?.cancel_requested) {
      cancelled = true
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
