// flowforge repeats — what happens twice.
//
// The exit code carries one number and deliberately not the whole report:
// `--strict` gates on steps the engine retries *by itself*, because those need
// no crash and no bad luck beyond a timeout. A workflow whose crash recovery
// would park for a person is working as designed, and failing a build for it
// would teach somebody to stop running this.

const test = require('node:test')
const assert = require('node:assert/strict')

const { startStub, makeCtx } = require('./helpers')
const repeats = require('../src/commands/repeats')

const step = (over = {}) => ({
  nodeId: 'charge',
  label: 'Charge card',
  type: 'action-http',
  verdict: 'unsafe',
  method: 'POST',
  why: 'a POST with no idempotency key — a repeat sends the request again',
  retried: true,
  ...over,
})

const report = (over = {}) => ({
  available: true,
  workflowId: 'wf-1',
  name: 'Orders',
  steps: [step()],
  recovery: { policy: 'safe', verdict: 'blocks-recovery', why: '1 step(s) would stop a crashed run and need a person' },
  summary: {
    steps: 1,
    safe: 0,
    guarded: 0,
    unsafe: 1,
    billed: 0,
    unknown: 0,
    opaque: 0,
    maxAttempts: 3,
    retriedUnsafe: 1,
    declaredButUnsendable: 0,
    ...over.summary,
  },
  ...over,
})

async function run(payload, flags = {}) {
  const stub = await startStub(() => ({ json: payload }))
  const ctx = makeCtx(stub.api)
  const code = await repeats({ positionals: ['wf-1'], flags }, ctx)
  await stub.close()
  return { code, out: ctx.output(), requests: stub.requests }
}

test('grades each step and says why', async () => {
  const { code, out } = await run(report())
  assert.equal(code, 0)
  assert.match(out, /What happens twice in Orders/)
  assert.match(out, /Charge card/)
  assert.match(out, /no idempotency key/)
})

test('separates a step the engine retries from one that needs a resume', async () => {
  // The distinction the whole command turns on.
  const { out } = await run(
    report({
      steps: [step(), step({ nodeId: 'call', label: 'Fulfil order', type: 'sub-workflow', retried: false })],
    })
  )
  assert.match(out, /retried ×3/)
  assert.match(out, /on resume/)
})

test('names the steps that repeat with nothing having gone wrong', async () => {
  const { out } = await run(report())
  assert.match(out, /1 step\(s\) the engine retries by itself would repeat their work: Charge card/)
  assert.match(out, /No crash needed/)
})

test('--strict fails on those and only those', async () => {
  assert.equal((await run(report(), { strict: true })).code, 1)
})

test('--strict passes a workflow whose only hazard needs a crash', async () => {
  // A recovery that parks for a person is the policy working, not a build
  // failure.
  const clean = report({
    steps: [step({ retried: false })],
    summary: { retriedUnsafe: 0 },
  })
  const { code, out } = await run(clean, { strict: true })
  assert.equal(code, 0)
  assert.match(out, /Nothing the engine retries on its own would do its work twice/)
})

test('reports the recovery policy as a claim the graph can deny', async () => {
  const { out } = await run(
    report({
      recovery: {
        policy: 'resume',
        verdict: 'contradicted',
        why: 'the policy says every step is safe to repeat; 1 is not',
      },
    })
  )
  assert.match(out, /recovery_policy is "resume", and the graph says otherwise/)
})

test('will not certify a policy over a step it could not settle', async () => {
  const { out } = await run(
    report({
      recovery: { policy: 'resume', verdict: 'unverified', why: '1 step(s) the graph does not settle either way' },
    })
  )
  assert.match(out, /cannot confirm it/)
})

test('calls out a declaration the runner cannot send', async () => {
  // The one finding here with a wrong belief attached rather than a missing
  // one: the author ticked a box and thinks they are covered.
  const { out } = await run(
    report({
      steps: [step({ nodeId: 'mail', label: 'Send receipt', type: 'action-email', declaredButUnsendable: true })],
      summary: { declaredButUnsendable: 1 },
    })
  )
  assert.match(out, /1 node\(s\) declare "idempotent" on a type that sends no key/)
  assert.match(out, /the linter flags the same nodes/)
})

test('shows where an inherited hazard actually lives', async () => {
  const { out } = await run(
    report({
      steps: [
        step({
          nodeId: 'call',
          label: 'Fulfil order',
          type: 'sub-workflow',
          retried: false,
          calls: { workflowId: 'wf-2', name: 'Fulfilment', steps: 1 },
          why: 'the worst a repeat of Fulfilment does is unsafe',
        }),
      ],
      summary: { retriedUnsafe: 0 },
    })
  )
  assert.match(out, /Fulfil order .*→ Fulfilment/)
})

test('says so plainly when nothing would change on a second run', async () => {
  const { code, out } = await run(report({ steps: [], summary: { steps: 0, unsafe: 0, retriedUnsafe: 0 } }))
  assert.equal(code, 0)
  assert.match(out, /Nothing this workflow does would change if a step ran twice/)
})

test('handles an empty workflow rather than rendering an empty table', async () => {
  const { code, out } = await run({ available: false, reason: 'empty' })
  assert.equal(code, 0)
  assert.match(out, /the workflow is empty/)
})

test('asks the endpoint for the right workflow', async () => {
  const { requests } = await run(report())
  assert.equal(requests[0].path, '/api/v1/workflows/wf-1/repeats')
})

test('without a workflow id prints usage and fails', async () => {
  const ctx = makeCtx(null)
  assert.equal(await repeats({ positionals: [], flags: {} }, ctx), 1)
  assert.match(ctx.output(), /Usage: flowforge repeats/)
})
