// flowforge explain — why did this run do what it did?
//
// `run` will tell you the email step says skipped, which is the fact somebody
// already has when they come asking. This says why, and `--node` is how the
// question is actually asked: nobody wants a run explained, they want to know
// why *that* did not happen.

const test = require('node:test')
const assert = require('node:assert/strict')

const { startStub, makeCtx } = require('./helpers')
const explain = require('../src/commands/explain')

const because = (over = {}) => ({
  nodeId: 'risky',
  label: 'High risk?',
  outcome: 'true',
  expression: 'total > 100',
  reads: [{ path: 'total', value: '850' }],
  ...over,
})

const report = (over = {}) => ({
  available: true,
  executionId: 'exec-1',
  workflowId: 'wf-1',
  name: 'Orders',
  status: 'completed',
  steps: [
    { nodeId: 't', label: 'Start', type: 'trigger-webhook', status: 'succeeded' },
    { nodeId: 'risky', label: 'High risk?', type: 'condition', status: 'succeeded' },
    { nodeId: 'log', label: 'Log it', type: 'output-log', status: 'succeeded' },
    { nodeId: 'charge', label: 'Charge card', type: 'action-http', status: 'skipped', because: because() },
    { nodeId: 'mail', label: 'Send receipt', type: 'action-email', status: 'skipped', because: because() },
  ],
  decisions: [
    {
      nodeId: 'risky',
      label: 'High risk?',
      type: 'condition',
      status: 'succeeded',
      outcome: 'true',
      expression: 'total > 100',
      reads: [{ path: 'total', value: '850' }],
      closed: ['false'],
    },
  ],
  summary: { ran: 3, skipped: 2, failed: 0, unreached: 0, decisions: 1, unexplained: 0 },
  ...over,
})

async function run(payload, { flags = {}, positionals = ['exec-1'] } = {}) {
  const stub = await startStub(() => ({ json: payload }))
  const ctx = makeCtx(stub.api)
  const code = await explain({ positionals, flags }, ctx)
  await stub.close()
  return { code, out: ctx.output(), requests: stub.requests }
}

test('answers why the email did not send', async () => {
  const { code, out } = await run(report())
  assert.equal(code, 0)
  assert.match(out, /Send receipt/)
  assert.match(out, /High risk\? was true, and that branch does not reach it/)
})

test('reads the condition out loud with the value it saw', async () => {
  const { out } = await run(report())
  assert.match(out, /total > 100 — total was 850/)
})

test('leads with the decisions, because they are the causes', async () => {
  const { out } = await run(report())
  assert.ok(out.indexOf('What each decision decided') < out.indexOf('What did not run'), out)
  assert.match(out, /High risk\? .*→.* true.*\(closing false\)/)
})

test('--node narrows to the question somebody actually asked', async () => {
  const { out } = await run(report(), { flags: { node: 'mail' } })
  assert.match(out, /Send receipt/)
  assert.match(out, /High risk\? was true/)
  // Not the whole run.
  assert.ok(!out.includes('What each decision decided'), out)
})

test('--node accepts a label as well as an id', async () => {
  const { out } = await run(report(), { flags: { node: 'Send receipt' } })
  assert.match(out, /High risk\? was true/)
})

test('--node fails on a node the run does not have', async () => {
  const { code, out } = await run(report(), { flags: { node: 'nope' } })
  assert.equal(code, 1)
  assert.match(out, /No node "nope"/)
})

test('blames the failure above a step when no decision did', async () => {
  const upstream = report({
    steps: [
      { nodeId: 'mail', label: 'Send receipt', type: 'action-email', status: 'skipped',
        because: { kind: 'upstream-failure', nodeId: 't', label: 'Start', error: 'payload was not JSON', reads: [] } },
    ],
    decisions: [],
    summary: { ran: 0, skipped: 1, failed: 1, unreached: 0, decisions: 0, unexplained: 0 },
  })
  const { out } = await run(upstream)
  assert.match(out, /Start failed above it, so the run never got here/)
  assert.match(out, /payload was not JSON/)
})

test('says a cancelled run was cancelled', async () => {
  const cancelled = report({
    status: 'cancelled',
    steps: [
      { nodeId: 'mail', label: 'Send receipt', type: 'action-email', status: 'skipped',
        because: { kind: 'cancelled', reads: [] } },
    ],
    decisions: [],
    summary: { ran: 0, skipped: 1, failed: 0, unreached: 0, decisions: 0, unexplained: 0 },
  })
  assert.match((await run(cancelled)).out, /the run was cancelled before it got here/)
})

test('says plainly when no decision accounts for a skip', async () => {
  const orphan = report({
    steps: [{ nodeId: 'mail', label: 'Send receipt', type: 'action-email', status: 'skipped' }],
    decisions: [],
    summary: { ran: 0, skipped: 1, failed: 0, unreached: 0, decisions: 0, unexplained: 1 },
  })
  const { out } = await run(orphan)
  assert.match(out, /nothing in this run accounts for it/)
  assert.match(out, /1 skipped step\(s\) no settled decision in this run accounts for/)
})

test('reports a decision that failed as having decided nothing', async () => {
  const failed = report({
    decisions: [
      {
        nodeId: 'risky',
        label: 'High risk?',
        type: 'condition',
        status: 'failed',
        outcome: null,
        expression: null,
        reads: [],
        closed: [],
      },
    ],
  })
  assert.match((await run(failed)).out, /High risk\? .*failed, so it decided nothing/)
})

test('surfaces a failed step and its error', async () => {
  const failed = report({
    steps: [
      { nodeId: 'charge', label: 'Charge card', type: 'action-http', status: 'failed', error: 'HTTP 502' },
    ],
    summary: { ran: 0, skipped: 0, failed: 1, unreached: 0, decisions: 1, unexplained: 0 },
  })
  const { out } = await run(failed)
  assert.match(out, /Failed:.*Charge card/)
  assert.match(out, /HTTP 502/)
})

test('handles a run whose workflow has been deleted', async () => {
  const { code, out } = await run({ available: false, reason: 'workflow-gone' })
  assert.equal(code, 0)
  assert.match(out, /has been deleted/)
})

test('asks the endpoint for the right run', async () => {
  const { requests } = await run(report())
  assert.equal(requests[0].path, '/api/v1/executions/exec-1/explain')
})

test('without an execution id prints usage and fails', async () => {
  const ctx = makeCtx(null)
  assert.equal(await explain({ positionals: [], flags: {} }, ctx), 1)
  assert.match(ctx.output(), /Usage: flowforge explain/)
})
