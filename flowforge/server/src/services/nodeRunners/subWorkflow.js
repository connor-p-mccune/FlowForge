// Sub-workflow node: runs another workflow as a single step. The parent node's
// merged input becomes the sub-workflow's trigger payload; the sub-workflow runs
// synchronously through the same execution engine (NOT the Bull queue), and its
// final output becomes this node's output (available downstream as
// {{thisNodeId.field}}). This makes a workflow a reusable building block — define
// "send alert" once and call it from many workflows.
//
// Circular references are blocked via ctx.ancestorWorkflowIds: the chain of
// workflow ids already on the call stack (the engine appends each running workflow
// before invoking its nodes — see executionEngine.runExecution). A target already
// on the stack — including the workflow currently running, i.e. a direct self-call
// — would recurse forever, so it is rejected up front.
const { v4: uuidv4 } = require('uuid')
const db = require('../../config/database')

module.exports = async function runSubWorkflow(config, input, isDryRun, ctx = {}) {
  const workflowId = config?.workflowId
  if (!workflowId) throw new Error('Sub-workflow node requires a target workflow')

  const {
    ancestorWorkflowIds = [],
    parentExecutionId = null,
    parentNodeId = null,
    publish,
  } = ctx

  // Cycle guard — check before doing any work so a bad reference fails fast and
  // never creates a child execution row.
  if (ancestorWorkflowIds.includes(workflowId)) {
    throw new Error('Circular workflow reference detected')
  }

  const target = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId)
  if (!target) throw new Error('Sub-workflow not found')

  // Keep a sub-workflow call inside the parent's workspace. parentExecutionId is the
  // execution running this node; its workflow defines the workspace boundary. This
  // also keeps the whole call tree returned by GET /api/executions/:id within one
  // workspace, which that route's single membership check relies on. (Skipped only
  // when invoked without a parent execution, e.g. a direct unit test.)
  if (parentExecutionId) {
    const parentExec = db
      .prepare('SELECT workflow_id FROM executions WHERE id = ?')
      .get(parentExecutionId)
    const parentWf =
      parentExec &&
      db.prepare('SELECT workspace_id FROM workflows WHERE id = ?').get(parentExec.workflow_id)
    if (parentWf && parentWf.workspace_id !== target.workspace_id) {
      throw new Error('Sub-workflow not found')
    }
  }

  if (target.status !== 'deployed') {
    throw new Error('Sub-workflow is not deployed')
  }

  // A fresh execution for the child run, tagged with the parent execution + the
  // node that invoked it so GET /api/executions/:id can nest the child's steps
  // under the right step. trigger_data mirrors the trigger payload we hand in, so
  // the child run is reproducible/replayable like any other execution.
  const childExecutionId = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO executions
       (id, workflow_id, status, trigger_type, trigger_data, parent_execution_id, parent_node_id, created_at)
     VALUES (?, ?, 'pending', 'sub-workflow', ?, ?, ?, ?)`
  ).run(childExecutionId, workflowId, JSON.stringify(input ?? {}), parentExecutionId, parentNodeId, now)

  // Run synchronously through the engine. Lazy require breaks the engine↔runner
  // module cycle (the engine requires this file at load time). The engine appends
  // `workflowId` to ancestorWorkflowIds itself, so we forward the chain unchanged.
  // A dry run propagates down so a parent test run can't fire real side effects in
  // the sub-workflow; publish rides along so child events route to their own room.
  const { runExecution } = require('../executionEngine')
  const finalOutput = await runExecution(childExecutionId, {
    payload: input,
    dryRun: isDryRun,
    publish,
    ancestorWorkflowIds,
  })

  const child = db.prepare('SELECT status FROM executions WHERE id = ?').get(childExecutionId)
  if (!child || child.status !== 'completed') {
    throw new Error('Sub-workflow execution failed')
  }

  return finalOutput ?? {}
}
