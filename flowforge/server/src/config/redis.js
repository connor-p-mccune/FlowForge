const Redis = require('ioredis')

const client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  lazyConnect: true,
  maxRetriesPerRequest: null,
  // Railway's private network is IPv6-only; family 0 lets DNS resolve both A
  // and AAAA records so *.railway.internal hostnames work (harmless elsewhere).
  family: 0,
})

client.on('error', (err) => {
  if (process.env.NODE_ENV !== 'test') {
    console.error('Redis error:', err.message)
  }
})

module.exports = client
