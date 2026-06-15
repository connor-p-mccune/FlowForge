// Execution engine: parses the workflow graph into a DAG, runs each node in
// topological order, resolves {{node-id.field}} templates from the execution
// context, retries failures with exponential backoff, records every step in
// execution_steps, and publishes exec-update events (Redis pub/sub by default).

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const { buildAdjacency, topoSort } = require('./dagParser')

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

function defaultPublish(payload) {
  // Lazy require so engine unit tests never touch Redis
  const redis = require('../config/redis')
  redis
    .publish('exec-update', JSON.stringify(payload))
    .catch((err) => console.error('Failed to publish exec-update:', err.message))
}

async function runWithRetries(node, config, input) {
  const runner = getRunner(node.type)
  for (let attempt = 1; ; attempt++) {
    try {
      return await runner(config, input)
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw err
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1))
    }
  }
}

async function runExecution(executionId, { publish, payload } = {}) {
  const pub = publish || defaultPublish
  // Trigger nodes emit this object as their output, so webhook bodies flow into
  // the graph (e.g. {{triggerNodeId.field}}). Manual runs pass nothing.
  const triggerPayload = payload && typeof payload === 'object' ? payload : {}

  const execution = db.prepare('SELECT * FROM executions WHERE id = ?').get(executionId)
  if (!execution) throw new Error(`Execution ${executionId} not found`)
  const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(execution.workflow_id)
  if (!workflow) throw new Error(`Workflow ${execution.workflow_id} not found`)

  const workflowId = workflow.id
  const { nodes = [], edges = [] } = JSON.parse(workflow.graph_json)
  const nodeById = Object.fromEntries(nodes.map((n) => [n.id, n]))

  const updateExecution = db.prepare(
    'UPDATE executions SET status = ?, started_at = COALESCE(started_at, ?), finished_at = ? WHERE id = ?'
  )

  function publishExecution(status, error) {
    pub({ kind: 'execution', workflowId, executionId, status, error: error || null })
  }

  function failExecution(message) {
    updateExecution.run('failed', new Date().toISOString(), new Date().toISOString(), executionId)
    publishExecution('failed', message)
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
      output: extra.output ?? null,
      error: extra.error ?? null,
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

    updateStep.run('running', JSON.stringify(input), null, null, now(), null, stepIdByNode[nodeId])
    publishStep(nodeId, 'running')

    try {
      const config = resolveTemplates(node.data?.config || {}, context)
      const output = (await runWithRetries(node, config, input)) ?? {}
      context[nodeId] = output
      nodeStatus[nodeId] = 'success'
      updateStep.run(
        'succeeded', JSON.stringify(input), JSON.stringify(output), null,
        now(), now(), stepIdByNode[nodeId]
      )
      publishStep(nodeId, 'succeeded', { output })
    } catch (err) {
      nodeStatus[nodeId] = 'failed'
      updateStep.run(
        'failed', JSON.stringify(input), null, err.message,
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
}

module.exports = { runExecution, resolveTemplates }
