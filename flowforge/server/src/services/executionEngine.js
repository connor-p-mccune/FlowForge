// Execution engine: parses the workflow graph into a DAG, runs each node in
// topological order, resolves {{node-id.field}} templates from the execution
// context, retries failures with exponential backoff, records every step in
// execution_steps, and publishes exec-update events (Redis pub/sub by default).

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const { buildAdjacency, topoSort } = require('./dagParser')
const { decryptSecret } = require('./secretVault')

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
}

const MAX_ATTEMPTS = parseInt(process.env.EXEC_MAX_ATTEMPTS || '3')
const BASE_BACKOFF_MS = parseInt(process.env.EXEC_RETRY_BASE_MS || '500')

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
  // A sub-workflow node runs an entire nested execution that already retries its
  // own nodes. Retrying it here would re-run the whole sub-workflow on any inner
  // failure — duplicate side effects and duplicate child execution rows — so it
  // gets a single attempt; everything else keeps the standard retry-with-backoff.
  const maxAttempts = node.type === 'sub-workflow' ? 1 : MAX_ATTEMPTS
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
  const nodeStatus = {} // nodeId -> 'success' | 'failed' | 'skipped'

  for (let i = 0; i < order.length; i++) {
    const nodeId = order[i]
    const node = nodeById[nodeId]
    const now = () => new Date().toISOString()

    const incoming = edges.filter((e) => e.target === nodeId)
    const activeIncoming = incoming.filter((e) => {
      if (nodeStatus[e.source] !== 'success') return false
      const sourceNode = nodeById[e.source]
      // Condition nodes only activate the matching true/false branch
      if (sourceNode?.type === 'condition' && e.sourceHandle != null) {
        return String(context[e.source]?.result) === e.sourceHandle
      }
      return true
    })

    if (incoming.length > 0 && activeIncoming.length === 0) {
      nodeStatus[nodeId] = 'skipped'
      updateStep.run('skipped', null, null, null, now(), now(), stepIdByNode[nodeId])
      publishStep(nodeId, 'skipped')
      continue
    }

    // Input = merged outputs of all active upstream nodes. Trigger (source)
    // nodes start from the run's trigger payload instead of an empty object.
    const baseInput = node.type.startsWith('trigger-') ? { ...triggerPayload } : {}
    const input = Object.assign(baseInput, ...activeIncoming.map((e) => context[e.source] || {}))

    updateStep.run('running', redact(JSON.stringify(input)), null, null, now(), null, stepIdByNode[nodeId])
    publishStep(nodeId, 'running')

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

      // Mark everything downstream as skipped and fail the run
      for (const remainingId of order.slice(i + 1)) {
        updateStep.run('skipped', null, null, null, now(), now(), stepIdByNode[remainingId])
        publishStep(remainingId, 'skipped')
      }
      failExecution(`Node "${node.data?.label || nodeId}" failed: ${err.message}`)
      return
    }
  }

  updateExecution.run('completed', new Date().toISOString(), new Date().toISOString(), executionId)
  publishExecution('completed')
  logRunActivity('execution.completed')

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
