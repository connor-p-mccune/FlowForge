// Per-host retry budget: a bound on how much of a struggling host's load is
// FlowForge retrying it.
//
// The distinguishing property from the circuit breaker next door is that this
// one engages while the host is still *succeeding most of the time* — which is
// exactly when the breaker cannot, because it never sees N consecutive
// failures. Several tests below are about that boundary.

process.env.NODE_ENV = 'test'
process.env.ENABLE_RETRY_BUDGET = 'true'

const retryBudget = require('../services/retryBudget')

const HOST = 'https://api.acme.com/v1/orders'
const OTHER = 'https://api.other.com/v1/orders'

const send = (url, n) => {
  for (let i = 0; i < n; i++) retryBudget.recordRequest(url)
}
const retry = (url, n) => {
  for (let i = 0; i < n; i++) retryBudget.recordRetry(url)
}

beforeEach(() => {
  retryBudget.reset()
  process.env.ENABLE_RETRY_BUDGET = 'true'
  delete process.env.DISABLE_RETRY_BUDGET
  delete process.env.RETRY_BUDGET_RATIO
  delete process.env.RETRY_BUDGET_MIN
  delete process.env.RETRY_BUDGET_WINDOW_MS
})

afterAll(() => {
  delete process.env.ENABLE_RETRY_BUDGET
})

describe('the budget', () => {
  it('allows retries while they are a small fraction of the traffic', () => {
    send(HOST, 1000)
    retry(HOST, 50) // 5%
    expect(retryBudget.allowRetry(HOST).allowed).toBe(true)
  })

  it('refuses once retries pass the ratio', () => {
    send(HOST, 1000)
    retry(HOST, 100) // exactly 10%
    const state = retryBudget.allowRetry(HOST)
    expect(state.allowed).toBe(false)
    expect(state.budget).toBe(100)
    expect(state.retries).toBe(100)
  })

  it('is a ratio, not a count — the same ten retries pass or fail on volume', () => {
    send(HOST, 1000)
    retry(HOST, 40)
    expect(retryBudget.allowRetry(HOST).allowed).toBe(true)

    retryBudget.reset()
    send(HOST, 100)
    retry(HOST, 40)
    expect(retryBudget.allowRetry(HOST).allowed).toBe(false)
  })

  it('honours a configured ratio', () => {
    process.env.RETRY_BUDGET_RATIO = '0.5'
    send(HOST, 100)
    retry(HOST, 40)
    expect(retryBudget.allowRetry(HOST).allowed).toBe(true) // budget 50
    retry(HOST, 15)
    expect(retryBudget.allowRetry(HOST).allowed).toBe(false)
  })

  it('keeps a low-traffic host able to retry at all', () => {
    // 10% of three requests is 0.3 retries — i.e. none, forever. A workflow
    // that fires once an hour would never retry anything, which is not a bound
    // on cascading failure, it is a broken retry policy.
    send(HOST, 3)
    retry(HOST, 2)
    expect(retryBudget.allowRetry(HOST).allowed).toBe(true)
    expect(retryBudget.allowRetry(HOST).budget).toBe(10)
  })

  it('lets the floor be tuned down to nothing', () => {
    process.env.RETRY_BUDGET_MIN = '0'
    send(HOST, 3)
    retry(HOST, 1)
    expect(retryBudget.allowRetry(HOST).allowed).toBe(false)
  })
})

describe('scope', () => {
  it('budgets each host separately', () => {
    send(HOST, 100)
    retry(HOST, 40)
    send(OTHER, 100)
    expect(retryBudget.allowRetry(HOST).allowed).toBe(false)
    expect(retryBudget.allowRetry(OTHER).allowed).toBe(true)
  })

  it('treats different paths on one host as one budget', () => {
    // The host experiences one total load; a budget per URL would be no bound.
    send('https://api.acme.com/a', 60)
    send('https://api.acme.com/b', 40)
    retry('https://api.acme.com/a', 40)
    expect(retryBudget.allowRetry('https://api.acme.com/c').allowed).toBe(false)
  })

  it('separates ports, which are separate services', () => {
    send('http://localhost:3000/x', 100)
    retry('http://localhost:3000/x', 40)
    expect(retryBudget.allowRetry('http://localhost:4000/x').allowed).toBe(true)
  })

  it('allows anything it cannot attribute to a host', () => {
    expect(retryBudget.allowRetry('not a url').allowed).toBe(true)
    expect(retryBudget.allowRetry(undefined).allowed).toBe(true)
    // And recording against one is inert rather than throwing.
    expect(() => retryBudget.recordRequest('not a url')).not.toThrow()
  })
})

describe('the window', () => {
  it('forgets a burst once the window has rolled past it', () => {
    process.env.RETRY_BUDGET_WINDOW_MS = '6000'
    const start = Date.now()
    const spy = jest.spyOn(Date, 'now')

    spy.mockReturnValue(start)
    send(HOST, 100)
    retry(HOST, 40)
    expect(retryBudget.allowRetry(HOST).allowed).toBe(false)

    // A full window later, none of it counts.
    spy.mockReturnValue(start + 7000)
    expect(retryBudget.allowRetry(HOST).allowed).toBe(true)
    expect(retryBudget.allowRetry(HOST).retries).toBe(0)
    spy.mockRestore()
  })

  it('expires gradually rather than all at once', () => {
    process.env.RETRY_BUDGET_WINDOW_MS = '6000' // six 1s buckets
    const start = Date.now()
    const spy = jest.spyOn(Date, 'now')

    spy.mockReturnValue(start)
    send(HOST, 60)
    spy.mockReturnValue(start + 3000)
    send(HOST, 60)
    // Half a window on: the first burst is still inside it.
    expect(retryBudget.allowRetry(HOST).requests).toBe(120)

    // Far enough that only the second burst survives.
    spy.mockReturnValue(start + 8000)
    expect(retryBudget.allowRetry(HOST).requests).toBe(60)
    spy.mockRestore()
  })
})

describe('the switch', () => {
  it('is inert when disabled, so a caller can consult it unconditionally', () => {
    process.env.DISABLE_RETRY_BUDGET = 'true'
    send(HOST, 100)
    retry(HOST, 400)
    expect(retryBudget.allowRetry(HOST).allowed).toBe(true)
    expect(retryBudget.enabled()).toBe(false)
  })

  it('is off under NODE_ENV=test unless a suite opts in', () => {
    // Suites deliberately hammer failing local servers; a budget engaging there
    // would make every retry test depend on the order it ran in.
    delete process.env.ENABLE_RETRY_BUDGET
    expect(retryBudget.enabled()).toBe(false)
    process.env.ENABLE_RETRY_BUDGET = 'true'
    expect(retryBudget.enabled()).toBe(true)
  })
})

describe('egressUrlOf', () => {
  const node = (type, config) => ({ type, data: { config } })

  it('finds the URL of the node types whose purpose is to call one', () => {
    expect(retryBudget.egressUrlOf(node('action-http'), { url: HOST })).toBe(HOST)
    expect(retryBudget.egressUrlOf(node('action-slack'), { webhookUrl: HOST })).toBe(HOST)
  })

  it('is null for work that cannot cascade', () => {
    // A Transform node's retry costs nobody anything but a millisecond of CPU;
    // putting a cascading-failure control in front of it would be theatre.
    expect(retryBudget.egressUrlOf(node('transform'), { template: '{}' })).toBeNull()
    expect(retryBudget.egressUrlOf(node('action-delay'), { durationMs: 10 })).toBeNull()
    expect(retryBudget.egressUrlOf(node('sub-workflow'), {})).toBeNull()
    expect(retryBudget.egressUrlOf(undefined, {})).toBeNull()
  })

  it('is null for a node whose URL has not been configured', () => {
    expect(retryBudget.egressUrlOf(node('action-http'), {})).toBeNull()
  })
})

describe('suppressionNote', () => {
  it('names the host and both sides of the ratio', () => {
    send(HOST, 100)
    retry(HOST, 40)
    const note = retryBudget.suppressionNote(retryBudget.allowRetry(HOST))
    expect(note).toMatch(/api\.acme\.com/)
    expect(note).toMatch(/40 retries against 100 requests/)
    expect(note).toMatch(/budget 10/)
  })
})
