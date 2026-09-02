// What happens twice?
//
// Three mechanisms repeat a step — node retries, resume-from-failure, crash
// recovery — and only the first needs nothing to go unusually wrong. Most of
// what is worth testing here is the report declining to claim more than the
// graph settles: a computed method is `unknown` rather than unsafe, a callee it
// could not read is `opaque` rather than assumed safe, and an AI call is billed
// rather than broken.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const { analyzeRepeats, methodOf } = require('../services/repeats')

const node = (id, type, config = {}, label = id) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label, config },
})

const wf = (nodes, extra = {}) => ({
  id: 'wf-1',
  name: 'Orders',
  graph: { nodes: [node('t', 'trigger-webhook'), ...nodes], edges: [] },
  ...extra,
})

const stepFor = (report, id) => report.steps.find((s) => s.nodeId === id)

describe('repeats — the verdicts', () => {
  it('reads a GET as safe to repeat', () => {
    const r = analyzeRepeats(wf([node('fetch', 'action-http', { method: 'GET', url: 'https://x/y' })]))
    expect(stepFor(r, 'fetch').verdict).toBe('safe')
  })

  it('treats an absent method as the GET the runner defaults to', () => {
    // Reporting a blank field as indeterminate would invent a hazard out of a
    // default.
    const r = analyzeRepeats(wf([node('fetch', 'action-http', { url: 'https://x/y' })]))
    expect(stepFor(r, 'fetch').verdict).toBe('safe')
  })

  it('calls a POST with no key unsafe', () => {
    const r = analyzeRepeats(wf([node('charge', 'action-http', { method: 'POST', url: 'https://x/y' })]))
    expect(stepFor(r, 'charge')).toMatchObject({ verdict: 'unsafe', method: 'POST' })
    expect(stepFor(r, 'charge').why).toMatch(/no idempotency key/)
  })

  it('calls the same POST guarded once it declares a key', () => {
    const r = analyzeRepeats(
      wf([node('charge', 'action-http', { method: 'POST', url: 'https://x/y', idempotent: true })])
    )
    expect(stepFor(r, 'charge').verdict).toBe('guarded')
  })

  it.each(['PUT', 'DELETE'])('accepts %s as idempotent by the protocol', (method) => {
    // RFC 9110: the state after N identical requests is the state after one.
    // Flagging every PUT would bury the POST that actually is a hazard.
    const r = analyzeRepeats(wf([node('n', 'action-http', { method, url: 'https://x/y' })]))
    expect(stepFor(r, 'n').verdict).toBe('safe')
    expect(stepFor(r, 'n').why).toMatch(/RFC 9110/)
  })

  it('says unknown rather than unsafe when the method is computed', () => {
    // A report that flagged every computed method is a report somebody turns
    // off, and the real POST goes with it.
    const r = analyzeRepeats(
      wf([node('n', 'action-http', { method: '{{trigger.verb}}', url: 'https://x/y' })])
    )
    expect(stepFor(r, 'n').verdict).toBe('unknown')
  })

  it('never guards an email, whatever it declares', () => {
    const r = analyzeRepeats(
      wf([node('mail', 'action-email', { to: 'a@b.c', subject: 's', idempotent: true })])
    )
    expect(stepFor(r, 'mail')).toMatchObject({ verdict: 'unsafe', declaredButUnsendable: true })
    expect(stepFor(r, 'mail').why).toMatch(/does nothing/)
  })

  it('keeps a model call apart from a correctness problem', () => {
    // Folding "costs money twice" into "does the work twice" would make every
    // AI workflow look broken.
    const r = analyzeRepeats(wf([node('score', 'ai-classify', {})]))
    expect(stepFor(r, 'score').verdict).toBe('billed')
  })

  it('reports a re-ask as a duplicate of its own kind', () => {
    const r = analyzeRepeats(wf([node('ok', 'approval', {})]))
    expect(stepFor(r, 'ok').verdict).toBe('unsafe')
    expect(stepFor(r, 'ok').why).toMatch(/may already have answered/)
  })

  it('ignores a node whose repeat changes nothing for anybody', () => {
    const r = analyzeRepeats(wf([node('shape', 'transform', {}), node('log', 'output-log', {})]))
    expect(r.steps).toHaveLength(0)
    expect(r.recovery.verdict).toBe('consistent')
  })
})

describe('repeats — what repeats on its own', () => {
  it('separates a step the engine retries from one that needs a crash', () => {
    // The first happens on an ordinary bad afternoon; the second needs a worker
    // to die. Only one of them is a reason to act today.
    const r = analyzeRepeats(
      wf([
        node('charge', 'action-http', { method: 'POST', url: 'https://x/y' }),
        node('ok', 'approval', {}),
      ])
    )
    expect(stepFor(r, 'charge').retried).toBe(true)
    expect(stepFor(r, 'ok').retried).toBe(false)
    expect(r.summary.retriedUnsafe).toBe(1)
  })

  it('does not count a guarded retry', () => {
    const r = analyzeRepeats(
      wf([node('charge', 'action-http', { method: 'POST', url: 'https://x/y', idempotent: true })])
    )
    expect(r.summary.retriedUnsafe).toBe(0)
  })

  it('orders the automatically-retried ones first within a verdict', () => {
    const r = analyzeRepeats(
      wf([
        node('ask', 'approval', {}, 'Ask'),
        node('charge', 'action-http', { method: 'POST', url: 'https://x/y' }, 'Charge'),
      ])
    )
    expect(r.steps.map((s) => s.label)).toEqual(['Charge', 'Ask'])
  })
})

describe('repeats — the recovery policy as a claim', () => {
  const unsafeGraph = () => wf([node('charge', 'action-http', { method: 'POST', url: 'https://x/y' })])
  const safeGraph = () => wf([node('fetch', 'action-http', { method: 'GET', url: 'https://x/y' })])

  it('contradicts a resume policy set on a graph that cannot support it', () => {
    // "Always continue — for a graph whose steps are idempotent, which only its
    // author can know." A dropdown set once, a graph edited fifty times since.
    const r = analyzeRepeats(unsafeGraph(), null, { recoveryPolicy: 'resume' })
    expect(r.recovery).toMatchObject({ policy: 'resume', verdict: 'contradicted' })
    expect(r.recovery.why).toMatch(/1 is not/)
  })

  it('accepts a resume policy the graph does support', () => {
    const r = analyzeRepeats(safeGraph(), null, { recoveryPolicy: 'resume' })
    expect(r.recovery.verdict).toBe('consistent')
  })

  it('will not certify a resume policy over a step it could not settle', () => {
    const r = analyzeRepeats(
      wf([node('n', 'action-http', { method: '{{v}}', url: 'https://x/y' })]),
      null,
      { recoveryPolicy: 'resume' }
    )
    expect(r.recovery.verdict).toBe('unverified')
  })

  it('names the steps that will park a crashed run under the safe policy', () => {
    const r = analyzeRepeats(unsafeGraph(), null, { recoveryPolicy: 'safe' })
    expect(r.recovery.verdict).toBe('blocks-recovery')
    expect(r.recovery.why).toMatch(/need a person/)
  })

  it('has nothing to say about a manual policy', () => {
    const r = analyzeRepeats(unsafeGraph(), null, { recoveryPolicy: 'manual' })
    expect(r.recovery.verdict).toBe('consistent')
  })
})

describe('repeats — across the sub-workflow boundary', () => {
  const callee = (nodes) => ({ id: 'wf-2', name: 'Fulfilment', graph: { nodes, edges: [] } })
  const caller = () => wf([node('call', 'sub-workflow', { workflowId: 'wf-2' }, 'Fulfil order')])

  it('inherits the worst thing the callee does', () => {
    const resolve = () => callee([node('charge', 'action-http', { method: 'POST', url: 'https://x/y' })])
    const r = analyzeRepeats(caller(), resolve)
    expect(stepFor(r, 'call')).toMatchObject({ verdict: 'unsafe' })
    expect(stepFor(r, 'call').calls).toMatchObject({ name: 'Fulfilment', steps: 1 })
  })

  it('stays safe when the callee is', () => {
    const resolve = () => callee([node('fetch', 'action-http', { method: 'GET', url: 'https://x/y' })])
    expect(stepFor(analyzeRepeats(caller(), resolve), 'call').verdict).toBe('safe')
  })

  it('says opaque rather than guessing when the callee cannot be read', () => {
    expect(stepFor(analyzeRepeats(caller(), () => null), 'call').verdict).toBe('opaque')
    expect(stepFor(analyzeRepeats(caller()), 'call').why).toMatch(/did not read it/)
  })

  it('stops at a cycle instead of walking forever', () => {
    const resolve = (id) =>
      id === 'wf-2'
        ? { id: 'wf-2', name: 'Fulfilment', graph: { nodes: [node('back', 'sub-workflow', { workflowId: 'wf-1' })], edges: [] } }
        : { id: 'wf-1', name: 'Orders', graph: caller().graph }
    const r = analyzeRepeats(caller(), resolve)
    expect(r.available).toBe(true)
    expect(stepFor(r, 'call').verdict).toBe('opaque')
  })

  it('does not claim the engine retries a sub-workflow call', () => {
    // It is a single-attempt type: a nested charge repeats on a resume or a
    // recovery, and only there.
    const resolve = () => callee([node('charge', 'action-http', { method: 'POST', url: 'https://x/y' })])
    const r = analyzeRepeats(caller(), resolve)
    expect(stepFor(r, 'call').retried).toBe(false)
    expect(r.summary.retriedUnsafe).toBe(0)
  })

  it('contradicts a resume policy over a hazard three boxes away', () => {
    const resolve = () => callee([node('charge', 'action-http', { method: 'POST', url: 'https://x/y' })])
    expect(analyzeRepeats(caller(), resolve, { recoveryPolicy: 'resume' }).recovery.verdict).toBe(
      'contradicted'
    )
  })
})

describe('repeats — what it refuses', () => {
  it('reports an empty workflow as unavailable rather than as clean', () => {
    expect(analyzeRepeats(null)).toEqual({ available: false, reason: 'empty' })
    expect(analyzeRepeats({ id: 'x' })).toEqual({ available: false, reason: 'empty' })
  })

  it('reads a templated method as indeterminate wherever it appears', () => {
    expect(methodOf(node('n', 'action-http', { method: 'post' }))).toBe('POST')
    expect(methodOf(node('n', 'action-http', { method: '{{x}}' }))).toBeNull()
    expect(methodOf(node('n', 'action-http', {}))).toBe('GET')
    expect(methodOf(node('n', 'action-http', { method: '' }))).toBe('GET')
  })
})

// The engine's retry shape is restated here rather than imported, because
// pulling the run loop into a static analysis is a cost nothing else pays. The
// drift risk that creates is paid here and nowhere else.
describe('repeats — agreeing with the engine it describes', () => {
  const repeats = require('../services/repeats')
  const engine = require('../services/executionEngine')

  it('retries the same number of times the engine does', () => {
    expect(repeats.MAX_ATTEMPTS).toBe(engine.MAX_ATTEMPTS)
  })

  it('holds the same node types to be single-attempt', () => {
    expect([...repeats.SINGLE_ATTEMPT_TYPES].sort()).toEqual(
      [...engine.SINGLE_ATTEMPT_TYPES].sort()
    )
  })

  it('only calls a node guarded where a key is actually sent', () => {
    // The other half of the same coupling: `guarded` is a claim that the far
    // side will see an Idempotency-Key, which is true exactly for the types
    // stepIdempotency will issue one for.
    const { KEYED_TYPES } = require('../services/stepIdempotency')
    expect([...repeats.KEYED_TYPES]).toEqual([...KEYED_TYPES])
  })
})
