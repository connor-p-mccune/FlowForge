// flowforge regressions — the release gate that names the deploy.
//
// The exit code carries the product: a change *for the worse* fails, an
// improvement does not, and a workflow too young to analyse does not either.
// The last one is the least obvious and the most important — a check that fails
// every new workflow's build is a check somebody removes.

const test = require('node:test')
const assert = require('node:assert/strict')

const { startStub, makeCtx } = require('./helpers')
const regressions = require('../src/commands/regressions')

const CHANGE = {
  at: '2026-01-12T09:00:00.000Z',
  previousAt: '2026-01-12T08:00:00.000Z',
  direction: 'worse',
  pValue: 0.0004,
  before: { median: 210, runs: 40 },
  after: { median: 970, runs: 44 },
  delta: 760,
  ratio: 4.62,
  cause: 'deploy',
  deploys: [
    {
      versionId: 'v-7',
      version: 7,
      createdAt: '2026-01-12T08:20:00.000Z',
      createdBy: 'Ada',
      changed: {
        changedNodes: [{ nodeId: 'fetch', label: 'Fetch orders', changes: ['config.url'] }],
        addedNodes: [],
        removedNodes: [],
        rewiredEdges: 0,
        identical: false,
      },
    },
  ],
  steps: [{ nodeId: 'fetch', nodeType: 'action-http', before: 90, after: 850, delta: 760 }],
}

const REGRESSED = {
  workflowId: 'wf-1',
  ok: false,
  analysed: true,
  runs: 84,
  changePoints: [CHANGE],
}

async function run(payload, flags = {}) {
  const stub = await startStub(() => ({ json: payload }))
  const ctx = makeCtx(stub.api)
  const code = await regressions({ positionals: ['wf-1'], flags }, ctx)
  await stub.close()
  return { code, out: ctx.output(), requests: stub.requests }
}

test('usage without a workflow id', async () => {
  const ctx = makeCtx(null)
  assert.equal(await regressions({ positionals: [], flags: {} }, ctx), 1)
  assert.match(ctx.output(), /Usage: flowforge regressions/)
})

test('a regression fails the build and names the deploy that caused it', async () => {
  const { code, out } = await run(REGRESSED)
  assert.equal(code, 1)
  assert.match(out, /210ms → 970ms/)
  assert.match(out, /4\.6× slower/)
  assert.match(out, /version 7/)
  assert.match(out, /changed Fetch orders: config\.url/)
  assert.match(out, /step fetch: 90ms → 850ms/)
})

test('a change nothing was deployed for says so', async () => {
  const { code, out } = await run({
    ...REGRESSED,
    changePoints: [{ ...CHANGE, cause: 'external', deploys: [] }],
  })
  assert.equal(code, 1)
  assert.match(out, /nothing was deployed in this window/)
})

test('several deploys in the window are listed rather than blamed', async () => {
  const { out } = await run({
    ...REGRESSED,
    changePoints: [
      {
        ...CHANGE,
        cause: 'ambiguous',
        deploys: [
          { version: 6, createdAt: 'x', createdBy: null, changed: null },
          { version: 7, createdAt: 'y', createdBy: null, changed: null },
        ],
      },
    ],
  })
  assert.match(out, /version 6/)
  assert.match(out, /version 7/)
  assert.match(out, /more than one deploy/)
})

test('an improvement is reported and passes', async () => {
  const { code, out } = await run({
    ...REGRESSED,
    ok: true,
    changePoints: [
      { ...CHANGE, direction: 'better', before: { median: 970, runs: 40 }, after: { median: 210, runs: 44 }, delta: -760, ratio: 0.22 },
    ],
  })
  assert.equal(code, 0)
  assert.match(out, /faster/)
})

test('a steady workflow says so', async () => {
  const { code, out } = await run({ workflowId: 'wf-1', ok: true, analysed: true, runs: 120, changePoints: [] })
  assert.equal(code, 0)
  assert.match(out, /No change in duration across the last 120 runs/)
})

test('a workflow too young to analyse passes', async () => {
  const { code, out } = await run({ ok: true, analysed: false, reason: 'not-enough-runs', runs: 4, changePoints: [] })
  assert.equal(code, 0)
  assert.match(out, /Not enough completed runs/)
})

test('--limit is passed through and --json keeps the exit code', async () => {
  const { requests } = await run(REGRESSED, { limit: '50' })
  assert.equal(requests[0].path, '/api/v1/workflows/wf-1/regressions?limit=50')

  const { code, out } = await run(REGRESSED, { json: true })
  assert.equal(code, 1)
  assert.equal(JSON.parse(out).workflowId, 'wf-1')
})

test('a duration over a second reads in seconds', async () => {
  const { out } = await run({
    ...REGRESSED,
    changePoints: [{ ...CHANGE, before: { median: 1200, runs: 40 }, after: { median: 9400, runs: 44 } }],
  })
  assert.match(out, /1\.2s → 9\.4s/)
})
