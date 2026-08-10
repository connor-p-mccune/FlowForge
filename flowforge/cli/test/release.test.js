const test = require('node:test')
const assert = require('node:assert/strict')

const { startStub, makeCtx } = require('./helpers')
const release = require('../src/commands/release')

const arm = (runs, failures) => ({
  runs,
  failures,
  failureRate: runs ? failures / runs : null,
  failureRateInterval: { point: 0, lower: 0, upper: 0.09 },
  durations: [],
})

const REPORT = (over = {}) => ({
  workflowId: 'wf-1',
  active: true,
  state: 'running',
  percent: 10,
  verdict: 'healthy',
  recommendation: 'promote',
  reason: '40 canary runs with no detectable regression',
  canary: arm(40, 0),
  stable: arm(400, 8),
  successTest: { pValue: 0.83, significant: false },
  durationTest: { pValue: 0.44, significant: false },
  ...over,
})

test('release exits 0 when the canary is ready to promote', async () => {
  const stub = await startStub((method, url) => {
    assert.equal(method, 'GET')
    assert.equal(url, '/api/v1/workflows/wf-1/canary')
    return { json: REPORT() }
  })
  const ctx = makeCtx(stub.api)
  const code = await release({ positionals: ['wf-1'], flags: {} }, ctx)
  await stub.close()

  assert.equal(code, 0)
  assert.match(ctx.output(), /healthy/)
  assert.match(ctx.output(), /failure rate  p = 0\.8300/)
})

test('release exits 1 when the canary should be rolled back', async () => {
  const stub = await startStub(() => ({
    json: REPORT({ verdict: 'degraded', recommendation: 'rollback', reason: 'failure rate 50.0% vs 2.0%' }),
  }))
  const ctx = makeCtx(stub.api)
  const code = await release({ positionals: ['wf-1'], flags: {} }, ctx)
  await stub.close()

  assert.equal(code, 1)
  assert.match(ctx.output(), /degraded/)
})

test('release exits 2 — not 1 — while the verdict is still pending', async () => {
  // A pipeline that treated "not enough evidence yet" as failure would roll
  // back every healthy release that happens to be young.
  const stub = await startStub(() => ({
    json: REPORT({ verdict: 'pending', recommendation: 'wait', reason: '5 of 20 canary runs so far' }),
  }))
  const ctx = makeCtx(stub.api)
  const code = await release({ positionals: ['wf-1'], flags: {} }, ctx)
  await stub.close()

  assert.equal(code, 2)
  assert.match(ctx.output(), /5 of 20 canary runs/)
})

test('release exits 1 and says so when no canary is running', async () => {
  const stub = await startStub(() => ({ json: { workflowId: 'wf-1', active: false } }))
  const ctx = makeCtx(stub.api)
  const code = await release({ positionals: ['wf-1'], flags: {} }, ctx)
  await stub.close()

  assert.equal(code, 1)
  assert.match(ctx.output(), /No canary is running/)
})

test('--promote posts to the promote endpoint and reports the version', async () => {
  const stub = await startStub((method, url) => {
    assert.equal(method, 'POST')
    assert.equal(url, '/api/v1/workflows/wf-1/canary/promote')
    return { json: { promoted: true, version: 7 } }
  })
  const ctx = makeCtx(stub.api)
  const code = await release({ positionals: ['wf-1'], flags: { promote: true } }, ctx)
  await stub.close()

  assert.equal(code, 0)
  assert.match(ctx.output(), /Promoted as version 7/)
})

test('--rollback forwards a reason and notes the definition survives', async () => {
  const stub = await startStub((method, url, body) => {
    assert.equal(url, '/api/v1/workflows/wf-1/canary/rollback')
    assert.equal(body.reason, 'smoke tests failed')
    return { json: { rolledBack: true, reason: 'smoke tests failed' } }
  })
  const ctx = makeCtx(stub.api)
  const code = await release(
    { positionals: ['wf-1'], flags: { rollback: 'smoke tests failed' } },
    ctx
  )
  await stub.close()

  assert.equal(code, 0)
  assert.match(ctx.output(), /unchanged/)
})

test('release without a workflow id prints usage and fails', async () => {
  const ctx = makeCtx(null)
  const code = await release({ positionals: [], flags: {} }, ctx)
  assert.equal(code, 1)
  assert.match(ctx.output(), /Usage: flowforge release/)
})
