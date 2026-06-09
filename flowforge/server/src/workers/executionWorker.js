// Phase 3: Bull worker for workflow execution
// This file is required by index.js to start the worker process alongside the server.
// The actual execution logic lives in services/executionEngine.js (Phase 3).

if (process.env.NODE_ENV === 'test') {
  module.exports = {}
  return
}

const Queue = require('bull')

const executionQueue = new Queue('workflow-execution', {
  redis: {
    host: process.env.REDIS_HOST || 'redis',
    port: parseInt(process.env.REDIS_PORT || '6379'),
  },
})

executionQueue.process(async (job) => {
  console.log('Execution worker: job received', job.data, '— not yet implemented (Phase 3)')
})

executionQueue.on('error', (err) => {
  console.error('Execution queue error:', err.message)
})

module.exports = { executionQueue }
