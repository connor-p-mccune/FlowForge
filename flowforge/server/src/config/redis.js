const Redis = require('ioredis')

const client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  lazyConnect: true,
  maxRetriesPerRequest: null,
})

client.on('error', (err) => {
  if (process.env.NODE_ENV !== 'test') {
    console.error('Redis error:', err.message)
  }
})

module.exports = client
