// The graceful-shutdown coordinator: closers drain sequentially in
// registration order, failures don't abort the rest, a hard deadline
// backstops hangs, and the readiness probe flips to draining.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))
// The readiness probe pings Redis — keep that off the network (a real ioredis
// client would retry-connect forever and hold the test process open).
jest.mock('../config/redis', () => ({
  ping: jest.fn().mockResolvedValue('PONG'),
  publish: jest.fn().mockResolvedValue(1),
}))

const shutdown = require('../services/shutdown')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

afterEach(() => {
  shutdown._reset()
})

describe('shutdown coordinator', () => {
  it('runs closers sequentially in registration order and exits 0', async () => {
    const order = []
    shutdown.onShutdown('a', async () => {
      await sleep(20)
      order.push('a')
    })
    shutdown.onShutdown('b', () => order.push('b'))
    shutdown.onShutdown('c', async () => {
      order.push('c')
    })

    const exit = jest.fn()
    await shutdown.shutdown('SIGTERM', { exit })
    // 'b' ran only after the slow 'a' settled — the drain is sequential.
    expect(order).toEqual(['a', 'b', 'c'])
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('a failing closer is skipped, the rest still close, and the exit is dirty', async () => {
    const order = []
    shutdown.onShutdown('bad', () => {
      throw new Error('refuses to close')
    })
    shutdown.onShutdown('good', () => order.push('good'))

    const exit = jest.fn()
    await shutdown.shutdown('SIGTERM', { exit })
    expect(order).toEqual(['good'])
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('force-exits when a closer outlives the deadline', async () => {
    shutdown.onShutdown('hung', () => new Promise(() => {})) // never settles

    const exited = new Promise((resolve) => {
      shutdown.shutdown('SIGTERM', { exit: resolve, timeoutMs: 50 })
    })
    await expect(exited).resolves.toBe(1)
  })

  it('a second signal during the drain exits immediately', async () => {
    let release
    shutdown.onShutdown('slow', () => new Promise((r) => (release = r)))

    const firstExit = jest.fn()
    const drain = shutdown.shutdown('SIGTERM', { exit: firstExit })
    await sleep(10) // let the drain reach the slow closer

    const secondExit = jest.fn()
    await shutdown.shutdown('SIGINT', { exit: secondExit })
    expect(secondExit).toHaveBeenCalledWith(1)

    release()
    await drain
    expect(firstExit).toHaveBeenCalledWith(0)
  })

  it('flips the readiness probe to 503 draining', async () => {
    const { app } = require('../index')

    const before = await request(app).get('/api/health/ready')
    expect(before.status).toBe(200)
    expect(before.body.status).toBe('ready')

    await shutdown.shutdown('SIGTERM', { exit: () => {} })
    expect(shutdown.isShuttingDown()).toBe(true)

    const during = await request(app).get('/api/health/ready')
    expect(during.status).toBe(503)
    expect(during.body).toEqual({ status: 'draining' })

    // Liveness stays green so the orchestrator doesn't kill the drain early.
    const live = await request(app).get('/api/health')
    expect(live.status).toBe(200)
  })
})
