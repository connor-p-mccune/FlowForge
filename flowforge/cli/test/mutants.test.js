// flowforge mutants — would any of this workflow's checks notice if it were
// subtly wrong?
//
// The exit code is the argument. A survivor is *evidence* of a gap and not
// proof of one, because an equivalent mutant cannot be killed by anything and
// no algorithm can identify those in general — so the default reports and
// passes, and `--strict` is available to a team that has read its survivors and
// knows what the gate costs.

const test = require('node:test')
const assert = require('node:assert/strict')

const { startStub, makeCtx } = require('./helpers')
const mutants = require('../src/commands/mutants')

const mutant = (over = {}) => ({
  id: 'm1',
  operator: 'swap-branches',
  nodeId: 'check',
  describe: '"Large order?" wired backwards — its true and false branches swapped',
  killed: true,
  by: 'test',
  detail: 'a large order is tagged large',
  ...over,
})

const report = (list, over = {}) => {
  const killed = list.filter((m) => m.killed)
  return {
    available: true,
    workflowId: 'wf-1',
    scenarios: 2,
    guarantees: 1,
    mutants: list,
    summary: {
      total: list.length,
      killed: killed.length,
      survived: list.length - killed.length,
      score: list.length ? Math.round((killed.length / list.length) * 100) : null,
      byLint: killed.filter((m) => m.by === 'lint').length,
      byGuarantee: killed.filter((m) => m.by === 'guarantee').length,
      byTest: killed.filter((m) => m.by === 'test').length,
    },
    ...over,
  }
}

async function run(payload, flags = {}) {
  const stub = await startStub(() => ({ json: payload }))
  const ctx = makeCtx(stub.api)
  const code = await mutants({ positionals: ['wf-1'], flags }, ctx)
  await stub.close()
  return { code, out: ctx.output(), requests: stub.requests }
}

test('lists each bug and whether anything caught it', async () => {
  const { code, out } = await run(report([mutant()]))
  assert.equal(code, 0)
  assert.match(out, /IF THIS WERE THE BUG/)
  assert.match(out, /wired backwards/)
  assert.match(out, /^caught\s+"Large order\?" wired backwards.*a test$/m)
})

test('says which kind of check did the catching', async () => {
  const { out } = await run(
    report([
      mutant({ id: 'm1', by: 'lint' }),
      mutant({ id: 'm2', by: 'guarantee', operator: 'remove-gate' }),
      mutant({ id: 'm3', by: 'test' }),
    ])
  )
  assert.match(out, /the linter/)
  assert.match(out, /a guarantee/)
  assert.match(out, /a test/)
})

test('counts the kills by what caught them', async () => {
  const { out } = await run(
    report([mutant({ by: 'lint' }), mutant({ id: 'm2', by: 'test' })])
  )
  assert.match(out, /2\/2 caught \(100%\) · 1 by the linter · 0 by a guarantee · 1 by a test/)
})

// — the finding ————————————————————————————————————————————————————

test('separates out the bugs nothing would notice', async () => {
  const { out } = await run(
    report([mutant(), mutant({ id: 'm2', killed: false, by: null, detail: null })])
  )
  assert.match(out, /MISSED/)
  assert.match(out, /1 bug\(s\) nothing would notice/)
})

test('says what would fix it, rather than only that it is broken', async () => {
  const { out } = await run(report([mutant({ killed: false, by: null })]))
  assert.match(out, /asserts on what the workflow \*decided\* kills these/)
})

test('warns when the linter is the only thing checking the workflow', async () => {
  const { out } = await run(
    report([mutant({ by: 'lint' })], { scenarios: 0, guarantees: 0 })
  )
  assert.match(out, /no scenarios and no guarantees/)
  assert.match(out, /everything the linter cannot see gets through/)
})

// — the exit code —————————————————————————————————————————————————

test('passes by default even with survivors, because a survivor is not proof', async () => {
  const { code } = await run(report([mutant({ killed: false, by: null })]))
  assert.equal(code, 0)
})

test('--strict fails on a survivor, and says why the number is noisy', async () => {
  const { code, out } = await run(report([mutant({ killed: false, by: null })]), { strict: true })
  assert.equal(code, 1)
  assert.match(out, /1 mutation\(s\) survived/)
  assert.match(out, /Some may be equivalent/)
  assert.match(out, /no algorithm can tell those apart/)
})

test('--strict passes when everything was caught', async () => {
  assert.equal((await run(report([mutant()]), { strict: true })).code, 0)
})

test('says so when there is nothing to mutate', async () => {
  const { code, out } = await run({ available: false, reason: 'no-mutations' })
  assert.equal(code, 0)
  assert.match(out, /no conditions, gates or removable steps/)
})

test('says so for an empty workflow', async () => {
  const { out } = await run({ available: false, reason: 'empty' })
  assert.match(out, /the workflow is empty/)
})

test('posts, because the analysis executes', async () => {
  const { requests } = await run(report([mutant()]))
  assert.equal(requests[0].method, 'POST')
  assert.equal(requests[0].path, '/api/v1/workflows/wf-1/mutations')
})

test('without a workflow id prints usage and fails', async () => {
  const ctx = makeCtx(null)
  const code = await mutants({ positionals: [], flags: {} }, ctx)
  assert.equal(code, 1)
  assert.match(ctx.output(), /Usage: flowforge mutants/)
})
