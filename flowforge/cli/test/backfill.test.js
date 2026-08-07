const test = require('node:test')
const assert = require('node:assert/strict')

const { startStub, makeCtx } = require('./helpers')
const backfill = require('../src/commands/backfill')
const { parseWhen } = require('../src/commands/backfill')

const PLAN = {
  cron: '0 9 * * *',
  timeZone: 'UTC',
  from: '2026-03-01T00:00:00.000Z',
  to: '2026-03-04T00:00:00.000Z',
  total: 3,
  skipped: 1,
  willRun: 2,
  occurrences: [
    { logicalDate: '2026-03-01T09:00:00.000Z', alreadyRan: true },
    { logicalDate: '2026-03-02T09:00:00.000Z', alreadyRan: false },
    { logicalDate: '2026-03-03T09:00:00.000Z', alreadyRan: false },
  ],
}

const SUBMITTED = {
  backfillId: 'bf-1',
  created: 2,
  skipped: 1,
  priority: 'low',
  from: PLAN.from,
  to: PLAN.to,
  timeZone: 'UTC',
}

// The stub answers the preview and the submit differently, which is how the
// tests can tell whether the command actually committed anything.
function stubFor() {
  return startStub((method, url, body) => ({ json: body?.preview ? PLAN : SUBMITTED }))
}

test('parseWhen accepts ISO timestamps, relative windows, and "now"', () => {
  const now = Date.parse('2026-03-10T12:00:00.000Z')
  assert.equal(parseWhen('2026-03-01T00:00:00Z'), '2026-03-01T00:00:00.000Z')
  assert.equal(parseWhen('now', { now }), '2026-03-10T12:00:00.000Z')
  assert.equal(parseWhen('3d', { now }), '2026-03-07T12:00:00.000Z')
  assert.equal(parseWhen('6h', { now }), '2026-03-10T06:00:00.000Z')
  assert.equal(parseWhen('90m', { now }), '2026-03-10T10:30:00.000Z')
  assert.equal(parseWhen('gibberish'), null)
  assert.equal(parseWhen(''), null)
  assert.equal(parseWhen(undefined), null)
})

test('backfill previews without submitting', async () => {
  const stub = await stubFor()
  const ctx = makeCtx(stub.api)
  const code = await backfill(
    { positionals: ['wf-1'], flags: { from: '2026-03-01T00:00:00Z', to: '2026-03-04T00:00:00Z', preview: true } },
    ctx
  )
  await stub.close()

  assert.equal(code, 0)
  assert.equal(stub.requests.length, 1)
  assert.equal(stub.requests[0].body.preview, true)
  assert.match(ctx.output(), /2 runs/)
  assert.match(ctx.output(), /1 already ran/)
  assert.match(ctx.output(), /0 9 \* \* \* \[UTC\]/)
})

test('backfill refuses to submit without --yes', async () => {
  // The one CLI verb that turns a single line into hundreds of runs.
  const stub = await stubFor()
  const ctx = makeCtx(stub.api)
  const code = await backfill(
    { positionals: ['wf-1'], flags: { from: '2026-03-01T00:00:00Z' } },
    ctx
  )
  await stub.close()

  assert.equal(code, 1)
  // Only the preview was sent — nothing was created.
  assert.equal(stub.requests.length, 1)
  assert.equal(stub.requests[0].body.preview, true)
  assert.match(ctx.output(), /Refusing to create 2 runs without --yes/)
})

test('backfill submits with --yes and reports the batch', async () => {
  const stub = await stubFor()
  const ctx = makeCtx(stub.api)
  const code = await backfill(
    { positionals: ['wf-1'], flags: { from: '2026-03-01T00:00:00Z', yes: true } },
    ctx
  )
  await stub.close()

  assert.equal(code, 0)
  assert.equal(stub.requests.length, 2)
  const submit = stub.requests[1]
  assert.equal(submit.body.preview, undefined)
  assert.equal(submit.body.skipExisting, true)
  assert.match(ctx.output(), /Queued 2 runs/)
  assert.match(ctx.output(), /low lane/)
  assert.match(ctx.output(), /bf-1/)
})

test('backfill --all asks the server not to skip covered occurrences', async () => {
  const stub = await stubFor()
  const ctx = makeCtx(stub.api)
  await backfill(
    { positionals: ['wf-1'], flags: { from: '7d', yes: true, all: true, priority: 'normal' } },
    ctx
  )
  await stub.close()

  assert.equal(stub.requests[1].body.skipExisting, false)
  assert.equal(stub.requests[1].body.priority, 'normal')
})

test('backfill reports an empty plan without failing', async () => {
  const empty = { ...PLAN, total: 2, skipped: 2, willRun: 0 }
  const stub = await startStub((method, url, body) => ({ json: body?.preview ? empty : SUBMITTED }))
  const ctx = makeCtx(stub.api)
  const code = await backfill(
    { positionals: ['wf-1'], flags: { from: '2026-03-01T00:00:00Z', yes: true } },
    ctx
  )
  await stub.close()

  assert.equal(code, 0)
  assert.equal(stub.requests.length, 1) // never submitted
  assert.match(ctx.output(), /Nothing to do/)
})

test('backfill without --from prints usage and fails', async () => {
  const ctx = makeCtx(null)
  const code = await backfill({ positionals: ['wf-1'], flags: {} }, ctx)
  assert.equal(code, 1)
  assert.match(ctx.output(), /Usage: flowforge backfill/)
})
