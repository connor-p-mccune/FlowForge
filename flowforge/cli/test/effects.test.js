// flowforge effects — what a run can do, and what has to be true first.
//
// The exit code carries the product. `--ungated` is opt-in rather than a
// default because a workflow that reaches a payments API on every run is a
// legitimate thing to want — and is also exactly what a gate somebody routed
// around looks like. Which of those it is depends on the pipeline, not on this.

const test = require('node:test')
const assert = require('node:assert/strict')

const { startStub, makeCtx } = require('./helpers')
const effects = require('../src/commands/effects')

const GATED = {
  workflowId: 'wf-1',
  available: true,
  effects: [
    {
      nodeId: 'score', label: 'Fraud score', type: 'ai-classify', kind: 'model',
      target: 'gpt-4o-mini', always: true, conditions: [],
    },
    {
      nodeId: 'charge', label: 'Charge card', type: 'action-http', kind: 'http',
      target: 'api.acme.com', always: false,
      conditions: [
        { nodeId: 'risky', label: 'High risk?', type: 'condition', outcome: 'false' },
        { nodeId: 'approve', label: 'Approve', type: 'approval', outcome: 'true' },
      ],
    },
  ],
  decisions: [
    {
      nodeId: 'approve', label: 'Approve', type: 'approval',
      outcomes: [
        { name: 'true', gates: ['charge'] },
        { name: 'false', gates: [] },
      ],
    },
  ],
  summary: { total: 2, unconditional: 1, gated: 1, dynamicTargets: 0 },
}

async function run(payload, flags = {}) {
  const stub = await startStub(() => ({ json: payload }))
  const ctx = makeCtx(stub.api)
  const code = await effects({ positionals: ['wf-1'], flags }, ctx)
  await stub.close()
  return { code, out: ctx.output(), requests: stub.requests }
}

test('lists each effect with what it reaches and what gates it', async () => {
  const { code, out } = await run(GATED)
  assert.equal(code, 0)
  assert.match(out, /http\s+Charge card\s+api\.acme\.com/)
  assert.match(out, /High risk\? = false and Approve = true/)
})

test('marks an effect with no preconditions as happening always', async () => {
  const { out } = await run(GATED)
  assert.match(out, /model\s+Fraud score\s+gpt-4o-mini\s+always/)
})

test('reports what each decision rules out', async () => {
  const { out } = await run(GATED)
  assert.match(out, /What each decision rules out/)
  assert.match(out, /Approve ≠ true → Charge card cannot happen/)
})

test('summarises how many effects are gated and how many are not', async () => {
  const { out } = await run(GATED)
  assert.match(out, /2 effects · 1 gated · 1 on every run/)
})

test('names a destination the graph does not determine rather than guessing', async () => {
  const dynamic = {
    ...GATED,
    effects: [{ ...GATED.effects[0], target: null }],
    summary: { total: 1, unconditional: 1, gated: 0, dynamicTargets: 1 },
  }
  const { out } = await run(dynamic)
  assert.match(out, /dynamic/)
  assert.match(out, /1 whose destination the graph does not determine/)
})

test('exits 0 without --ungated even when something runs unconditionally', async () => {
  assert.equal((await run(GATED)).code, 0)
})

test('exits 1 with --ungated, naming the effects that have no gate', async () => {
  const { code, out } = await run(GATED, { ungated: true })
  assert.equal(code, 1)
  assert.match(out, /1 effect\(s\) run unconditionally: Fraud score/)
})

test('exits 0 with --ungated when every effect is behind a gate', async () => {
  const allGated = {
    ...GATED,
    effects: [GATED.effects[1]],
    summary: { total: 1, unconditional: 0, gated: 1, dynamicTargets: 0 },
  }
  assert.equal((await run(allGated, { ungated: true })).code, 0)
})

test('says so plainly when the workflow reaches nothing outside', async () => {
  const inert = {
    workflowId: 'wf-1', available: true, effects: [], decisions: [],
    summary: { total: 0, unconditional: 0, gated: 0, dynamicTargets: 0 },
  }
  const { code, out } = await run(inert, { ungated: true })
  assert.equal(code, 0)
  assert.match(out, /reaches nothing outside FlowForge/)
})

test('passes a cyclic graph, explaining that no run of it happens', async () => {
  const { code, out } = await run({ workflowId: 'wf-1', available: false, reason: 'cycle' })
  assert.equal(code, 0)
  assert.match(out, /no run of it happens at all/)
})

test('hits the effects endpoint for the right workflow', async () => {
  const { requests } = await run(GATED)
  assert.equal(requests[0].path, '/api/v1/workflows/wf-1/effects')
})

test('without a workflow id prints usage and fails', async () => {
  const ctx = makeCtx(null)
  const code = await effects({ positionals: [], flags: {} }, ctx)
  assert.equal(code, 1)
  assert.match(ctx.output(), /Usage: flowforge effects/)
})

// `--deep` follows sub-workflow calls. Without it a call is one line reading
// "calls workflow 4f2a", which is true and tells a reviewer nothing — the
// workflow they are reviewing can charge a card, three boxes and one call away.
const REACH = {
  available: true,
  workflowId: 'wf-1',
  effects: [
    {
      nodeId: 'notify', label: 'Notify sales', type: 'action-slack', kind: 'slack',
      target: 'hooks.slack.com', via: [], conditions: [], always: true,
      workflowId: 'wf-1', workflowName: 'Orders',
    },
    {
      nodeId: 'charge', label: 'Charge card', type: 'action-http', kind: 'http',
      target: 'api.acme.com', always: false,
      workflowId: 'wf-2', workflowName: 'Fulfilment',
      via: [{ workflowId: 'wf-2', name: 'Fulfilment', nodeId: 'call', label: 'Fulfil order' }],
      conditions: [
        { nodeId: 'approve', label: 'Approve order', type: 'approval', outcome: 'true', workflowName: 'Orders' },
        { nodeId: 'stock', label: 'In stock?', type: 'condition', outcome: 'true', workflowName: 'Fulfilment' },
      ],
    },
  ],
  unresolved: [],
  summary: { total: 2, direct: 1, inherited: 1, unconditional: 1, workflows: 1, deepest: 1 },
}

test('--deep asks the endpoint that follows calls', async () => {
  const { requests } = await run(REACH, { deep: true })
  assert.equal(requests[0].path, '/api/v1/workflows/wf-1/reach')
})

test('--deep names the workflow an inherited effect is reached through', async () => {
  // "Charge card" in a report about Orders is confusing until it says it is
  // reached through Fulfilment.
  const { out } = await run(REACH, { deep: true })
  assert.match(out, /Charge card via Fulfilment/)
})

test('--deep shows the conditions from both sides of the call', async () => {
  const { out } = await run(REACH, { deep: true })
  assert.match(out, /Approve order = true and In stock\? = true/)
})

test('--deep separates what this workflow does from what it inherits', async () => {
  const { out } = await run(REACH, { deep: true })
  assert.match(out, /2 effects · 1 in this workflow · 1 reached through 1 other workflow\(s\)/)
})

test('--deep says where the walk stopped', async () => {
  const { out } = await run(
    {
      ...REACH,
      unresolved: [{ workflowId: 'wf-9', reason: 'not-visible', chain: [] }],
    },
    { deep: true }
  )
  assert.match(out, /Not followed \(not-visible\): wf-9 — this token cannot see it/)
})

test('without --deep, a sub-workflow effect suggests it', async () => {
  const withCall = {
    ...GATED,
    effects: [
      {
        nodeId: 'call', label: 'Fulfil order', type: 'sub-workflow', kind: 'sub-workflow',
        target: 'wf-2', always: true, conditions: [],
      },
    ],
    summary: { total: 1, unconditional: 1, gated: 0, dynamicTargets: 0 },
  }
  const { out } = await run(withCall)
  assert.match(out, /--deep expands it/)
})

test('without --deep it still asks the per-graph endpoint', async () => {
  const { requests } = await run(GATED)
  assert.equal(requests[0].path, '/api/v1/workflows/wf-1/effects')
})

test('--deep survives a report with no decisions section', async () => {
  // The inverse view is per-graph only, and the reach report carries none.
  const { code } = await run(REACH, { deep: true })
  assert.equal(code, 0)
})
