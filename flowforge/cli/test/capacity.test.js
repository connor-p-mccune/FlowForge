// flowforge capacity — is this workflow's concurrency cap the right number?
//
// The output leads with the model check rather than the prediction, because
// everything below it is worth exactly as much as that line says. A number
// that has been checked against recorded history and a number that has not are
// different kinds of number, and printing them the same way would be the
// dishonest part.

const test = require('node:test')
const assert = require('node:assert/strict')

const { startStub, makeCtx } = require('./helpers')
const capacity = require('../src/commands/capacity')

const prediction = (servers, over = {}) => ({
  servers,
  stable: true,
  utilisation: 0.5,
  headroom: 2,
  waitMeanMs: 4000,
  waitP95Ms: 15000,
  ...over,
})

const HEALTHY = {
  available: true,
  workflowId: 'wf-1',
  name: 'Orders',
  cap: 4,
  measured: {
    runs: 336,
    windowDays: 7,
    arrivalsPerHour: 2,
    serviceMeanMs: 1800000,
    serviceP50Ms: 1700000,
    serviceP95Ms: 3600000,
    cvSquaredService: 1.1,
    cvSquaredArrival: 1,
    observedWaitMeanMs: 4200,
    observedWaitP50Ms: 1000,
    observedWaitP95Ms: 16000,
    sampled: { service: 336, wait: 336 },
  },
  current: prediction(4),
  calibration: {
    comparable: true,
    ratio: 0.95,
    verdict: 'agrees',
    observedMs: 4200,
    predictedMs: 4000,
  },
  curve: [
    // A cap the load would saturate: no steady state, so no wait to quote.
    prediction(2, { stable: false, utilisation: 1.1, headroom: 0.9, waitMeanMs: null, waitP95Ms: null }),
    prediction(4),
    prediction(6, { waitMeanMs: 500, utilisation: 0.33, headroom: 3 }),
  ],
  recommendation: null,
  model: { name: 'Allen–Cunneen G/G/c', variabilityFactor: 1.05, mmcWaitMeanMs: 3800 },
}

async function run(payload, flags = {}) {
  const stub = await startStub(() => ({ json: payload }))
  const ctx = makeCtx(stub.api)
  const code = await capacity({ positionals: ['wf-1'], flags }, ctx)
  await stub.close()
  return { code, out: ctx.output(), requests: stub.requests }
}

test('reports what history measured and what the cap buys', async () => {
  const { code, out } = await run(HEALTHY)
  assert.equal(code, 0)
  assert.match(out, /Capacity for Orders/)
  assert.match(out, /336 runs over 7 days · 2\.00\/hour arriving/)
  assert.match(out, /At 4 slot\(s\): 4\.0s mean wait/)
})

test('leads with whether the model matches the measured wait', async () => {
  const { out } = await run(HEALTHY)
  assert.match(out, /Model check: the model matches the measured wait/)
  // Before the prediction it is qualifying.
  assert.ok(out.indexOf('Model check') < out.indexOf('At 4 slot(s)'))
})

test('says plainly when the model predicts less wait than actually happened', async () => {
  const { out } = await run({
    ...HEALTHY,
    calibration: { comparable: true, ratio: 0.1, verdict: 'under-predicts', observedMs: 60000, predictedMs: 6000 },
  })
  assert.match(out, /something it cannot see is holding runs up/)
})

test('says there is nothing to check against on an idle queue', async () => {
  const { out } = await run({
    ...HEALTHY,
    calibration: { comparable: true, ratio: null, verdict: 'no-queue-to-check' },
  })
  assert.match(out, /no measured wait to check against/)
})

test('prices every cap in the curve, marking the current one', async () => {
  const { out } = await run(HEALTHY)
  assert.match(out, /What each cap buys/)
  assert.match(out, /4 \(now\)/)
  assert.match(out, /unstable/)
})

test('reports headroom, which is the number to act on before anything is on fire', async () => {
  const { out } = await run(HEALTHY)
  assert.match(out, /Room for 2\.00× today's traffic before the queue diverges/)
})

test('states the variability correction when it moved the answer', async () => {
  const { out } = await run({
    ...HEALTHY,
    measured: { ...HEALTHY.measured, cvSquaredService: 4 },
    model: { name: 'Allen–Cunneen G/G/c', variabilityFactor: 2.5, mmcWaitMeanMs: 1600 },
  })
  assert.match(out, /Service time CV² is 4\.0 \(1 = exponential\)/)
  assert.match(out, /2\.5× what M\/M\/c would predict/)
})

test('stays quiet about variability when it barely moved the answer', async () => {
  const { out } = await run(HEALTHY)
  assert.doesNotMatch(out, /CV²/)
})

test('fails when the queue at the current cap is already diverging', async () => {
  const { code, out } = await run({
    ...HEALTHY,
    current: prediction(4, { stable: false, utilisation: 1.4, waitMeanMs: null, waitP95Ms: null }),
  })
  assert.equal(code, 1)
  assert.match(out, /over capacity/)
  assert.match(out, /no steady-state wait to quote/)
})

test('fails and says how much to raise the cap when a target is not met', async () => {
  const { code, out } = await run(
    {
      ...HEALTHY,
      recommendation: { targetWaitMs: 1000, servers: 7, change: 3, confident: true },
    },
    { target: 1000 }
  )
  assert.equal(code, 1)
  assert.match(out, /Raise the cap to 7 \(\+3\) for 1\.0s/)
})

test('passes when the current cap already meets the target', async () => {
  const { code, out } = await run(
    { ...HEALTHY, recommendation: { targetWaitMs: 30000, servers: 4, change: 0, confident: true } },
    { target: 30000 }
  )
  assert.equal(code, 0)
  assert.match(out, /already meets 30\.0s/)
})

test('passes and reports the saving when the cap could be smaller', async () => {
  const { code, out } = await run(
    { ...HEALTHY, recommendation: { targetWaitMs: 60000, servers: 2, change: -2, confident: true } },
    { target: 60000 }
  )
  assert.equal(code, 0)
  assert.match(out, /A cap of 2 \(-2\) would still meet/)
})

test('downgrades the recommendation when the model does not match history', async () => {
  const { out } = await run(
    {
      ...HEALTHY,
      calibration: { comparable: true, ratio: 5, verdict: 'over-predicts', observedMs: 800, predictedMs: 4000 },
      recommendation: { targetWaitMs: 1000, servers: 7, change: 3, confident: false },
    },
    { target: 1000 }
  )
  assert.match(out, /Treat this as a suggestion: the model does not match the measured window/)
})

test('says so when no cap can reach the target', async () => {
  const { code, out } = await run(
    { ...HEALTHY, recommendation: { targetWaitMs: 0, servers: null, change: null, confident: true } },
    { target: 0 }
  )
  assert.equal(code, 1)
  assert.match(out, /No cap reaches a mean wait of/)
  assert.match(out, /towards zero but never below it/)
})

test('explains a workflow with no cap rather than reporting nothing', async () => {
  const { code, out } = await run({ available: false, reason: 'no-cap', name: 'Orders' })
  assert.equal(code, 0)
  assert.match(out, /never queue behind each other/)
})

test('explains too little history rather than guessing a rate', async () => {
  const { code, out } = await run({
    available: false, reason: 'not-enough-runs', runs: 12, needed: 30, windowDays: 7,
  })
  assert.equal(code, 0)
  assert.match(out, /12 run\(s\) in the last 7 days, 30 needed/)
  assert.match(out, /a rumour, not a rate/)
})

test('passes the flags through as query parameters', async () => {
  const { requests } = await run(HEALTHY, { target: 1000, cap: 12, days: 30 })
  assert.match(requests[0].path, /^\/api\/v1\/workflows\/wf-1\/capacity\?/)
  assert.match(requests[0].path, /target=1000/)
  assert.match(requests[0].path, /cap=12/)
  assert.match(requests[0].path, /days=30/)
})

test('asks for no parameters when none were given', async () => {
  const { requests } = await run(HEALTHY)
  assert.equal(requests[0].path, '/api/v1/workflows/wf-1/capacity')
})

test('without a workflow id prints usage and fails', async () => {
  const ctx = makeCtx(null)
  const code = await capacity({ positionals: [], flags: {} }, ctx)
  assert.equal(code, 1)
  assert.match(ctx.output(), /Usage: flowforge capacity/)
})
