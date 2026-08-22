// flowforge drift — output drift as a CI gate.
//
// The exit code carries the product, and the case that matters most is the
// negative one: a workflow too young to compare must not fail the build. A
// check that fails every new workflow is a check somebody deletes.

const test = require('node:test')
const assert = require('node:assert/strict')

const { startStub, makeCtx } = require('./helpers')
const drift = require('../src/commands/drift')

const DRIFTED = {
  workflowId: 'wf-1',
  available: true,
  monitoring: true,
  window: {
    recent: { runs: 50, from: '2026-03-01', to: '2026-03-02' },
    baseline: { runs: 200, from: '2026-02-01', to: '2026-03-01' },
  },
  summary: { major: 2, minor: 1, nodesCompared: 2, nodesSkipped: 0, fieldsCompared: 14, fieldsSkipped: 3 },
  nodes: [
    {
      nodeId: 'fetch',
      nodeLabel: 'Fetch orders',
      nodeType: 'action-http',
      compared: 9,
      skipped: [{ path: 'orderId', reason: 'identifier-like' }],
      findings: [
        {
          nodeId: 'fetch',
          nodeLabel: 'Fetch orders',
          path: 'customer.email',
          kind: 'null-rate',
          severity: 'major',
          summary: 'customer.email is null in 41.0% of records, was 0.2%',
          detail: { baselineRate: 0.002, recentRate: 0.41, pValue: 1.2e-14, test: 'two-proportion' },
        },
        {
          nodeId: 'fetch',
          nodeLabel: 'Fetch orders',
          path: 'total',
          kind: 'distribution',
          severity: 'major',
          summary: "total's value distribution moved (D=0.62)",
          detail: { d: 0.62, pValue: 3.1e-9, n1: 200, n2: 800, test: 'kolmogorov-smirnov' },
        },
      ],
    },
    {
      nodeId: 'score',
      nodeLabel: 'Risk score',
      nodeType: 'ai-classify',
      compared: 5,
      skipped: [],
      findings: [
        {
          nodeId: 'score',
          nodeLabel: 'Risk score',
          path: 'label',
          kind: 'categories',
          severity: 'minor',
          summary: 'label\'s value mix shifted (PSI 0.14) — "high_risk" 2.0% → 9.0%',
          detail: { psi: 0.14, contributions: [], test: 'population-stability-index' },
        },
      ],
    },
  ],
}

const CLEAN = {
  ...DRIFTED,
  summary: { major: 0, minor: 0, nodesCompared: 2, nodesSkipped: 0, fieldsCompared: 14, fieldsSkipped: 0 },
  nodes: DRIFTED.nodes.map((n) => ({ ...n, findings: [] })),
}

async function run(payload, flags = {}) {
  const stub = await startStub(() => ({ json: payload }))
  const ctx = makeCtx(stub.api)
  const code = await drift({ positionals: ['wf-1'], flags }, ctx)
  await stub.close()
  return { code, out: ctx.output(), requests: stub.requests }
}

test('reports each finding under the node that produced it', async () => {
  const { code, out } = await run(DRIFTED)
  assert.equal(code, 0)
  assert.match(out, /Fetch orders/)
  assert.match(out, /Risk score/)
  assert.match(out, /customer\.email is null in 41\.0% of records/)
  assert.match(out, /high_risk/)
})

test('names the window it compared', async () => {
  const { out } = await run(DRIFTED)
  assert.match(out, /last 50 runs vs the 200 before them/)
})

test('shows the evidence behind each finding', async () => {
  const { out } = await run(DRIFTED)
  assert.match(out, /D=0\.62/)
  assert.match(out, /PSI=0\.14/)
  assert.match(out, /p=1\.2e-14/)
})

test('reports coverage, including what it could not compare', async () => {
  const { out } = await run(DRIFTED)
  assert.match(out, /14 fields compared across 2 nodes/)
  assert.match(out, /3 skipped/)
})

test('exits 0 without --strict even when something drifted', async () => {
  // Most changes in data are expected; failing on every one is how the check
  // gets disabled.
  assert.equal((await run(DRIFTED)).code, 0)
})

test('exits 1 with --strict on a major finding', async () => {
  const { code, out } = await run(DRIFTED, { strict: true })
  assert.equal(code, 1)
  assert.match(out, /2 major changes/)
})

test('exits 0 with --strict when only minor findings exist', async () => {
  const minorOnly = {
    ...DRIFTED,
    summary: { ...DRIFTED.summary, major: 0, minor: 1 },
    nodes: [DRIFTED.nodes[1]],
  }
  assert.equal((await run(minorOnly, { strict: true })).code, 0)
})

test('says so plainly when nothing changed', async () => {
  const { code, out } = await run(CLEAN, { strict: true })
  assert.equal(code, 0)
  assert.match(out, /No change detected/)
})

test('passes a workflow too young to compare, and says why', async () => {
  const young = { workflowId: 'wf-1', available: false, reason: 'insufficient-history', needed: 30, have: 8 }
  const { code, out } = await run(young, { strict: true })
  assert.equal(code, 0)
  assert.match(out, /8 completed runs, 30 needed/)
})

test('passes the window overrides through to the API', async () => {
  const { requests } = await run(DRIFTED, { recent: '20', baseline: '60' })
  assert.match(requests[0].path, /drift\?recent=20&baseline=60$/)
})

test('without a workflow id prints usage and fails', async () => {
  const ctx = makeCtx(null)
  const code = await drift({ positionals: [], flags: {} }, ctx)
  assert.equal(code, 1)
  assert.match(ctx.output(), /Usage: flowforge drift/)
})
