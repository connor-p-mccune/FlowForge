// flowforge assertions — what a workflow says must never happen.
//
// The exit code is where the design shows. A violation fails the build, and so
// does a *broken* assertion: one whose predicate throws on every run reports
// zero violations, so gating on violations alone would pass a build whose only
// check has never once worked.

const test = require('node:test')
const assert = require('node:assert/strict')

const { startStub, makeCtx } = require('./helpers')
const assertions = require('../src/commands/assertions')

const entry = (over = {}) => ({
  id: 'as-1',
  name: 'no 5xx from charge',
  predicate: 'steps.charge.output.status >= 500',
  enabled: true,
  state: 'holding',
  checked: 412,
  violations: 0,
  errors: 0,
  lastError: null,
  lastCheckedAt: '2026-08-22T10:00:00.000Z',
  lastViolationAt: null,
  lastViolationExecutionId: null,
  ...over,
})

const report = (list, over = {}) => ({
  workflowId: 'wf-1',
  assertions: list,
  summary: {
    total: list.length,
    violated: list.filter((a) => a.state === 'violated').length,
    broken: list.filter((a) => a.state === 'broken').length,
    holding: list.filter((a) => a.state === 'holding').length,
    unchecked: list.filter((a) => a.state === 'unchecked').length,
    ...over,
  },
})

async function run(payload, flags = {}) {
  const stub = await startStub(() => ({ json: payload }))
  const ctx = makeCtx(stub.api)
  const code = await assertions({ positionals: ['wf-1'], flags }, ctx)
  await stub.close()
  return { code, out: ctx.output(), requests: stub.requests }
}

test('lists what is pinned and whether it is holding', async () => {
  const { code, out } = await run(report([entry()]))
  assert.equal(code, 0)
  assert.match(out, /What must never happen/)
  assert.match(out, /holding\s+no 5xx from charge\s+412/)
})

test('fails on a violation and names the counterexample', async () => {
  // A report that said "this happened" without naming the run would leave
  // somebody grepping.
  const { code, out } = await run(
    report([
      entry({
        state: 'violated',
        violations: 3,
        lastViolationExecutionId: 'e57a1234',
        lastViolationAt: '2026-08-22T11:30:00.000Z',
      }),
    ])
  )
  assert.equal(code, 1)
  assert.match(out, /VIOLATED/)
  assert.match(out, /Counterexamples/)
  assert.match(out, /last matched e57a1234 at 2026-08-22 11:30:00/)
  assert.match(out, /steps\.charge\.output\.status >= 500/)
})

test('fails on a broken assertion, which reports zero violations', async () => {
  // The argument the exit code exists to make: gating on violations alone
  // would pass a build whose only check has never once worked.
  const { code, out } = await run(
    report([entry({ state: 'broken', checked: 0, errors: 412, lastError: 'first: expected an array' })])
  )
  assert.equal(code, 1)
  assert.match(out, /Never evaluated/)
  assert.match(out, /first: expected an array/)
  assert.match(out, /reporting\s*\n?\s*zero violations without checking anything/)
})

test('passes when everything holds', async () => {
  assert.equal((await run(report([entry(), entry({ id: 'as-2', name: 'other' })]))).code, 0)
})

test('marks a disabled assertion rather than hiding it', async () => {
  const { out } = await run(report([entry({ enabled: false })]))
  assert.match(out, /no 5xx from charge \(off\)/)
})

test('counts the states in one line', async () => {
  const { out } = await run(
    report([
      entry(),
      entry({ id: 'as-2', name: 'b', state: 'unchecked', checked: 0 }),
    ])
  )
  assert.match(out, /2 assertion\(s\) · 1 holding · 0 violated · 0 broken · 1 unchecked/)
})

test('--strict fails on an assertion no run has exercised', async () => {
  const { code, out } = await run(
    report([entry({ state: 'unchecked', checked: 0 })]),
    { strict: true }
  )
  assert.equal(code, 1)
  assert.match(out, /have not seen a run yet/)
})

test('--strict passes when every assertion has been exercised', async () => {
  assert.equal((await run(report([entry()]), { strict: true })).code, 0)
})

test('says what to do when nothing is pinned', async () => {
  const { code, out } = await run(report([]))
  assert.equal(code, 0)
  assert.match(out, /declares nothing that must never happen/)
  assert.match(out, /Develop a predicate with `flowforge query`/)
})

test('hits the assertions endpoint for the right workflow', async () => {
  const { requests } = await run(report([entry()]))
  assert.equal(requests[0].path, '/api/v1/workflows/wf-1/assertions')
})

test('without a workflow id prints usage and fails', async () => {
  const ctx = makeCtx(null)
  const code = await assertions({ positionals: [], flags: {} }, ctx)
  assert.equal(code, 1)
  assert.match(ctx.output(), /Usage: flowforge assertions/)
})
