const Queue = require('bull')

let executionQueue = null

// Lazy so simply requiring route files never opens a Redis connection
// (important for tests that run with no Redis available).
function getExecutionQueue() {
  if (!executionQueue) {
    executionQueue = new Queue(
      'workflow-execution',
      process.env.REDIS_URL || 'redis://localhost:6379'
    )
    executionQueue.on('error', (err) => {
      console.error('Execution queue error:', err.message)
    })
  }
  return executionQueue
}

module.exports = { getExecutionQueue }
