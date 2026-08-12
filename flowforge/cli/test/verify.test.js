// flowforge verify — the guarantee gate from a terminal.
//
// The exit code is the whole product here, so most of these assert on it. The
// one that matters most is `unknown`: a guarantee naming a deleted node must
// fail the build, because the alternative is a pipeline that goes green forever
// the moment somebody removes the approval it was guarding.

const test = require('node:test')
const assert = require('node:assert/strict')

const { startStub, makeCtx } = require('./helpers')
const verify = require('../src/commands/verify')

const HOLDS = {
  workflowId: 'wf-1',
  ok: true,
  analysed: true,
  results: [
    {
      kind: 'requires',
      node: 'charge',
      other: 'approve',
      statement: 'Charge card never runs unless Approve ran first',
      status: 'holds',
    },
  ],
  facts: {
    alwaysRuns: [{ nodeId: 'hook', label: 'Order webhook' }],
    decisions: [{ nodeId: 'approve', label: 'Approve', outcomes: ['true', 'false'] }],
  },
  suggestions: [
    {
      kind: 'exclusive',
      node: 'ship',
      other: 'refund',
      statement: 'Ship and Refund never both run',
    },
  ],
}

const VIOLATED = {
  workflowId: 'wf-1',
  ok: false,
  analysed: true,
  results: [
    {
      kind: 'requires',
      node: 'charge',
      other: 'approve',
      statement: 'Charge card never runs unless Approve ran first',
      status: 'violated',
      message: 'Run by hand → Charge card reaches Charge card without Approve',
      counterexample: ['manual', 'charge'],
    },
  ],
  facts: { alwaysRuns: [], decisions: [] },
  suggestions: [],
}

async function run(payload, flags = {}) {
  const stub = await startStub(() => ({ json: payload }))
  const ctx = makeCtx(stub.api)
  const code = await verify({ positionals: ['wf-1'], flags }, ctx)
  await stub.close()
  return { code, out: ctx.output(), requests: stub.requests }
}

test('a holding guarantee exits 0 and says so', async () => {
  const { code, out } = await run(HOLDS)
  assert.equal(code, 0)
  assert.match(out, /Charge card never runs unless Approve ran first/)
  assert.match(out, /1 guarantee hold/)
})

test('a violated guarantee exits 1 and prints the counterexample', async () => {
  const { code, out } = await run(VIOLATED)
  assert.equal(code, 1)
  assert.match(out, /reaches Charge card without Approve/)
  assert.match(out, /counterexample: manual → charge/)
})

test('a guarantee that can no longer be checked fails the build too', async () => {
  // The quiet failure: the node it names was deleted, so it stops failing. A
  // pipeline that treated this as a pass would go green forever.
  const { code, out } = await run({
    ...VIOLATED,
    ok: false,
    results: [
      {
        ...VIOLATED.results[0],
        status: 'unknown',
        message: '"approve" is no longer in this workflow — the guarantee can’t be checked',
        counterexample: null,
      },
    ],
  })
  assert.equal(code, 1)
  assert.match(out, /no longer in this workflow/)
})

test('a workflow with nothing declared passes quietly', async () => {
  const { code, out } = await run({
    workflowId: 'wf-1',
    ok: true,
    analysed: true,
    results: [],
    facts: { alwaysRuns: [], decisions: [] },
    suggestions: [],
  })
  assert.equal(code, 0)
  assert.match(out, /No guarantees declared/)
})

test('offers the suggestions when there is nothing declared to report', async () => {
  const { out } = await run({ ...HOLDS, results: [] })
  assert.match(out, /worth pinning/)
  assert.match(out, /Ship and Refund never both run/)
})

test('--facts prints what is true regardless of what was declared', async () => {
  const { out } = await run(HOLDS, { facts: true })
  assert.match(out, /Always runs/)
  assert.match(out, /Order webhook/)
  assert.match(out, /Approve .*true \| false/)
})

test('--suggest prints the invariants worth pinning', async () => {
  const { out } = await run(HOLDS, { suggest: true })
  assert.match(out, /Ship and Refund never both run/)
})

test('--json prints the raw report and keeps the exit code', async () => {
  const { code, out } = await run(VIOLATED, { json: true })
  assert.equal(code, 1)
  assert.deepEqual(JSON.parse(out), VIOLATED)
})

test('says so when the graph admits no execution at all', async () => {
  const { out } = await run({
    workflowId: 'wf-1',
    ok: false,
    analysed: false,
    reason: 'cycle',
    results: [{ ...VIOLATED.results[0], status: 'unknown', message: 'cycle' }],
    facts: null,
    suggestions: [],
  })
  assert.match(out, /contains a cycle/)
})

test('hits the guarantees endpoint for the right workflow', async () => {
  const { requests } = await run(HOLDS)
  assert.equal(requests[0].path, '/api/v1/workflows/wf-1/guarantees')
})

test('verify without a workflow id prints usage and fails', async () => {
  const ctx = makeCtx(null)
  assert.equal(await verify({ positionals: [], flags: {} }, ctx), 1)
  assert.match(ctx.output(), /Usage: flowforge verify/)
})
