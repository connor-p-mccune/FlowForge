// The outbound circuit breaker: per-host consecutive-failure tracking, the
// open → half-open → closed lifecycle, and its wrapping of safeFetch (the
// shared egress path for HTTP nodes, Slack nodes, and webhook deliveries).

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const http = require('http')
const { withCircuit, resetCircuits, enabled } = require('../services/circuitBreaker')
const { safeFetch } = require('../services/ssrfGuard')

const fail = () => Promise.reject(new Error('boom'))
const ok = () => Promise.resolve({ status: 200 })

beforeEach(() => {
  process.env.ENABLE_CIRCUIT_BREAKER = 'true'
  process.env.CIRCUIT_BREAKER_THRESHOLD = '3'
  process.env.CIRCUIT_BREAKER_COOLDOWN_MS = '120'
  resetCircuits()
})

afterAll(() => {
  delete process.env.ENABLE_CIRCUIT_BREAKER
  delete process.env.CIRCUIT_BREAKER_THRESHOLD
  delete process.env.CIRCUIT_BREAKER_COOLDOWN_MS
})

const URL_A = 'https://a.example.com/x'
const URL_B = 'https://b.example.com/x'

describe('withCircuit', () => {
  it('is off by default under NODE_ENV=test', async () => {
    delete process.env.ENABLE_CIRCUIT_BREAKER
    expect(enabled()).toBe(false)
    for (let i = 0; i < 10; i++) {
      await expect(withCircuit(URL_A, fail)).rejects.toThrow('boom')
    }
    // Still the real error — nothing tripped.
    await expect(withCircuit(URL_A, fail)).rejects.toThrow('boom')
  })

  it('opens after the consecutive-failure threshold and fast-fails', async () => {
    for (let i = 0; i < 3; i++) {
      await expect(withCircuit(URL_A, fail)).rejects.toThrow('boom')
    }
    // Open: the wrapped fn is not even invoked.
    const spy = jest.fn(fail)
    await expect(withCircuit(URL_A, spy)).rejects.toThrow(/Circuit breaker: "a.example.com"/)
    expect(spy).not.toHaveBeenCalled()
  })

  it('a success resets the consecutive count', async () => {
    await expect(withCircuit(URL_A, fail)).rejects.toThrow('boom')
    await expect(withCircuit(URL_A, fail)).rejects.toThrow('boom')
    await withCircuit(URL_A, ok)
    // Two more failures are under the threshold again.
    await expect(withCircuit(URL_A, fail)).rejects.toThrow('boom')
    await expect(withCircuit(URL_A, fail)).rejects.toThrow('boom')
    const spy = jest.fn(ok)
    await withCircuit(URL_A, spy)
    expect(spy).toHaveBeenCalled()
  })

  it('5xx responses count as failures, 4xx do not', async () => {
    const server500 = () => Promise.resolve({ status: 503 })
    const server404 = () => Promise.resolve({ status: 404 })
    for (let i = 0; i < 3; i++) {
      // The caller still receives the real response.
      const res = await withCircuit(URL_A, server500)
      expect(res.status).toBe(503)
    }
    await expect(withCircuit(URL_A, ok)).rejects.toThrow(/Circuit breaker/)

    for (let i = 0; i < 10; i++) {
      const res = await withCircuit(URL_B, server404)
      expect(res.status).toBe(404)
    }
    const spy = jest.fn(ok)
    await withCircuit(URL_B, spy)
    expect(spy).toHaveBeenCalled()
  })

  it('circuits are per host — one dead API cannot fast-fail a healthy one', async () => {
    for (let i = 0; i < 3; i++) {
      await expect(withCircuit(URL_A, fail)).rejects.toThrow('boom')
    }
    await expect(withCircuit(URL_A, ok)).rejects.toThrow(/Circuit breaker/)
    await expect(withCircuit(URL_B, ok)).resolves.toEqual({ status: 200 })
  })

  it('after the cooldown one probe runs; success closes the circuit', async () => {
    for (let i = 0; i < 3; i++) {
      await expect(withCircuit(URL_A, fail)).rejects.toThrow('boom')
    }
    await expect(withCircuit(URL_A, ok)).rejects.toThrow(/Circuit breaker/)

    await new Promise((r) => setTimeout(r, 130))
    const probe = jest.fn(ok)
    await withCircuit(URL_A, probe) // half-open probe goes through
    expect(probe).toHaveBeenCalled()
    // Closed again: calls flow normally.
    await expect(withCircuit(URL_A, ok)).resolves.toEqual({ status: 200 })
  })

  it('a failed probe re-opens the circuit for a fresh cooldown', async () => {
    for (let i = 0; i < 3; i++) {
      await expect(withCircuit(URL_A, fail)).rejects.toThrow('boom')
    }
    await new Promise((r) => setTimeout(r, 130))
    await expect(withCircuit(URL_A, fail)).rejects.toThrow('boom') // the probe itself
    // Straight back to fast-failing.
    const spy = jest.fn(ok)
    await expect(withCircuit(URL_A, spy)).rejects.toThrow(/Circuit breaker/)
    expect(spy).not.toHaveBeenCalled()
  })

  it('while a probe is in flight, concurrent callers fast-fail', async () => {
    for (let i = 0; i < 3; i++) {
      await expect(withCircuit(URL_A, fail)).rejects.toThrow('boom')
    }
    await new Promise((r) => setTimeout(r, 130))

    let release
    const gate = new Promise((r) => (release = r))
    const probe = withCircuit(URL_A, async () => {
      await gate
      return { status: 200 }
    })
    await expect(withCircuit(URL_A, ok)).rejects.toThrow(/probe is already in flight/)
    release()
    await probe
    await expect(withCircuit(URL_A, ok)).resolves.toEqual({ status: 200 })
  })
})

describe('safeFetch under the breaker', () => {
  it('trips on repeated connection failures and fast-fails the next call', async () => {
    // Port 1 refuses immediately; three attempts cross the threshold.
    for (let i = 0; i < 3; i++) {
      await expect(safeFetch('http://127.0.0.1:1/')).rejects.toThrow()
    }
    await expect(safeFetch('http://127.0.0.1:1/')).rejects.toThrow(
      /Circuit breaker: "127.0.0.1:1"/
    )
  })

  it('keeps serving a healthy host normally', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    try {
      for (let i = 0; i < 5; i++) {
        const res = await safeFetch(`http://127.0.0.1:${port}/`)
        expect(res.status).toBe(200)
      }
    } finally {
      server.close()
    }
  })
})
