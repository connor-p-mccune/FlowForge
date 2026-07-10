// Poll a run to completion, printing each step transition once. This is what
// makes `flowforge trigger --watch` a CI primitive: the process exits 0 only
// when the run completed, so a failed workflow fails the pipeline.

const { statusColored, formatDuration, gray } = require('./format')

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function stepLine(step) {
  const duration = formatDuration(step.started_at, step.finished_at)
  const label = step.node_type ? `${step.node_id} ${gray(`(${step.node_type})`)}` : step.node_id
  return `  ${statusColored(step.status.padEnd(9))} ${label}${duration ? ` ${gray(duration)}` : ''}`
}

async function watchExecution(api, executionId, { log, intervalMs = 2000 } = {}) {
  const printed = new Map() // step id -> last printed status
  for (;;) {
    const { execution, steps } = await api.get(`/api/v1/executions/${executionId}`)
    for (const step of steps || []) {
      // Print each status change exactly once; 'pending' is noise.
      if (step.status !== 'pending' && printed.get(step.id) !== step.status) {
        printed.set(step.id, step.status)
        log(stepLine(step))
      }
    }
    if (TERMINAL.has(execution.status)) {
      const duration = formatDuration(execution.startedAt, execution.finishedAt)
      log(`Run ${statusColored(execution.status)}${duration ? ` in ${duration}` : ''}`)
      return execution.status === 'completed' ? 0 : 1
    }
    await sleep(intervalMs)
  }
}

module.exports = { watchExecution }
