// flowforge query — asking a question of run history.
//
// The exit code is the design. 0 on matches, 1 on none, 2 on a predicate that
// does not parse — so `flowforge query <id> 'status == "failed"' && page-oncall`
// is a monitor, and a script can tell "no results" from "you typed it wrong".
// That is the distinction `grep` gets right and most tools do not.

const test = require('node:test')
const assert = require('node:assert/strict')

const { startStub, makeCtx } = require('./helpers')
const query = require('../src/commands/query')

const run = (id, over = {}) => ({
  id,
  status: 'failed',
  triggerType: 'webhook',
  priority: null,
  createdAt: '2026-08-01T10:00:00.000Z',
  startedAt: '2026-08-01T10:00:02.000Z',
  finishedAt: '2026-08-01T10:00:07.000Z',
  durationMs: 5000,
  waitMs: 2000,
  ...over,
})

const RESULT = {
  workflowId: 'wf-1',
  ok: true,
  runs: [run('a1b2c3d4-0000-0000-0000-000000000001'), run('e5f6a7b8-0000-0000-0000-000000000002')],
  plan: {
    pushedDown: ['status == "failed"'],
    loadedSteps: true,
    scanned: 240,
    matched: 2,
    truncated: false,
    evaluationErrors: 0,
  },
}

const EMPTY = {
  ...RESULT,
  runs: [],
  plan: { ...RESULT.plan, matched: 0 },
}

async function go(payload, { positionals = ['wf-1', 'status == "failed"'], flags = {}, status = 200 } = {}) {
  const stub = await startStub(() => ({ status, json: payload }))
  const ctx = makeCtx(stub.api)
  const code = await query({ positionals, flags }, ctx)
  await stub.close()
  return { code, out: ctx.output(), requests: stub.requests }
}

test('lists the matching runs', async () => {
  const { code, out } = await go(RESULT)
  assert.equal(code, 0)
  assert.match(out, /2026-08-01 10:00:00/)
  assert.match(out, /a1b2c3d4/)
  assert.match(out, /5\.0s/)
})

test('sends the predicate in a body, joined from the positionals', async () => {
  const { requests } = await go(RESULT, {
    positionals: ['wf-1', 'status ==', '"failed"'],
  })
  assert.equal(requests[0].method, 'POST')
  assert.equal(requests[0].path, '/api/v1/workflows/wf-1/query')
  assert.equal(requests[0].body.where, 'status == "failed"')
})

test('passes a limit through', async () => {
  const { requests } = await go(RESULT, { flags: { limit: 5 } })
  assert.equal(requests[0].body.limit, 5)
})

test('summarises how much it had to read', async () => {
  const { out } = await go(RESULT)
  assert.match(out, /2 match\(es\) from 240 run\(s\) scanned/)
})

// — the exit codes ——————————————————————————————————————————————————

test('exits 1 when nothing matches, so a query composes as a monitor', async () => {
  const { code, out } = await go(EMPTY)
  assert.equal(code, 1)
  assert.match(out, /No runs match\. 240 scanned/)
})

test('exits 2 on a predicate that does not parse, which is not the same as none', async () => {
  const { code, out } = await go(
    { error: 'Unexpected end of input', position: 9 },
    { positionals: ['wf-1', 'status =='], status: 400 }
  )
  assert.equal(code, 2)
  assert.match(out, /Could not parse the predicate: Unexpected end of input/)
})

test('points a caret at the character the parser stopped on', async () => {
  const { out } = await go(
    { error: 'Unexpected end of input', position: 9 },
    { positionals: ['wf-1', 'status =='], status: 400 }
  )
  // Without the position somebody counts brackets.
  assert.match(out, /\n {2}status ==\n {11}\^/)
})

test('exits 2 with usage and examples when there is no predicate', async () => {
  const ctx = makeCtx(null)
  const code = await query({ positionals: ['wf-1'], flags: {} }, ctx)
  assert.equal(code, 2)
  assert.match(ctx.output(), /Usage: flowforge query/)
  assert.match(ctx.output(), /steps\.charge\.output\.status >= 500/)
  assert.match(ctx.output(), /"charge" in steps/)
})

// — telling one kind of nothing from another ————————————————————————

test('says when the predicate threw rather than reporting a bare zero', async () => {
  const { code, out } = await go({
    ...EMPTY,
    plan: { ...EMPTY.plan, evaluationErrors: 12 },
  })
  assert.equal(code, 1)
  assert.match(out, /12 run\(s\) could not be evaluated/)
  assert.match(out, /Check the field names/)
})

test('says when it stopped scanning rather than implying it saw everything', async () => {
  const { out } = await go({ ...EMPTY, plan: { ...EMPTY.plan, truncated: true } })
  assert.match(out, /Stopped after 240; there may be older matches/)
})

test('marks a truncated scan on a result set too', async () => {
  const { out } = await go({ ...RESULT, plan: { ...RESULT.plan, truncated: true } })
  assert.match(out, /stopped at the scan cap, older matches may exist/)
})

// — --explain ————————————————————————————————————————————————————————

test('--explain names what was narrowed in SQL', async () => {
  const { out } = await go(RESULT, { flags: { explain: true } })
  assert.match(out, /Plan/)
  assert.match(out, /narrowed in SQL by .*status == "failed"/)
  assert.match(out, /loaded per candidate run/)
})

test('--explain warns loudly when nothing could be narrowed', async () => {
  // The difference between an indexed lookup and reading every run the
  // workflow has ever had.
  const { out } = await go(
    { ...RESULT, plan: { ...RESULT.plan, pushedDown: [], loadedSteps: false } },
    { flags: { explain: true } }
  )
  assert.match(out, /nothing could be narrowed in SQL — every run was read/)
  assert.match(out, /under a not, an or, or a conditional are never pushed down/)
})

test('stays quiet about the plan without --explain', async () => {
  const { out } = await go(RESULT)
  assert.doesNotMatch(out, /narrowed in SQL/)
})

test('--json prints the raw result and keeps the exit code', async () => {
  const { code, out } = await go(RESULT, { flags: { json: true } })
  assert.equal(code, 0)
  assert.equal(JSON.parse(out).runs.length, 2)
})

test('--json on an empty result still exits 1', async () => {
  const { code } = await go(EMPTY, { flags: { json: true } })
  assert.equal(code, 1)
})
