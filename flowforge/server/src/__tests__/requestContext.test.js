// Request correlation: ids honored/generated/echoed, the per-response log
// line, and the error handler carrying the id into 500 bodies.

const request = require('supertest')
const express = require('express')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))

const { app } = require('../index')
const logger = require('../services/logger')
const requestContext = require('../middleware/requestContext')
const errorHandler = require('../middleware/errorHandler')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('request ids on the real app', () => {
  it('generates an id and echoes it on every response', async () => {
    const res = await request(app).get('/api/health')
    expect(res.headers['x-request-id']).toMatch(UUID_RE)
  })

  it('honors a valid inbound X-Request-Id', async () => {
    const res = await request(app).get('/api/health').set('X-Request-Id', 'gw-abc.123')
    expect(res.headers['x-request-id']).toBe('gw-abc.123')
  })

  it('replaces an invalid inbound id instead of reflecting it', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('X-Request-Id', 'bad id\twith "junk"')
    expect(res.headers['x-request-id']).toMatch(UUID_RE)
  })

  it('carries the id through error responses (JSON 404 and parse failures)', async () => {
    const missing = await request(app).get('/api/nope').set('X-Request-Id', 'corr-404')
    expect(missing.status).toBe(404)
    expect(missing.headers['x-request-id']).toBe('corr-404')

    const badJson = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .set('X-Request-Id', 'corr-400')
      .send('{not json')
    expect(badJson.status).toBe(400)
    expect(badJson.headers['x-request-id']).toBe('corr-400')
  })
})

describe('request logging and the error handler', () => {
  let lines
  let restoreSink

  beforeEach(() => {
    lines = []
    restoreSink = logger._setSink((line) => lines.push(JSON.parse(line)))
    process.env.LOG_LEVEL = 'debug'
  })

  afterEach(() => {
    logger._setSink(restoreSink)
    delete process.env.LOG_LEVEL
  })

  // A minimal app wired exactly like index.js, plus a route that throws.
  function miniApp() {
    const mini = express()
    mini.use(requestContext)
    mini.get('/ok', (req, res) => res.json({ ok: true }))
    mini.get('/boom', () => {
      throw new Error('kaput')
    })
    mini.use(errorHandler)
    return mini
  }

  it('logs one structured line per response with the request id', async () => {
    await request(miniApp()).get('/ok').set('X-Request-Id', 'corr-log')
    const line = lines.find((l) => l.msg === 'request')
    expect(line).toMatchObject({
      level: 'info',
      requestId: 'corr-log',
      method: 'GET',
      path: '/ok',
      status: 200,
    })
    expect(line.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('returns the request id in 500 bodies and logs the failure with it', async () => {
    const res = await request(miniApp()).get('/boom').set('X-Request-Id', 'corr-500')
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'Internal server error', requestId: 'corr-500' })

    const line = lines.find((l) => l.msg === 'unhandled error')
    expect(line).toMatchObject({
      level: 'error',
      requestId: 'corr-500',
      path: '/boom',
      error: 'kaput',
    })
    expect(line.stack).toContain('kaput')
  })

  it('demotes health/metrics probes to debug', async () => {
    const mini = express()
    mini.use(requestContext)
    mini.get('/api/health', (req, res) => res.json({ status: 'ok' }))
    mini.use(errorHandler)

    process.env.LOG_LEVEL = 'info'
    await request(mini).get('/api/health')
    expect(lines.find((l) => l.msg === 'request')).toBeUndefined()

    process.env.LOG_LEVEL = 'debug'
    await request(mini).get('/api/health')
    expect(lines.find((l) => l.msg === 'request')).toMatchObject({ level: 'debug' })
  })
})
