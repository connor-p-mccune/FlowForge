const Queue = require('bull')
const Redis = require('ioredis')

let executionQueue = null

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

// ioredis options shared by every Bull connection. `family: 0` lets DNS resolve
// IPv6 (AAAA) records so Railway's IPv6-only *.railway.internal Redis host is
// reachable. Bull's blocking clients additionally require maxRetriesPerRequest
// null and enableReadyCheck false.
const redisOptions = {
  family: 0,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
}

// Lazy so simply requiring route files never opens a Redis connection
// (important for tests that run with no Redis available).
function getExecutionQueue() {
  if (!executionQueue) {
    // Bull's documented pattern for custom ioredis connections: reuse one shared
    // client + subscriber, but hand out a fresh blocking client (bclient) each
    // time it asks. Passing connections this way (instead of a URL string) is
    // what lets us inject `family: 0`.
    let client
    let subscriber
    executionQueue = new Queue('workflow-execution', {
      createClient(type) {
        switch (type) {
          case 'client':
            if (!client) client = new Redis(REDIS_URL, redisOptions)
            return client
          case 'subscriber':
            if (!subscriber) subscriber = new Redis(REDIS_URL, redisOptions)
            return subscriber
          default:
            return new Redis(REDIS_URL, redisOptions)
        }
      },
    })
    executionQueue.on('error', (err) => {
      console.error('Execution queue error:', err.message)
    })
  }
  return executionQueue
}

module.exports = { getExecutionQueue }
