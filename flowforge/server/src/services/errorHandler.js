// Error-handler workflows: when a real, top-level run fails, trigger the
// workflow its owner designated (workflows.error_workflow_id) with the
// failure context as the trigger payload — so "on failure, file a ticket /
// page someone / roll back" is itself just a workflow, built on the same
// canvas with the same nodes, instead of a bespoke alerting config.
//
// This composes with (rather than replaces) per-node error handling: a node's
// on-error branch is the *recovery* path inside a run, while the handler
// workflow is the *escalation* path for runs that still died. It fires from
// the execution worker beside the SLA monitor — the same "top-level, settled,
// real run" hook — and is best-effort throughout: a broken handler must never
// affect the failed run's own record.
//
// The loop guard is one line: a handler run is recorded with trigger_type
// 'error-handler', and failures of such runs never fire a handler. That caps
// any chain at depth one — even a workflow configured as its own handler
// fails once, handles once, and stops.

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const { getExecutionQueue } = require('../config/queue')
const { admitRun } = require('./concurrencyGate')
const { resolvePriority, enqueueOpts } = require('./runPriority')

// The failure context handed to the handler as its trigger payload. The run's
// error lives on its failed step (the engine persists no run-level error
// column), already secret-redacted at persistence time.
function buildPayload(execution, workflow) {
  const failedStep = db
    .prepare(
      "SELECT node_id, node_type, error FROM execution_steps WHERE execution_id = ? AND status = 'failed' ORDER BY rowid LIMIT 1"
    )
    .get(execution.id)
  return {
    event: 'execution.failed',
    workflowId: workflow.id,
    workflowName: workflow.name,
    executionId: execution.id,
    triggerType: execution.trigger_type ?? null,
    failedAt: execution.finished_at ?? new Date().toISOString(),
    error: failedStep
      ? { nodeId: failedStep.node_id, nodeType: failedStep.node_type, message: failedStep.error }
      : { nodeId: null, nodeType: null, message: 'Run failed before any node executed' },
  }
}

// Fire the failed run's error handler, if one is configured and eligible.
// Never throws; returns the handler execution id when one was enqueued (for
// tests and logs), else null.
async function triggerErrorHandler(executionId) {
  try {
    const execution = db.prepare('SELECT * FROM executions WHERE id = ?').get(executionId)
    if (!execution || execution.status !== 'failed') return null
    // Dry runs are interactive experiments; handler runs must not cascade.
    if (execution.trigger_type === 'dry-run' || execution.trigger_type === 'error-handler') {
      return null
    }

    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(execution.workflow_id)
    if (!workflow || !workflow.error_workflow_id) return null

    const handler = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflow.error_workflow_id)
    // Same eligibility rules as a sub-workflow target: it must still exist in
    // the same workspace and be deployed. Anything else is skipped with a log
    // line, not an error — the failed run's record is already complete.
    if (!handler || handler.workspace_id !== workflow.workspace_id) return null
    if (handler.status !== 'deployed') {
      console.error(
        `Error handler for "${workflow.name}" skipped: target workflow is not deployed`
      )
      return null
    }
    const { nodes } = JSON.parse(handler.graph_json)
    if (!nodes || nodes.length === 0) return null

    // Respect the handler's own concurrency policy: a reject-at-cap handler
    // skips this firing exactly like a schedule tick does.
    const admission = admitRun(handler)
    if (!admission.ok) {
      console.error(`Error handler for "${workflow.name}" skipped: ${admission.error}`)
      return null
    }

    const payload = buildPayload(execution, workflow)
    // The handler's own default lane applies — escalation urgency is the
    // handler author's call, not something this trigger path decides.
    const priority = resolvePriority(null, handler)
    const handlerExecutionId = uuidv4()
    db.prepare(
      `INSERT INTO executions (id, workflow_id, status, triggered_by, trigger_type, trigger_data, priority, created_at)
       VALUES (?, ?, 'pending', ?, 'error-handler', ?, ?, ?)`
    ).run(
      handlerExecutionId, handler.id, execution.triggered_by ?? null,
      JSON.stringify(payload), priority, new Date().toISOString()
    )
    await getExecutionQueue().add({
      executionId: handlerExecutionId,
      workflowId: handler.id,
      payload,
    }, enqueueOpts(priority))
    return handlerExecutionId
  } catch (err) {
    console.error('Error-handler trigger failed:', err.message)
    return null
  }
}

module.exports = { triggerErrorHandler }
