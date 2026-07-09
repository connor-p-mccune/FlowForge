// Execution engine: parses the workflow graph into a DAG and runs it with a
// ready-set scheduler — a node becomes runnable once every upstream node has
// settled, and independent branches run concurrently (bounded by
// EXEC_MAX_PARALLEL). Resolves {{node-id.field}} templates from the execution
// context, retries failures with exponential backoff, records every step in
// execution_steps, and publishes exec-update events (Redis pub/sub by default).

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const { buildAdjacency, topoSort } = require('./dagParser')
const { decryptSecret } = require('./secretVault')
const { recordExecution } = require('./metrics')

const runners = {
  'action-http': require('./nodeRunners/httpRequest'),
  'action-delay': require('./nodeRunners/delay'),
  'action-email': require('./nodeRunners/sendEmail'),
  'action-slack': require('./nodeRunners/sendSlack'),
  'transform': require('./nodeRunners/transform'),
  'condition': require('./nodeRunners/condition'),
  'ai-prompt': require('./nodeRunners/llmPrompt'),
  'ai-classify': require('./nodeRunners/classify'),
  'ai-extract': require('./nodeRunners/extract'),
  'output-log': require('./nodeRunners/outputLog'),
  'output-return': require('./nodeRunners/outputReturn'),
  'sub-workflow': require('./nodeRunners/subWorkflow'),
  'for-each': require('./nodeRunners/forEach'),
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
  // Sub-workflow and for-each nodes run entire nested executions that already
  // retry their own nodes. Retrying them here would re-run whole sub-workflows
  // on any inner failure — duplicate side effects and duplicate child execution
  // rows — so they get a single attempt; everything else keeps the standard
  // retry-with-backoff.
  const nested = node.type === 'sub-workflow' || node.type === 'for-each'
  const maxAttempts = nested ? 1 : MAX_ATTEMPTS
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
  const { nodes = [], edges = [] } = JSON.parse(workflow.graph_json)
  const nodeById = Object.fromEntries(nodes.map((n) => [n.id, n]))

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
      const sourceNode = nodeById[e.source]
      // Condition nodes only activate the matching true/false branch
      if (sourceNode?.type === 'condition' && e.sourceHandle != null) {
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

    updateStep.run('running', redact(JSON.stringify(input)), null, null, now(), null, stepIdByNode[nodeId])
    publishStep(nodeId, 'running')

    const task = (async () => {
      try {
        // Config templates resolve against upstream outputs plus the decrypted
        // secrets map ({{secrets.NAME}}). Secrets ride only through this scope —
        // never through context — so they can't leak into a later node's input.
        const config = resolveTemplates(node.data?.config || {}, { ...context, secrets })
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
        updateStep.run(
          'succeeded', redact(JSON.stringify(input)), redact(JSON.stringify(output)), null,
          now(), now(), stepIdByNode[nodeId]
        )
        publishStep(nodeId, 'succeeded', { output })
      } catch (err) {
        nodeStatus[nodeId] = 'failed'
        updateStep.run(
          'failed', redact(JSON.stringify(input)), null, redact(err.message),
          now(), now(), stepIdByNode[nodeId]
        )
        publishStep(nodeId, 'failed', { error: err.message })
        if (!failure) failure = { node, err }
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
    updateExecution.run('cancelled', now(), now(), executionId)
    publishExecution('cancelled')
    logRunActivity('execution.cancelled')
    recordTerminal('cancelled')
    return {}
  }

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

module.exports = { runExecution, resolveTemplates }
