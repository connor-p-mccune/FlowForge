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
const { recordExecution, recordStepCache } = require('./metrics')
const stepCache = require('./stepCache')

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

function defaultPublish(payload) {
  // Lazy require so engine unit tests never touch Redis
  const redis = require('../config/redis')
  redis
    .publish('exec-update', JSON.stringify(payload))
    .catch((err) => console.error('Failed to publish exec-update:', err.message))
}

async function runWithRetries(node, config, input, isDryRun, ctx) {
  const runner = getRunner(node.type)
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
  const redact = buildRedactor(Object.values(secrets))
  const graph = JSON.parse(workflow.graph_json)
  // Sticky notes are canvas annotations, not steps: they never execute, get
  // no step rows, and any edge touching one (only possible in a hand-edited
  // import — the UI renders notes without handles) is dropped with them.
  const noteIds = new Set((graph.nodes || []).filter((n) => n.type === 'note').map((n) => n.id))
  const nodes = (graph.nodes || []).filter((n) => !noteIds.has(n.id))
  const edges = (graph.edges || []).filter((e) => !noteIds.has(e.source) && !noteIds.has(e.target))
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
  for (const nodeId of order) {
    const stepId = uuidv4()
    stepIdByNode[nodeId] = stepId
    insertStep.run(stepId, executionId, nodeId, nodeById[nodeId]?.type ?? null, 'pending')
  }

  const updateStep = db.prepare(`
    UPDATE execution_steps
    SET status = ?, input_json = ?, output_json = ?, error = ?,
        started_at = COALESCE(started_at, ?), finished_at = ?
    WHERE id = ?
  `)

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
        // secrets map ({{secrets.NAME}}) and the run's callback URLs
        // ({{callbacks.<node-id>}}). Secrets ride only through this scope —
        // never through context — so they can't leak into a later node's input.
        const config = resolveTemplates(node.data?.config || {}, {
          ...context,
          secrets,
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
        }
        const output = (await runWithRetries(node, config, input, dryRun, ctx)) ?? {}
        context[nodeId] = output
        nodeStatus[nodeId] = 'success'
        const outputJson = redact(JSON.stringify(output))
        updateStep.run(
          'succeeded', redact(JSON.stringify(input)), outputJson, null,
          now(), now(), stepIdByNode[nodeId]
        )
        publishStep(nodeId, 'succeeded', { output })
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
          if (policy === 'branch') caughtBranch.add(nodeId)
          updateStep.run(
            'caught', redact(JSON.stringify(input)), redact(JSON.stringify(output)),
            redact(err.message), now(), now(), stepIdByNode[nodeId]
          )
          publishStep(nodeId, 'caught', { output, error: err.message })
        } else {
          nodeStatus[nodeId] = 'failed'
          updateStep.run(
            'failed', redact(JSON.stringify(input)), null, redact(err.message),
            now(), now(), stepIdByNode[nodeId]
          )
          publishStep(nodeId, 'failed', { error: err.message })
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

  if (failure) {
    // Everything that never launched is skipped, then the run fails. A failure
    // takes precedence over a concurrent cancel request — it says more.
    for (const nodeId of unscheduled) skipNode(nodeId)
    failExecution(
      `Node "${failure.node.data?.label || failure.node.id}" failed: ${failure.err.message}`
    )
    return
  }

  if (cancelled) {
    for (const nodeId of unscheduled) skipNode(nodeId)
    settleLeftoverCallbacks()
    updateExecution.run('cancelled', now(), now(), executionId)
    publishExecution('cancelled')
    logRunActivity('execution.cancelled')
    recordTerminal('cancelled')
    return {}
  }

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

module.exports = {
  runExecution,
  resolveTemplates,
  // Shared with the node test bench (routes/workflows.js test-node): running a
  // single node outside a run needs the same runner lookup, secret loading,
  // and redaction pipeline the engine uses — re-implementing them would let
  // the two paths drift.
  getRunner,
  loadWorkspaceSecrets,
  buildRedactor,
  redactDeep,
}
