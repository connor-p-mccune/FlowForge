// flowforge contention — work versus waiting for a slot, and the CI gate.
//
// The exit code is the product here: a pipeline that asserts a duration cannot
// tell "the work got slower" from "the box was busy", and --max is what lets it.

const test = require('node:test')
const assert = require('node:assert/strict')

const { startStub, makeCtx } = require('./helpers')
const contention = require('../src/commands/contention')
const forecast = require('../src/commands/forecast')

// A run of four 2s nodes at a cap of two: two waves, so half its wall time was
// two nodes sitting ready with nowhere to run.
const QUEUED_RUN = {
  executionId: 'ex-1',
  available: true,
  cap: 2,
  observed: {
    makespanMs: 4000,
    workMs: 8000,
    queuedMs: 4000,
    utilisation: 1,
    chain: [
      { nodeId: 'a', waitedFor: null, queuedMs: 0, durationMs: 2000 },
      { nodeId: 'c', waitedFor: 'slot', blockedBy: 'a', queuedMs: 2000, durationMs: 2000 },
    ],
  },
  idealMakespanMs: 2000,
  atCap: [
    { cap: 1, makespanMs: 8000 },
    { cap: 2, makespanMs: 4000 },
    { cap: 4, makespanMs: 2000 },
  ],
  perNode: {
    a: { startMs: 0, finishMs: 2000, queuedMs: 0, durationMs: 2000, occupiedSlot: true, cause: null },
    b: { startMs: 0, finishMs: 2000, queuedMs: 0, durationMs: 2000, occupiedSlot: true, cause: null },
    c: {
      startMs: 2000, finishMs: 4000, queuedMs: 2000, durationMs: 2000,
      occupiedSlot: true, cause: { nodeId: 'a', kind: 'slot' },
    },
    d: {
      startMs: 2000, finishMs: 4000, queuedMs: 2000, durationMs: 2000,
      occupiedSlot: true, cause: { nodeId: 'b', kind: 'slot' },
    },
  },
}

const CLEAN_RUN = {
  executionId: 'ex-2',
  available: true,
  cap: 8,
  observed: { makespanMs: 2000, workMs: 8000, queuedMs: 0, utilisation: 0.5, chain: [] },
  idealMakespanMs: 2000,
  atCap: [{ cap: 1, makespanMs: 8000 }, { cap: 4, makespanMs: 2000 }],
  perNode: {},
}

async function run(command, payload, args = { positionals: ['ex-1'], flags: {} }) {
  const stub = await startStub(() => ({ json: payload }))
  const ctx = makeCtx(stub.api)
  const code = await command(args, ctx)
  await stub.close()
  return { code, out: ctx.output(), requests: stub.requests }
}

test('contention reports the split between work and waiting', async () => {
  const { code, out } = await run(contention, QUEUED_RUN)
  assert.equal(code, 0)
  assert.match(out, /Wall time\s+4\.0s/)
  assert.match(out, /Work\s+8\.0s/)
  assert.match(out, /Queued\s+4\.0s/)
  assert.match(out, /100% of wall time/)
})

test('contention names the floor the cap kept the run from', async () => {
  const { out } = await run(contention, QUEUED_RUN)
  assert.match(out, /Floor\s+2\.0s/)
  assert.match(out, /2\.00× that/)
})

test('contention lists every node that waited on capacity, worst first', async () => {
  const { out } = await run(contention, QUEUED_RUN)
  assert.match(out, /Waited for a slot/)
  assert.match(out, /\bc\b/)
  assert.match(out, /\bd\b/)
  // A node that never waited is not in the list.
  const section = out.slice(out.indexOf('Waited for a slot'))
  assert.ok(!/^a\s/m.test(section))
})

test('contention shows what other caps would have produced', async () => {
  const { out } = await run(contention, QUEUED_RUN)
  assert.match(out, /At other caps/)
  assert.match(out, /8\.0s/)
})

test('contention exits non-zero over the --max budget', async () => {
  const { code, out } = await run(contention, QUEUED_RUN, {
    positionals: ['ex-1'],
    flags: { max: '1.5' },
  })
  assert.equal(code, 1)
  assert.match(out, /exceeds the 1\.5× budget/)
})

test('contention passes a run inside its budget', async () => {
  const { code } = await run(contention, QUEUED_RUN, {
    positionals: ['ex-1'],
    flags: { max: '3' },
  })
  assert.equal(code, 0)
})

test('contention passes a run with no queueing at all', async () => {
  const { code, out } = await run(contention, CLEAN_RUN, {
    positionals: ['ex-2'],
    flags: { max: '1.1' },
  })
  assert.equal(code, 0)
  assert.ok(!/Waited for a slot/.test(out))
})

test('contention handles a run with nothing recorded', async () => {
  const { code, out } = await run(contention, { executionId: 'ex-3', available: false }, {
    positionals: ['ex-3'],
    flags: {},
  })
  assert.equal(code, 0)
  assert.match(out, /recorded no steps/)
})

test('contention without an execution id prints usage and fails', async () => {
  const ctx = makeCtx(null)
  const code = await contention({ positionals: [], flags: {} }, ctx)
  assert.equal(code, 1)
  assert.match(ctx.output(), /Usage: flowforge contention/)
})

// ---------------------------------------------------------------------------

const FORECAST = {
  workflowId: 'wf-1',
  available: true,
  criticalPath: ['t', 'a'],
  estimatedMs: 2000,
  estimatedP95Ms: 3000,
  bottleneck: { nodeId: 'a', nodeType: 'action-http', p50: 2000, p95: 3000 },
  coverage: { nodesWithHistory: 4, workNodes: 4, ratio: 1 },
  concurrency: {
    cap: 2,
    makespanMs: 4000,
    makespanP95Ms: 6000,
    queuedMs: 4000,
    contention: 2,
    averageParallelism: 4,
    knee: { cap: 4, makespanMs: 2000, idealMakespanMs: 2000 },
    curve: [{ cap: 1, makespanMs: 8000 }, { cap: 4, makespanMs: 2000 }],
    chain: [{ nodeId: 'c', waitedFor: 'slot', queuedMs: 2000, durationMs: 2000 }],
  },
}

test('forecast reports both the critical path and the makespan under the cap', async () => {
  const { code, out } = await run(forecast, FORECAST, { positionals: ['wf-1'], flags: {} })
  assert.equal(code, 0)
  assert.match(out, /Critical path\s+2\.0s typical/)
  assert.match(out, /Under the parallelism cap/)
  assert.match(out, /Makespan\s+4\.0s\s+2\.00× the critical path/)
  assert.match(out, /Knee\s+4 slots/)
  assert.match(out, /Worst wait\s+c/)
})

test('forecast passes --cap through to the API', async () => {
  const { requests } = await run(forecast, FORECAST, { positionals: ['wf-1'], flags: { cap: '6' } })
  assert.match(requests[0].path, /forecast\?cap=6$/)
})

test('forecast says nothing about concurrency when the server sent none', async () => {
  const bare = { ...FORECAST }
  delete bare.concurrency
  const { out } = await run(forecast, bare, { positionals: ['wf-1'], flags: {} })
  assert.ok(!/Under the parallelism cap/.test(out))
})
